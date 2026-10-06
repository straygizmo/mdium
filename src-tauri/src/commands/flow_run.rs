// src-tauri/src/commands/flow_run.rs
//! Tauri commands and events of flow runs (spec 4–6; PR 3a). The engine
//! is process-wide state; every command validates `projectRoot`. The UI
//! that calls these is gated behind the `experimentalFlows` setting, but
//! the setting lives in the frontend: what actually gates execution is the
//! backend's per-machine command confirmation (spec 7.2).

use super::flow::{blocking, project_root, FlowCommandError};
use crate::flow::run::driver::{ApprovalNotifier, DriverEnv, EventSink};
use crate::flow::run::engine::{CommandReview, FlowEngine, RunSnapshot, RunSummary};
use crate::flow::run::model::{
    ApprovalRequest, NodeState, NodeStatus, Progress, Reason, RunState, RunStatus,
};
use crate::flow::run::process::{AttachedLauncher, Launcher};
use crate::flow::run::supervise::DetachedLauncher;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// The process-wide engine, managed as Tauri state.
pub type FlowEngineState = Arc<FlowEngine>;

pub const RUN_CHANGED_EVENT: &str = "flow://run-changed";
pub const NODE_CHANGED_EVENT: &str = "flow://node-changed";
pub const PROGRESS_EVENT: &str = "flow://progress";
pub const APPROVAL_REQUESTED_EVENT: &str = "flow://approval-requested";

/// How long app exit waits for drivers to record `interrupted`.
pub const SHUTDOWN_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunChangedPayload {
    project_root: String,
    run_id: String,
    status: RunStatus,
    seq: u64,
    cost_usd: f64,
    pending_approvals: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeChangedPayload {
    project_root: String,
    run_id: String,
    node_key: String,
    status: NodeStatus,
    attempt: u32,
    cost_usd: f64,
    seq: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    project_root: String,
    run_id: String,
    node_key: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fraction: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequestedPayload {
    project_root: String,
    run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    reason: Reason,
}

fn root_string(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

struct TauriSink {
    app: AppHandle,
}

impl TauriSink {
    fn emit<P: Serialize + Clone>(&self, event: &str, payload: P) {
        if let Err(err) = self.app.emit(event, payload) {
            eprintln!("[flow] emitting {event} failed: {err}");
        }
    }
}

impl EventSink for TauriSink {
    fn run_changed(&self, project_root: &Path, run_id: &str, state: &RunState) {
        self.emit(
            RUN_CHANGED_EVENT,
            RunChangedPayload {
                project_root: root_string(project_root),
                run_id: run_id.to_string(),
                status: state.status,
                seq: state.seq,
                cost_usd: state.cost.total(),
                pending_approvals: state.approvals.len(),
            },
        );
    }

    fn node_changed(
        &self,
        project_root: &Path,
        run_id: &str,
        node_key: &str,
        node: &NodeState,
        seq: u64,
    ) {
        self.emit(
            NODE_CHANGED_EVENT,
            NodeChangedPayload {
                project_root: root_string(project_root),
                run_id: run_id.to_string(),
                node_key: node_key.to_string(),
                status: node.status,
                attempt: node.attempt,
                cost_usd: node.cost.total(),
                seq,
            },
        );
    }

    fn progress(&self, project_root: &Path, run_id: &str, node_key: &str, progress: &Progress) {
        self.emit(
            PROGRESS_EVENT,
            ProgressPayload {
                project_root: root_string(project_root),
                run_id: run_id.to_string(),
                node_key: node_key.to_string(),
                text: progress.text.clone(),
                fraction: progress.fraction,
            },
        );
    }
}

/// The in-app approval notification (spec 6.5): an event the UI shows.
/// Other channels (mail, chat) can be added as further notifiers later.
struct InAppNotifier {
    app: AppHandle,
}

impl ApprovalNotifier for InAppNotifier {
    fn approval_requested(&self, project_root: &Path, run_id: &str, request: &ApprovalRequest) {
        let payload = ApprovalRequestedPayload {
            project_root: root_string(project_root),
            run_id: run_id.to_string(),
            node_key: request.node_key.clone(),
            message: request.message.clone(),
            reason: request.reason.clone(),
        };
        // Emitting never blocks the driver; a failure is only logged.
        if let Err(err) = self.app.emit(APPROVAL_REQUESTED_EVENT, payload) {
            eprintln!("[flow] approval notification failed: {err}");
        }
    }
}

/// Creates the engine (called once in `setup`).
pub fn create_state(app: &AppHandle) -> FlowEngineState {
    let base = dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("mdium");
    let env = DriverEnv {
        launcher: Arc::new(AttachedLauncher),
        // `detach: true` commands run under the supervisor mode of this executable.
        detached: match DetachedLauncher::for_current_exe() {
            Ok(launcher) => Some(Arc::new(launcher) as Arc<dyn Launcher>),
            Err(err) => {
                eprintln!("[flow] detached commands unavailable: {err}");
                None
            }
        },
        sink: Arc::new(TauriSink { app: app.clone() }),
        notifiers: Arc::new(vec![
            Arc::new(InAppNotifier { app: app.clone() }) as Arc<dyn ApprovalNotifier>
        ]),
        process_env: Arc::new(std::env::vars().collect()),
        poll: Duration::from_millis(200),
    };
    Arc::new(FlowEngine::new(
        env,
        base.join("flow-command-confirmations.json"),
    ))
}

async fn with_engine<T, F>(
    state: tauri::State<'_, FlowEngineState>,
    root: String,
    op: F,
) -> Result<T, FlowCommandError>
where
    T: Send + 'static,
    F: FnOnce(&FlowEngine, &Path) -> Result<T, FlowCommandError> + Send + 'static,
{
    let engine = state.inner().clone();
    blocking(move || {
        let root = project_root(&root)?;
        op(&engine, &root)
    })
    .await
}

/// The commands a flow file runs, for the one-time confirmation (spec 7.2).
#[tauri::command]
pub async fn flow_command_review(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    path: String,
) -> Result<CommandReview, FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.review_commands(root, &path)?)
    })
    .await
}

/// Records the user's confirmation of the reviewed content (by hash).
#[tauri::command]
pub async fn flow_confirm_commands(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    path: String,
    sha256: String,
) -> Result<(), FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.confirm_commands(root, &path, &sha256)?)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_start(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    path: String,
    params: BTreeMap<String, Value>,
    sha256: String,
) -> Result<RunSummary, FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.start(root, &path, &params, &sha256)?)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_list(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
) -> Result<Vec<RunSummary>, FlowCommandError> {
    with_engine(state, project_root, move |e, root| Ok(e.list(root)?)).await
}

#[tauri::command]
pub async fn flow_run_get(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    run_id: String,
) -> Result<RunSnapshot, FlowCommandError> {
    with_engine(
        state,
        project_root,
        move |e, root| Ok(e.get(root, &run_id)?),
    )
    .await
}

#[tauri::command]
pub async fn flow_run_stop(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.stop(root, &run_id)?)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_resume(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.resume(root, &run_id)?)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_cancel(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.cancel(root, &run_id)?)
    })
    .await
}

/// Answers an approval; `nodeKey` null answers the budget approval.
#[tauri::command]
pub async fn flow_run_approve(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    run_id: String,
    node_key: Option<String>,
    choice: String,
    comment: Option<String>,
) -> Result<(), FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.approve(root, &run_id, node_key.as_deref(), &choice, comment)?)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_rerun_node(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    run_id: String,
    node_key: String,
) -> Result<(), FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.rerun_node(root, &run_id, &node_key)?)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_mark_succeeded(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    run_id: String,
    node_key: String,
) -> Result<(), FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.mark_succeeded(root, &run_id, &node_key)?)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_delete(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.delete(root, &run_id)?)
    })
    .await
}

/// Tail of a node attempt's `stdout` / `stderr` log (at most 256 KiB).
#[tauri::command]
pub async fn flow_run_log(
    state: tauri::State<'_, FlowEngineState>,
    project_root: String,
    run_id: String,
    node_key: String,
    attempt: u32,
    stream: String,
    max_bytes: u64,
) -> Result<String, FlowCommandError> {
    with_engine(state, project_root, move |e, root| {
        Ok(e.log(root, &run_id, &node_key, attempt, &stream, max_bytes)?)
    })
    .await
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreStatus {
    /// `.mdium/flow-runs/` is ignored by git (or the folder is not a git repository).
    pub ignored: bool,
}

/// Whether git ignores `.mdium/flow-runs/` in `root` (the UI suggests
/// adding it otherwise; nothing is written automatically).
fn flow_runs_ignored(root: &Path) -> bool {
    let mut command = std::process::Command::new("git");
    command
        .args(["check-ignore", "-q", ".mdium/flow-runs/probe"])
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match command.status() {
        Ok(status) => status.code() != Some(1),
        // No git: nothing to suggest.
        Err(_) => true,
    }
}

#[tauri::command]
pub async fn flow_gitignore_status(
    project_root: String,
) -> Result<GitignoreStatus, FlowCommandError> {
    blocking(move || {
        let root = super::flow::project_root(&project_root)?;
        Ok(GitignoreStatus {
            ignored: flow_runs_ignored(&root),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::run::engine::{EngineError, FLOW_RUN_INVALID_ID};

    #[test]
    fn detects_whether_flow_runs_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        // Not a repository: nothing to suggest.
        assert!(flow_runs_ignored(tmp.path()));
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(tmp.path())
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        assert!(!flow_runs_ignored(tmp.path()));
        std::fs::write(tmp.path().join(".gitignore"), ".mdium/flow-runs/\n").unwrap();
        assert!(flow_runs_ignored(tmp.path()));
    }

    #[test]
    fn engine_errors_keep_code_and_details() {
        let err = FlowCommandError::from(EngineError {
            code: FLOW_RUN_INVALID_ID.into(),
            message: "x".into(),
            details: vec![Reason::new("D")],
        });
        assert_eq!(err.code, FLOW_RUN_INVALID_ID);
        assert_eq!(err.details.len(), 1);
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["details"][0]["code"], "D");
        let plain = serde_json::to_value(FlowCommandError::new("C", "m")).unwrap();
        assert!(plain.get("details").is_none());
    }

    #[test]
    fn payloads_are_camel_case() {
        let payload = NodeChangedPayload {
            project_root: "r".into(),
            run_id: "id".into(),
            node_key: "a".into(),
            status: NodeStatus::Running,
            attempt: 1,
            cost_usd: 0.0,
            seq: 3,
        };
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["nodeKey"], "a");
        assert_eq!(json["status"], "running");
        assert_eq!(json["costUsd"], 0.0);
    }
}

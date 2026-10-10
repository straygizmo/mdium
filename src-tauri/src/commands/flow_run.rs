// src-tauri/src/commands/flow_run.rs
//! Tauri commands and events of flow runs (spec 4–6; PR 3a). The flow
//! service is process-wide state and validates `projectRoot`. The UI
//! that calls these is gated behind the `experimentalFlows` setting, but
//! the setting lives in the frontend: what actually gates execution is the
//! backend's per-machine command confirmation (spec 7.2).

use super::flow::{with_service, FlowCommandError, FlowServiceState};
use flow_core::run::driver::{ApprovalNotifier, DriverEnv, EventSink};
use flow_core::run::engine::{CommandReview, FlowEngine, RunSnapshot, RunSummary};
use flow_core::run::model::{
    ApprovalRequest, NodeState, NodeStatus, Progress, Reason, RunState, RunStatus,
};
use flow_core::run::process::{AttachedLauncher, Launcher};
use flow_core::run::supervise::DetachedLauncher;
use flow_core::service::{FlowService, GitignoreStatus};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

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

/// Creates the engine and its service (called once in `setup`).
pub fn create_state(app: &AppHandle) -> FlowServiceState {
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
    let engine = Arc::new(FlowEngine::new(
        env,
        base.join("flow-command-confirmations.json"),
    ));
    Arc::new(FlowService::new(engine))
}

#[tauri::command]
pub async fn flow_command_review(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    path: String,
) -> Result<CommandReview, FlowCommandError> {
    with_service(state, move |s| s.command_review(&project_root, &path)).await
}

#[tauri::command]
pub async fn flow_confirm_commands(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    path: String,
    sha256: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| {
        s.confirm_commands(&project_root, &path, &sha256)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_start(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    path: String,
    params: BTreeMap<String, Value>,
    sha256: String,
) -> Result<RunSummary, FlowCommandError> {
    with_service(state, move |s| {
        s.run_start(&project_root, &path, &params, &sha256)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_list(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
) -> Result<Vec<RunSummary>, FlowCommandError> {
    with_service(state, move |s| s.run_list(&project_root)).await
}

#[tauri::command]
pub async fn flow_run_get(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
) -> Result<RunSnapshot, FlowCommandError> {
    with_service(state, move |s| s.run_get(&project_root, &run_id)).await
}

#[tauri::command]
pub async fn flow_run_stop(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.run_stop(&project_root, &run_id)).await
}

#[tauri::command]
pub async fn flow_run_resume(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.run_resume(&project_root, &run_id)).await
}

#[tauri::command]
pub async fn flow_run_cancel(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.run_cancel(&project_root, &run_id)).await
}

/// Answers an approval; `nodeKey` null answers the budget approval.
#[tauri::command]
pub async fn flow_run_approve(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
    node_key: Option<String>,
    choice: String,
    comment: Option<String>,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| {
        s.run_approve(
            &project_root,
            &run_id,
            node_key.as_deref(),
            &choice,
            comment,
        )
    })
    .await
}

#[tauri::command]
pub async fn flow_run_rerun_node(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
    node_key: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| {
        s.run_rerun_node(&project_root, &run_id, &node_key)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_mark_succeeded(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
    node_key: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| {
        s.run_mark_succeeded(&project_root, &run_id, &node_key)
    })
    .await
}

#[tauri::command]
pub async fn flow_run_delete(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
) -> Result<(), FlowCommandError> {
    with_service(state, move |s| s.run_delete(&project_root, &run_id)).await
}

/// Tail of a node attempt's `stdout` / `stderr` log (at most 256 KiB).
#[tauri::command]
pub async fn flow_run_log(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    run_id: String,
    node_key: String,
    attempt: u32,
    stream: String,
    max_bytes: u64,
) -> Result<String, FlowCommandError> {
    with_service(state, move |s| {
        s.run_log(
            &project_root,
            &run_id,
            &node_key,
            attempt,
            &stream,
            max_bytes,
        )
    })
    .await
}

#[tauri::command]
pub async fn flow_gitignore_status(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
) -> Result<GitignoreStatus, FlowCommandError> {
    with_service(state, move |s| s.gitignore_status(&project_root)).await
}

#[cfg(test)]
mod tests {
    use super::*;

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

    const LIB_RS: &str = include_str!("../lib.rs");

    /// The flow handlers are read from `generate_handler!` in `lib.rs`, so the
    /// test pins the registered Tauri commands to the service's dispatch table
    /// and HTTP and Tauri never drift.
    #[test]
    fn tauri_commands_match_the_service_dispatch_table() {
        let re = regex::Regex::new(r"commands::flow(?:_run)?::(flow_\w+)").unwrap();
        let mut tauri: Vec<&str> = re
            .captures_iter(LIB_RS)
            .map(|c| c.get(1).unwrap().as_str())
            .collect();
        tauri.sort();
        tauri.dedup();
        let mut service: Vec<&str> = flow_core::service::COMMAND_NAMES.to_vec();
        service.sort();
        assert_eq!(tauri, service);
    }
}

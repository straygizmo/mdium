// src-tauri/src/commands/workflow.rs
//! Tauri commands and events of the workflow orchestrator.
//!
//! There is exactly one [`Orchestrator`] per process ([`WorkflowState`]),
//! created in `setup` by [`create_state`] and shut down on
//! `RunEvent::Exit`. Every project-scoped command validates the root and
//! attaches the project before running; the first attach also kicks its
//! dispatcher (attaching alone never starts queued work, and user
//! operations kick by themselves). The work runs on a blocking thread.
//!
//! Events carry the orchestrator's normalized project root
//! (`projectRoot`), which is the value [`workflow_attach_project`]
//! returns; the UI must compare roots after normalization.

use super::node_sidecar;
use crate::workflow::actions::{
    self, ActionError, MergePreview, NewTask, RetryOptions, TaskDetail,
};
use crate::workflow::attempt::ProgressUpdate;
use crate::workflow::gitops;
use crate::workflow::model::{
    Provider, RunStatus, Task, TaskStatus, Workflow, WorkflowRun, WorkflowsFile,
};
use crate::workflow::orchestrator::{EventSink, Orchestrator};
use crate::workflow::runner_client::{RunnerError, RunnerEvent, StartSessionParams};
use crate::workflow::runner_host::{RunnerApi, RunnerHost, SidecarSpawner};
use crate::workflow::store::{RunList, StoreError, TaskList, WorkflowList};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// The process-wide orchestrator, managed as Tauri state.
pub type WorkflowState = Arc<Orchestrator>;

/// Event names (payloads are camelCase).
pub const TASK_CHANGED_EVENT: &str = "workflow://task-changed";
pub const RUN_CHANGED_EVENT: &str = "workflow://run-changed";
pub const PROGRESS_EVENT: &str = "workflow://progress";

/// Code of every runner call when the bundled agent runner script is missing.
pub const AGENT_RUNNER_MISSING: &str = "AGENT_RUNNER_MISSING";
/// The project root is empty, not absolute, or not an existing directory.
pub const WORKFLOW_PROJECT_INVALID: &str = "WORKFLOW_PROJECT_INVALID";
/// Code of a command whose blocking task could not be joined.
pub const WORKFLOW_COMMAND_FAILED: &str = "WORKFLOW_COMMAND_FAILED";

/// A command failure as the UI receives it: `{ code, message }`. `message`
/// is a log detail, never user-facing text (the UI localizes by `code`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl From<ActionError> for CommandError {
    fn from(err: ActionError) -> Self {
        CommandError {
            code: err.code().to_string(),
            message: err.to_string(),
        }
    }
}

impl From<StoreError> for CommandError {
    fn from(err: StoreError) -> Self {
        ActionError::from(err).into()
    }
}

impl From<tauri::Error> for CommandError {
    fn from(err: tauri::Error) -> Self {
        CommandError {
            code: WORKFLOW_COMMAND_FAILED.to_string(),
            message: err.to_string(),
        }
    }
}

/// Payload of [`TASK_CHANGED_EVENT`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskChangedPayload {
    pub project_root: String,
    pub task_id: String,
    pub root_id: String,
    pub status: TaskStatus,
}

impl TaskChangedPayload {
    fn new(project_root: &Path, task: &Task) -> Self {
        TaskChangedPayload {
            project_root: root_string(project_root),
            task_id: task.meta.id.clone(),
            root_id: task.meta.root_id.clone(),
            status: task.meta.status,
        }
    }
}

/// Payload of [`RUN_CHANGED_EVENT`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunChangedPayload {
    pub project_root: String,
    pub root_task_id: String,
    pub status: RunStatus,
}

impl RunChangedPayload {
    fn new(project_root: &Path, run: &WorkflowRun) -> Self {
        RunChangedPayload {
            project_root: root_string(project_root),
            root_task_id: run.root_task_id.clone(),
            status: run.status,
        }
    }
}

/// Payload of [`PROGRESS_EVENT`]. Throttling and the text cap are applied
/// by the attempt loop.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub project_root: String,
    pub task_id: String,
    pub attempt_id: String,
    /// `"message"` or `"tool"`.
    pub kind: &'static str,
    pub text: String,
}

impl ProgressPayload {
    fn new(project_root: &Path, task_id: &str, attempt_id: &str, update: &ProgressUpdate) -> Self {
        ProgressPayload {
            project_root: root_string(project_root),
            task_id: task_id.to_string(),
            attempt_id: attempt_id.to_string(),
            kind: update.kind,
            text: update.text.clone(),
        }
    }
}

/// A project root as sent to the UI.
fn root_string(project_root: &Path) -> String {
    project_root.to_string_lossy().into_owned()
}

/// Emits orchestrator changes as Tauri events.
pub struct TauriSink {
    pub app: AppHandle,
}

impl TauriSink {
    fn emit<P: Serialize + Clone>(&self, event: &str, payload: P) {
        if let Err(err) = self.app.emit(event, payload) {
            eprintln!("[workflow] emitting {event} failed: {err}");
        }
    }
}

impl EventSink for TauriSink {
    fn task_changed(&self, project_root: &Path, task: &Task) {
        self.emit(
            TASK_CHANGED_EVENT,
            TaskChangedPayload::new(project_root, task),
        );
    }

    fn run_changed(&self, project_root: &Path, run: &WorkflowRun) {
        self.emit(RUN_CHANGED_EVENT, RunChangedPayload::new(project_root, run));
    }

    fn progress(
        &self,
        project_root: &Path,
        task_id: &str,
        attempt_id: &str,
        update: &ProgressUpdate,
    ) {
        self.emit(
            PROGRESS_EVENT,
            ProgressPayload::new(project_root, task_id, attempt_id, update),
        );
    }
}

/// Runner used when the bundled agent runner script cannot be found: every
/// call fails with [`AGENT_RUNNER_MISSING`], so attempts end in attention
/// while the app itself keeps working.
pub struct MissingRunner;

fn runner_missing() -> RunnerError {
    RunnerError::Unavailable(AGENT_RUNNER_MISSING)
}

impl RunnerApi for MissingRunner {
    fn start_session(
        &self,
        _params: StartSessionParams,
        _timeout: Duration,
    ) -> Result<(Receiver<RunnerEvent>, Option<String>), RunnerError> {
        Err(runner_missing())
    }

    fn send(&self, _session_id: &str, _text: &str) -> Result<(), RunnerError> {
        Err(runner_missing())
    }

    fn cancel(&self, _session_id: &str) -> Result<(), RunnerError> {
        Err(runner_missing())
    }

    fn respond_permission(
        &self,
        _session_id: &str,
        _permission_id: &str,
        _allow: bool,
    ) -> Result<(), RunnerError> {
        Err(runner_missing())
    }

    fn close_session(&self, _session_id: &str) -> Result<(), RunnerError> {
        Err(runner_missing())
    }

    fn probe(
        &self,
        _provider: Provider,
        _timeout: Duration,
    ) -> Result<serde_json::Value, RunnerError> {
        Err(runner_missing())
    }

    fn shutdown(&self) {}
}

/// Creates the process-wide orchestrator (called once, from `setup`).
pub fn create_state(app: &AppHandle) -> WorkflowState {
    let runner: Arc<dyn RunnerApi> =
        match node_sidecar::resolve_script(app, "agent-runner", "agent-runner.mjs") {
            Ok(script_path) => {
                let base = dirs::data_local_dir().unwrap_or_else(|| {
                    let temp = std::env::temp_dir();
                    eprintln!(
                        "[workflow] no local data dir; runner data goes to {}",
                        temp.display()
                    );
                    temp
                });
                let data_dir = base.join("mdium");
                Arc::new(RunnerHost::new(Box::new(SidecarSpawner {
                    script_path,
                    data_dir,
                })))
            }
            Err(err) => {
                eprintln!("[workflow] agent runner unavailable: {err}");
                Arc::new(MissingRunner)
            }
        };
    let sink = Arc::new(TauriSink { app: app.clone() });
    Orchestrator::new(runner, sink, gitops::default_worktree_base())
}

/// One provider's probe result (`{"kind":"error","detail":<code>}` when
/// the probe failed).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbePayload {
    pub provider: Provider,
    pub result: serde_json::Value,
}

/// Runs `op` on a blocking thread.
async fn blocking<T, F>(op: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(op).await?
}

/// Checks that `project_root` names an existing directory by an absolute
/// path.
fn validate_project_root(project_root: &str) -> Result<PathBuf, CommandError> {
    let invalid = |detail: &str| CommandError {
        code: WORKFLOW_PROJECT_INVALID.to_string(),
        message: format!("{WORKFLOW_PROJECT_INVALID}: {detail}"),
    };
    if project_root.trim().is_empty() {
        return Err(invalid("empty"));
    }
    let root = PathBuf::from(project_root);
    if !root.is_absolute() {
        return Err(invalid("not absolute"));
    }
    if !root.is_dir() {
        return Err(invalid("not a directory"));
    }
    Ok(root)
}

/// Validates `project_root`, attaches it (kicking its dispatcher only when
/// this call attached it: user operations kick by themselves, and reads
/// must stay cheap), and runs `op` with the orchestrator and the root on a
/// blocking thread.
async fn with_project<T, F>(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    op: F,
) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&Arc<Orchestrator>, &Path) -> Result<T, ActionError> + Send + 'static,
{
    let orch = state.inner().clone();
    blocking(move || {
        let root = validate_project_root(&project_root)?;
        if orch.attach(&root).1 {
            orch.kick(&root);
        }
        op(&orch, &root).map_err(CommandError::from)
    })
    .await
}

/// Attaches the project and returns its normalized root (the `projectRoot`
/// of every event of this project).
#[tauri::command]
pub async fn workflow_attach_project(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
) -> Result<String, CommandError> {
    with_project(state, project_root, |orch, root| {
        Ok(root_string(orch.store(root).project_root()))
    })
    .await
}

#[tauri::command]
pub async fn workflow_list_workflows(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
) -> Result<WorkflowList, CommandError> {
    with_project(state, project_root, |orch, root| {
        actions::list_workflows(orch, root)
    })
    .await
}

#[tauri::command]
pub async fn workflow_save_workflows(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    file: WorkflowsFile,
) -> Result<(), CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::save_workflows(orch, root, &file)
    })
    .await
}

#[tauri::command]
pub async fn workflow_add_standard(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    name: String,
    provider: Provider,
) -> Result<Workflow, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::add_standard_workflow(orch, root, &name, provider)
    })
    .await
}

#[tauri::command]
pub async fn workflow_active_run_count(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    workflow_id: String,
) -> Result<usize, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::active_run_count(orch, root, &workflow_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_list_tasks(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
) -> Result<TaskList, CommandError> {
    with_project(state, project_root, |orch, root| {
        Ok(orch.store(root).list_tasks()?)
    })
    .await
}

#[tauri::command]
pub async fn workflow_list_runs(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
) -> Result<RunList, CommandError> {
    with_project(state, project_root, |orch, root| {
        Ok(orch.store(root).list_runs()?)
    })
    .await
}

#[tauri::command]
pub async fn workflow_task_detail(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
) -> Result<TaskDetail, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::task_detail(orch, root, &task_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_create_task(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    title: String,
    body: String,
    workflow_id: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::create_task(
            orch,
            root,
            NewTask {
                title,
                body,
                workflow_id,
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn workflow_cancel_task(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::cancel_task(orch, root, &task_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_hold_task(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::hold_task(orch, root, &task_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_resume_task(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::resume_task(orch, root, &task_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_retry_task(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
    accept_screening: bool,
    accept_agent_config: bool,
    accept_integrity: bool,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::retry_task(
            orch,
            root,
            &task_id,
            RetryOptions {
                accept_screening,
                accept_agent_config,
                accept_integrity,
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn workflow_mark_complete(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::mark_complete(orch, root, &task_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_approve_plan(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::approve_plan(orch, root, &task_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_request_revision(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
    instruction: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::request_revision(orch, root, &task_id, &instruction)
    })
    .await
}

#[tauri::command]
pub async fn workflow_answer_question(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
    answer: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::answer_question(orch, root, &task_id, &answer)
    })
    .await
}

#[tauri::command]
pub async fn workflow_archive_task(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::archive_task(orch, root, &task_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_delete_task(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
) -> Result<(), CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::delete_task(orch, root, &task_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_merge_preview(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    root_task_id: String,
) -> Result<MergePreview, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::merge_preview(orch, root, &root_task_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_merge_run(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    root_task_id: String,
    acknowledged_paths: Vec<String>,
    acknowledge_integrity: bool,
) -> Result<WorkflowRun, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::merge_run(
            orch,
            root,
            &root_task_id,
            &acknowledged_paths,
            acknowledge_integrity,
        )
    })
    .await
}

#[tauri::command]
pub async fn workflow_acknowledge_integrity(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    root_task_id: String,
) -> Result<WorkflowRun, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::acknowledge_integrity(orch, root, &root_task_id)
    })
    .await
}

#[tauri::command]
pub async fn workflow_discard_run(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    root_task_id: String,
) -> Result<WorkflowRun, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::discard_run(orch, root, &root_task_id)
    })
    .await
}

/// Probes every provider through the runner (not project-scoped).
#[tauri::command]
pub async fn workflow_probe_providers(
    state: tauri::State<'_, WorkflowState>,
) -> Result<Vec<ProviderProbePayload>, CommandError> {
    let orch = state.inner().clone();
    blocking(move || {
        Ok(actions::probe_providers(&orch)
            .into_iter()
            .map(|(provider, result)| ProviderProbePayload { provider, result })
            .collect())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::actions::{ActionError, WORKFLOW_TITLE_EMPTY};
    use crate::workflow::attempt::ProgressUpdate;
    use crate::workflow::model::{RunStatus, TaskStatus};
    use crate::workflow::store::StoreError;
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn command_error_serializes_as_code_and_message() {
        let err = CommandError::from(ActionError::InvalidState(WORKFLOW_TITLE_EMPTY));
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({ "code": "WORKFLOW_TITLE_EMPTY", "message": "WORKFLOW_TITLE_EMPTY" })
        );
    }

    #[test]
    fn command_error_keeps_the_wrapped_store_code() {
        let err = CommandError::from(ActionError::Store(StoreError::NotFound));
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({ "code": "STORE_NOT_FOUND", "message": "STORE_NOT_FOUND" })
        );
    }

    #[test]
    fn task_changed_payload_shape() {
        let payload = TaskChangedPayload {
            project_root: root_string(Path::new("C:/repo")),
            task_id: "t1".into(),
            root_id: "r1".into(),
            status: TaskStatus::AwaitingUser,
        };
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({
                "projectRoot": "C:/repo",
                "taskId": "t1",
                "rootId": "r1",
                "status": "awaiting_user",
            })
        );
    }

    #[test]
    fn run_changed_payload_shape() {
        let payload = RunChangedPayload {
            project_root: "C:/repo".into(),
            root_task_id: "r1".into(),
            status: RunStatus::AwaitingMerge,
        };
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({ "projectRoot": "C:/repo", "rootTaskId": "r1", "status": "awaiting_merge" })
        );
    }

    #[test]
    fn progress_payload_shape() {
        let update = ProgressUpdate {
            kind: "tool",
            text: "Read file".into(),
        };
        let payload = ProgressPayload::new(Path::new("C:/repo"), "t1", "a1", &update);
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({
                "projectRoot": "C:/repo",
                "taskId": "t1",
                "attemptId": "a1",
                "kind": "tool",
                "text": "Read file",
            })
        );
    }

    #[test]
    fn task_list_serializes_with_warnings() {
        let list = crate::workflow::store::TaskList {
            tasks: vec![],
            warnings: vec![crate::workflow::store::StoreWarning {
                file: "x.md".into(),
                message: "STORE_CORRUPT: bad".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(&list).unwrap(),
            json!({ "tasks": [], "warnings": [{ "file": "x.md", "message": "STORE_CORRUPT: bad" }] })
        );
    }

    fn assert_invalid_root(root: &str) {
        let err = validate_project_root(root).unwrap_err();
        assert_eq!(err.code, WORKFLOW_PROJECT_INVALID);
    }

    #[test]
    fn project_root_must_be_an_existing_absolute_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert_invalid_root("");
        assert_invalid_root("   ");
        assert_invalid_root("relative/project");
        assert_invalid_root(&dir.path().join("missing").to_string_lossy());
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert_invalid_root(&file.to_string_lossy());
        assert_eq!(
            validate_project_root(&dir.path().to_string_lossy()).unwrap(),
            dir.path()
        );
    }

    #[test]
    fn missing_runner_fails_every_call_with_its_code() {
        let runner = MissingRunner;
        let err = runner
            .probe(
                crate::workflow::model::Provider::Codex,
                std::time::Duration::from_secs(1),
            )
            .unwrap_err();
        assert_eq!(
            err,
            crate::workflow::runner_client::RunnerError::Unavailable(AGENT_RUNNER_MISSING)
        );
    }
}

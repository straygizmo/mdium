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
use crate::workflow::attachments::{self, AttachmentError, AttachmentMeta, MAX_ATTACHMENT_BYTES};
use crate::workflow::attempt::{CancelReason, CancelToken, ProgressUpdate};
use crate::workflow::forge::{self, CliForge, ForgeProbe};
use crate::workflow::fsutil::{self, MdiumPaths};
use crate::workflow::gitops;
use crate::workflow::intake::{
    self, FinalizeOptions, IntakeError, INTAKE_NOT_ACTIVE, INTAKE_NO_PENDING_MESSAGE,
};
use crate::workflow::model::{
    IntakeKind, IntakeSession, IntakeStatus, Provider, RunStatus, Task, TaskStatus, Workflow,
    WorkflowRun, WorkflowsFile,
};
use crate::workflow::orchestrator::{EventSink, Orchestrator};
use crate::workflow::runner_client::{RunnerError, RunnerEvent, StartSessionParams};
use crate::workflow::runner_host::{RunnerApi, RunnerHost, SidecarSpawner};
use crate::workflow::state::project_key;
use crate::workflow::store::{
    RunList, StoreError, StoreWarning, TaskList, WorkflowList, WorkflowStore,
};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The process-wide orchestrator, managed as Tauri state.
pub type WorkflowState = Arc<Orchestrator>;

/// Event names (payloads are camelCase).
pub const TASK_CHANGED_EVENT: &str = "workflow://task-changed";
pub const RUN_CHANGED_EVENT: &str = "workflow://run-changed";
pub const PROGRESS_EVENT: &str = "workflow://progress";
pub const INTAKE_CHANGED_EVENT: &str = "workflow://intake-changed";
pub const WORKFLOWS_CHANGED_EVENT: &str = "workflow://workflows-changed";

/// Code of every runner call when the bundled agent runner script is missing.
pub const AGENT_RUNNER_MISSING: &str = "AGENT_RUNNER_MISSING";
/// The project root is empty, not absolute, or not an existing directory.
pub const WORKFLOW_PROJECT_INVALID: &str = "WORKFLOW_PROJECT_INVALID";
/// Code of a command whose blocking task could not be joined.
pub const WORKFLOW_COMMAND_FAILED: &str = "WORKFLOW_COMMAND_FAILED";
/// An agent turn of the intake is already running.
pub const INTAKE_TURN_BUSY: &str = "INTAKE_TURN_BUSY";
/// An intake turn panicked (recorded as the turn's `error` message).
pub const INTAKE_TURN_PANICKED: &str = "INTAKE_TURN_PANICKED";
/// Pasted attachment content is not valid base64.
pub const ATTACHMENT_INVALID_DATA: &str = "ATTACHMENT_INVALID_DATA";

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

impl From<IntakeError> for CommandError {
    fn from(err: IntakeError) -> Self {
        CommandError {
            code: err.code().to_string(),
            message: err.to_string(),
        }
    }
}

impl From<AttachmentError> for CommandError {
    fn from(err: AttachmentError) -> Self {
        CommandError {
            code: err.code().to_string(),
            message: err.to_string(),
        }
    }
}

impl CommandError {
    /// An error whose message is its code.
    fn code(code: &str) -> Self {
        CommandError {
            code: code.to_string(),
            message: code.to_string(),
        }
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

/// Payload of [`INTAKE_CHANGED_EVENT`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeChangedPayload {
    pub project_root: String,
    pub intake_id: String,
    pub status: IntakeStatus,
    /// An agent turn of the intake is running.
    pub busy: bool,
}

impl IntakeChangedPayload {
    fn new(project_root: &Path, intake_id: &str, status: IntakeStatus, busy: bool) -> Self {
        IntakeChangedPayload {
            project_root: root_string(project_root),
            intake_id: intake_id.to_string(),
            status,
            busy,
        }
    }
}

/// Payload of [`WORKFLOWS_CHANGED_EVENT`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowsChangedPayload {
    pub project_root: String,
}

impl WorkflowsChangedPayload {
    fn new(project_root: &Path) -> Self {
        WorkflowsChangedPayload {
            project_root: root_string(project_root),
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

    fn intake_changed(
        &self,
        project_root: &Path,
        intake_id: &str,
        status: IntakeStatus,
        busy: bool,
    ) {
        self.emit(
            INTAKE_CHANGED_EVENT,
            IntakeChangedPayload::new(project_root, intake_id, status, busy),
        );
    }

    fn workflows_changed(&self, project_root: &Path) {
        self.emit(
            WORKFLOWS_CHANGED_EVENT,
            WorkflowsChangedPayload::new(project_root),
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

    fn send(&self, _session_id: &str, _text: &str, _images: &[String]) -> Result<(), RunnerError> {
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
    Orchestrator::new(
        runner,
        sink,
        Arc::new(CliForge),
        gitops::default_worktree_base(),
    )
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
    with_project_cmd(state, project_root, move |orch, root| {
        op(orch, root).map_err(CommandError::from)
    })
    .await
}

/// [`with_project`] for operations that fail with a [`CommandError`]
/// (intake and attachment errors convert into one with `?`).
async fn with_project_cmd<T, F>(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    op: F,
) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&Arc<Orchestrator>, &Path) -> Result<T, CommandError> + Send + 'static,
{
    let orch = state.inner().clone();
    blocking(move || {
        let root = validate_project_root(&project_root)?;
        if orch.attach(&root).1 {
            orch.kick(&root);
        }
        op(&orch, &root)
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
    expected_head: Option<String>,
) -> Result<WorkflowRun, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::merge_run(
            orch,
            root,
            &root_task_id,
            &acknowledged_paths,
            acknowledge_integrity,
            expected_head.as_deref(),
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

/// Run-data directories under `.mdium/` that should not be committed.
const GITIGNORE_PATHS: [&str; 4] = [
    ".mdium/tasks/",
    ".mdium/runs/",
    ".mdium/task-attachments/",
    ".mdium/intakes/",
];

/// Which run-data directories `.gitignore` does not cover yet.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreStatus {
    pub missing: Vec<String>,
}

/// The entries of [`GITIGNORE_PATHS`] git does not ignore in `project_root`
/// (every entry when the project is not a git repository or git fails).
/// A file inside each directory is checked, so directory rules match.
fn gitignore_missing(project_root: &Path) -> Vec<String> {
    GITIGNORE_PATHS
        .iter()
        .filter(|dir| {
            let probe = format!("{dir}x");
            !matches!(
                gitops::run_git_raw(project_root, &["check-ignore", "-q", "--", &probe]),
                Ok(output) if output.success
            )
        })
        .map(|dir| dir.to_string())
        .collect()
}

/// Reports which run-data directories should be added to `.gitignore`.
#[tauri::command]
pub async fn workflow_gitignore_status(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
) -> Result<GitignoreStatus, CommandError> {
    with_project(state, project_root, |_orch, root| {
        Ok(GitignoreStatus {
            missing: gitignore_missing(root),
        })
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

/// The forge of the project's `origin` and whether its CLI can be used,
/// so the UI can tell before an intake starts whether Issues will be
/// tracked.
#[tauri::command]
pub async fn workflow_forge_probe(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
) -> Result<ForgeProbe, CommandError> {
    with_project_cmd(state, project_root, |orch, root| {
        Ok(forge::probe(root, orch.forge().as_ref()))
    })
    .await
}

// ---------------------------------------------------------------------------
// Intake sessions
// ---------------------------------------------------------------------------

/// Key of a turn in [`IntakeTurns`]: the project's key (see
/// [`project_key`]) and the intake id.
type TurnKey = (PathBuf, String);

fn turn_key(project_root: &Path, intake_id: &str) -> TurnKey {
    (project_key(project_root), intake_id.to_string())
}

/// Intake agent turns running in this process, by project and intake id,
/// with the token that cancels each.
pub struct IntakeTurns {
    running: Mutex<BTreeMap<TurnKey, CancelToken>>,
}

impl IntakeTurns {
    pub const fn new() -> Self {
        IntakeTurns {
            running: Mutex::new(BTreeMap::new()),
        }
    }

    fn running(&self) -> MutexGuard<'_, BTreeMap<TurnKey, CancelToken>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Marks a turn of intake `intake_id` of `project_root` as running;
    /// [`INTAKE_TURN_BUSY`] when one already is. The turn counts as running
    /// until the slot drops.
    fn begin(
        &'static self,
        project_root: &Path,
        intake_id: &str,
    ) -> Result<TurnSlot, CommandError> {
        let key = turn_key(project_root, intake_id);
        let mut running = self.running();
        if running.contains_key(&key) {
            return Err(CommandError::code(INTAKE_TURN_BUSY));
        }
        let token = CancelToken::default();
        running.insert(key.clone(), token.clone());
        Ok(TurnSlot {
            turns: self,
            key,
            token,
        })
    }

    /// Whether a turn of intake `intake_id` of `project_root` is running.
    fn is_busy(&self, project_root: &Path, intake_id: &str) -> bool {
        self.running()
            .contains_key(&turn_key(project_root, intake_id))
    }

    /// Cancels the running turn of intake `intake_id` of `project_root`;
    /// false when none runs.
    fn cancel(&self, project_root: &Path, intake_id: &str) -> bool {
        match self.running().get(&turn_key(project_root, intake_id)) {
            Some(token) => {
                token.cancel(CancelReason::User);
                true
            }
            None => false,
        }
    }

    /// Cancels every running turn with `reason`.
    fn cancel_all(&self, reason: CancelReason) {
        for token in self.running().values() {
            token.cancel(reason);
        }
    }
}

/// A running turn's membership in [`IntakeTurns`], released on drop.
struct TurnSlot {
    turns: &'static IntakeTurns,
    key: TurnKey,
    token: CancelToken,
}

impl TurnSlot {
    fn token(&self) -> &CancelToken {
        &self.token
    }
}

impl Drop for TurnSlot {
    fn drop(&mut self) {
        self.turns.running().remove(&self.key);
    }
}

/// The process-wide intake turn registry.
static INTAKE_TURNS: IntakeTurns = IntakeTurns::new();

/// Cancels every running intake turn (on app exit, before the orchestrator
/// and its runner shut down).
pub fn cancel_intake_turns() {
    INTAKE_TURNS.cancel_all(CancelReason::Shutdown);
}

/// An intake session plus whether one of its agent turns is running and
/// the paths of its applied doc updates (files written into the user's
/// working tree that still need committing).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeSessionView {
    #[serde(flatten)]
    pub session: IntakeSession,
    pub busy: bool,
    pub applied_doc_paths: Vec<String>,
}

/// Result of [`workflow_intake_list`]: sessions newest first, plus one
/// warning per file that did not load.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeListView {
    pub sessions: Vec<IntakeSessionView>,
    pub warnings: Vec<StoreWarning>,
}

fn session_view(store: &WorkflowStore, session: IntakeSession) -> IntakeSessionView {
    let busy = INTAKE_TURNS.is_busy(store.project_root(), &session.id);
    let applied_doc_paths = intake::applied_doc_paths(&session);
    IntakeSessionView {
        session,
        busy,
        applied_doc_paths,
    }
}

/// Reports `session` (with its live busy state) as changed.
fn emit_intake(sink: &dyn EventSink, store: &WorkflowStore, session: &IntakeSession) {
    sink.intake_changed(
        store.project_root(),
        &session.id,
        session.status,
        INTAKE_TURNS.is_busy(store.project_root(), &session.id),
    );
}

/// Reports session `intake_id` as changed after an operation that may have
/// changed it even though it failed (e.g. a finalize that recorded its
/// error); nothing is reported when the session cannot be loaded.
fn emit_intake_reloaded(sink: &dyn EventSink, store: &WorkflowStore, intake_id: &str) {
    if let Ok(session) = intake::get_session(store, intake_id) {
        emit_intake(sink, store, &session);
    }
}

/// Runs one turn and ends it: a turn that fails or panics records its code
/// as an `error` message (when a reply is still pending), the slot is
/// released, and the session is reported with `busy` false.
fn run_turn_to_end(
    runner: &dyn RunnerApi,
    sink: &dyn EventSink,
    store: &WorkflowStore,
    intake_id: &str,
    slot: TurnSlot,
) {
    let result = catch_unwind(AssertUnwindSafe(|| {
        intake::run_turn(runner, store, intake_id, slot.token())
    }));
    let failure = match result {
        Ok(Ok(_)) => None,
        Ok(Err(err)) => {
            eprintln!("[workflow] intake turn of {intake_id} failed: {err}");
            Some(err.code())
        }
        Err(_) => {
            eprintln!("[workflow] intake turn of {intake_id} panicked");
            Some(INTAKE_TURN_PANICKED)
        }
    };
    if let Some(code) = failure {
        if let Err(err) = intake::record_turn_error(store, intake_id, code) {
            eprintln!("[workflow] recording the turn failure of intake {intake_id} failed: {err}");
        }
    }
    // Released before reporting, so the report says the turn ended.
    drop(slot);
    emit_intake_reloaded(sink, store, intake_id);
}

/// Reports the turn held by `slot` as started and runs it on its own
/// thread, which reports the session again when the turn ends.
fn start_turn(
    orch: &Arc<Orchestrator>,
    store: WorkflowStore,
    session: &IntakeSession,
    slot: TurnSlot,
) -> Result<(), CommandError> {
    let sink = orch.sink().clone();
    emit_intake(sink.as_ref(), &store, session);
    let runner = orch.runner().clone();
    let project_root = store.project_root().to_path_buf();
    let intake_id = session.id.clone();
    let thread_sink = sink.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("intake-turn-{intake_id}"))
        .spawn(move || {
            run_turn_to_end(
                runner.as_ref(),
                thread_sink.as_ref(),
                &store,
                &intake_id,
                slot,
            )
        });
    if let Err(err) = spawned {
        // The closure (and with it the slot) was dropped: the turn is over.
        emit_intake_reloaded(sink.as_ref(), &orch.store(&project_root), &session.id);
        return Err(CommandError {
            code: WORKFLOW_COMMAND_FAILED.to_string(),
            message: format!("{WORKFLOW_COMMAND_FAILED}: intake turn thread: {err}"),
        });
    }
    Ok(())
}

/// Starts a new intake session for workflow `workflow_id`.
#[tauri::command]
pub async fn workflow_intake_create(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    workflow_id: String,
    kind: IntakeKind,
    provider: Provider,
    model: Option<String>,
) -> Result<IntakeSessionView, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let store = orch.store(root);
        let session = {
            let guard = store.lock();
            intake::create_session(&store, &guard, &workflow_id, kind, provider, model)?
        };
        emit_intake(orch.sink().as_ref(), &store, &session);
        Ok(session_view(&store, session))
    })
    .await
}

#[tauri::command]
pub async fn workflow_intake_list(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
) -> Result<IntakeListView, CommandError> {
    with_project_cmd(state, project_root, |orch, root| {
        let store = orch.store(root);
        let list = intake::list_sessions(&store)?;
        Ok(IntakeListView {
            sessions: list
                .sessions
                .into_iter()
                .map(|session| session_view(&store, session))
                .collect(),
            warnings: list.warnings,
        })
    })
    .await
}

#[tauri::command]
pub async fn workflow_intake_get(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
) -> Result<IntakeSessionView, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let store = orch.store(root);
        let session = intake::get_session(&store, &intake_id)?;
        Ok(session_view(&store, session))
    })
    .await
}

/// Appends a user message (text and/or drafts) and starts the agent's turn
/// in the background; returns the session with the message. The reply (or
/// an `error` message) arrives with the `intake-changed` event that ends
/// the turn. Refused with [`INTAKE_TURN_BUSY`] while a turn runs.
#[tauri::command]
pub async fn workflow_intake_send(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
    text: String,
    draft_ids: Vec<String>,
) -> Result<IntakeSessionView, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let store = orch.store(root);
        let slot = INTAKE_TURNS.begin(store.project_root(), &intake_id)?;
        let session = {
            let guard = store.lock();
            intake::add_user_message(&guard, &store, &intake_id, &text, &draft_ids)?
        };
        let view = session_view(&store, session.clone());
        start_turn(orch, store, &session, slot)?;
        Ok(view)
    })
    .await
}

/// Runs the turn answering the latest user message again (after a failed,
/// cancelled or interrupted turn), in the background like
/// [`workflow_intake_send`].
#[tauri::command]
pub async fn workflow_intake_retry(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
) -> Result<IntakeSessionView, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let store = orch.store(root);
        let slot = INTAKE_TURNS.begin(store.project_root(), &intake_id)?;
        let session = {
            let _guard = store.lock();
            let session = intake::get_session(&store, &intake_id)?;
            if session.status != IntakeStatus::Active {
                return Err(IntakeError::InvalidState(INTAKE_NOT_ACTIVE).into());
            }
            if intake::pending_message(&session).is_none() {
                return Err(IntakeError::InvalidState(INTAKE_NO_PENDING_MESSAGE).into());
            }
            session
        };
        let view = session_view(&store, session.clone());
        start_turn(orch, store, &session, slot)?;
        Ok(view)
    })
    .await
}

/// Cancels the running turn of the intake; false when none runs. The turn
/// ends with an `INTAKE_TURN_CANCELLED` error message.
#[tauri::command]
pub async fn workflow_intake_cancel_turn(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
) -> Result<bool, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        Ok(INTAKE_TURNS.cancel(orch.store(root).project_root(), &intake_id))
    })
    .await
}

/// Abandons the intake (deleting its drafts) and cancels its running turn.
#[tauri::command]
pub async fn workflow_intake_abandon(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
) -> Result<IntakeSessionView, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let store = orch.store(root);
        let session = {
            let guard = store.lock();
            intake::abandon_session(&store, &guard, &intake_id)?
        };
        INTAKE_TURNS.cancel(store.project_root(), &intake_id);
        emit_intake(orch.sink().as_ref(), &store, &session);
        Ok(session_view(&store, session))
    })
    .await
}

/// Runs `op` on the attachment paths under the project lock, after
/// checking that intake `intake_id` exists and is active.
fn with_active_intake<T>(
    store: &WorkflowStore,
    intake_id: &str,
    op: impl FnOnce(&MdiumPaths) -> Result<T, AttachmentError>,
) -> Result<T, CommandError> {
    let _guard = store.lock();
    let session = intake::get_session(store, intake_id)?;
    if session.status != IntakeStatus::Active {
        return Err(IntakeError::InvalidState(INTAKE_NOT_ACTIVE).into());
    }
    Ok(op(&MdiumPaths::new(store.project_root()))?)
}

/// Adds a copy of the file at `path` (a regular file, not a link, of at
/// most 20 MiB) as a draft attachment of the active intake.
#[tauri::command]
pub async fn workflow_intake_add_draft_path(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
    path: String,
) -> Result<AttachmentMeta, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let store = orch.store(root);
        // Checked first so nothing is read for an inactive intake, and
        // again when storing: the source (maybe on a slow drive) is read
        // without holding the project lock.
        with_active_intake(&store, &intake_id, |_| Ok(()))?;
        let (name, bytes) = attachments::read_source(Path::new(&path))?;
        with_active_intake(&store, &intake_id, |paths| {
            attachments::add_draft_from_bytes(paths, &intake_id, &name, &bytes)
        })
    })
    .await
}

/// The longest base64 text that can decode to [`MAX_ATTACHMENT_BYTES`].
fn max_base64_len() -> usize {
    (MAX_ATTACHMENT_BYTES as usize).div_ceil(3) * 4
}

/// Decodes pasted base64 content, refusing text too long for an
/// attachment before decoding it.
fn decode_draft_bytes(bytes_base64: &str) -> Result<Vec<u8>, CommandError> {
    use base64::Engine;
    if bytes_base64.len() > max_base64_len() {
        return Err(AttachmentError::TooLarge.into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|err| CommandError {
            code: ATTACHMENT_INVALID_DATA.to_string(),
            message: format!("{ATTACHMENT_INVALID_DATA}: {err}"),
        })?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(AttachmentError::TooLarge.into());
    }
    Ok(bytes)
}

/// Adds in-memory content (e.g. a pasted image), base64-encoded, as a draft
/// attachment named `name` of the active intake.
#[tauri::command]
pub async fn workflow_intake_add_draft_bytes(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
    name: String,
    bytes_base64: String,
) -> Result<AttachmentMeta, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let bytes = decode_draft_bytes(&bytes_base64)?;
        with_active_intake(&orch.store(root), &intake_id, |paths| {
            attachments::add_draft_from_bytes(paths, &intake_id, &name, &bytes)
        })
    })
    .await
}

/// Deletes a draft of the active intake (a missing draft is a no-op).
#[tauri::command]
pub async fn workflow_intake_remove_draft(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
    draft_id: String,
) -> Result<(), CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        with_active_intake(&orch.store(root), &intake_id, |paths| {
            attachments::remove_draft(paths, &intake_id, &draft_id)
        })
    })
    .await
}

/// The drafts of the intake, oldest first.
#[tauri::command]
pub async fn workflow_intake_list_drafts(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
) -> Result<Vec<AttachmentMeta>, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let paths = MdiumPaths::new(orch.store(root).project_root());
        Ok(attachments::list_drafts(&paths, &intake_id)?)
    })
    .await
}

/// Accepts (writes) or rejects a pending documentation update.
#[tauri::command]
pub async fn workflow_intake_apply_doc_update(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
    proposal_id: String,
    accept: bool,
) -> Result<IntakeSessionView, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let store = orch.store(root);
        let session = {
            let guard = store.lock();
            intake::apply_doc_update(&store, &guard, &intake_id, &proposal_id, accept)?
        };
        emit_intake(orch.sink().as_ref(), &store, &session);
        Ok(session_view(&store, session))
    })
    .await
}

/// Replaces the proposal of an active session with the user's edit.
/// Refused with [`INTAKE_TURN_BUSY`] while a turn runs (its reply would
/// replace the edit).
#[tauri::command]
pub async fn workflow_intake_update_proposal(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
    title: String,
    body: String,
) -> Result<IntakeSessionView, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let store = orch.store(root);
        let session = update_proposal_when_idle(&INTAKE_TURNS, &store, &intake_id, &title, &body)?;
        emit_intake(orch.sink().as_ref(), &store, &session);
        Ok(session_view(&store, session))
    })
    .await
}

/// [`intake::update_proposal`] while holding the intake's turn slot of
/// `turns`, so no turn starts (or runs) meanwhile.
fn update_proposal_when_idle(
    turns: &'static IntakeTurns,
    store: &WorkflowStore,
    intake_id: &str,
    title: &str,
    body: &str,
) -> Result<IntakeSession, CommandError> {
    let _slot = turns.begin(store.project_root(), intake_id)?;
    let guard = store.lock();
    Ok(intake::update_proposal(
        store, &guard, intake_id, title, body,
    )?)
}

/// Returns a finalize that stopped before the forge was called to the
/// conversation (see [`intake::reopen_intake`]).
#[tauri::command]
pub async fn workflow_intake_reopen(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
) -> Result<IntakeSessionView, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let store = orch.store(root);
        let session = {
            let guard = store.lock();
            intake::reopen_intake(&store, &guard, &intake_id)?
        };
        emit_intake(orch.sink().as_ref(), &store, &session);
        Ok(session_view(&store, session))
    })
    .await
}

/// A verified absolute path as a string for the UI (e.g. for
/// `convertFileSrc` or opening the file).
fn path_string(path: PathBuf) -> Result<String, CommandError> {
    path.into_os_string().into_string().map_err(|path| {
        AttachmentError::Io(format!(
            "{}: not valid UTF-8",
            PathBuf::from(path).display()
        ))
        .into()
    })
}

/// The absolute path of a committed attachment's content, verified against
/// its metadata and to lie under the attachments root.
#[tauri::command]
pub async fn workflow_attachment_path(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    root_task_id: String,
    attachment_id: String,
) -> Result<String, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let paths = MdiumPaths::new(orch.store(root).project_root());
        path_string(attachments::attachment_file(
            &paths,
            &root_task_id,
            &attachment_id,
        )?)
    })
    .await
}

/// The absolute path of a draft's content, verified like
/// [`workflow_attachment_path`].
#[tauri::command]
pub async fn workflow_intake_draft_path(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
    draft_id: String,
) -> Result<String, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let paths = MdiumPaths::new(orch.store(root).project_root());
        path_string(attachments::draft_file(&paths, &intake_id, &draft_id)?)
    })
    .await
}

/// Turns the intake's proposal into a root task (creating its Issue unless
/// `skip_issue`); after a failure, calling it again resumes at the failed
/// stage.
#[tauri::command]
pub async fn workflow_intake_finalize(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: String,
    skip_issue: bool,
) -> Result<IntakeSessionView, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let result = intake::finalize(orch, root, &intake_id, FinalizeOptions { skip_issue });
        let store = orch.store(root);
        // Reported either way: a failure records its code on the session.
        emit_intake_reloaded(orch.sink().as_ref(), &store, &intake_id);
        Ok(session_view(&store, result?))
    })
    .await
}

/// The committed attachments of root task `root_task_id`, oldest first.
#[tauri::command]
pub async fn workflow_list_attachments(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    root_task_id: String,
) -> Result<Vec<AttachmentMeta>, CommandError> {
    with_project_cmd(state, project_root, move |orch, root| {
        let paths = MdiumPaths::new(orch.store(root).project_root());
        Ok(attachments::list_attachments(&paths, &root_task_id)?)
    })
    .await
}

/// Posts the pending Issue entry of a task whose Issue sync failed, then
/// completes its stage.
#[tauri::command]
pub async fn workflow_retry_issue_sync(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::retry_issue_sync(orch, root, &task_id)
    })
    .await
}

/// Completes the stage of a task whose Issue sync failed without posting
/// its Issue entry.
#[tauri::command]
pub async fn workflow_skip_issue_sync(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    task_id: String,
) -> Result<Task, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::skip_issue_sync(orch, root, &task_id)
    })
    .await
}

/// Closes the Issue of a merged run whose earlier close failed.
#[tauri::command]
pub async fn workflow_retry_issue_close(
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    root_task_id: String,
) -> Result<WorkflowRun, CommandError> {
    with_project(state, project_root, move |orch, root| {
        actions::retry_issue_close(orch, root, &root_task_id)
    })
    .await
}

/// Label prefix of every intake window (matched by the `intake`
/// capability; these windows close together with the main window).
pub const INTAKE_WINDOW_PREFIX: &str = "intake-";

/// The label and app URL of the intake window of `intake_id`, or of a new
/// intake (a fresh `intake-new-<nonce>` label) when it is `None`. The query
/// carries the percent-encoded root, intake id and workflow id (empty when
/// absent). Rejects an invalid intake id with `STORE_INVALID_ID`.
fn intake_window_spec(
    project_root: &str,
    intake_id: Option<&str>,
    workflow_id: Option<&str>,
) -> Result<(String, String), CommandError> {
    let label = match intake_id {
        Some(id) => {
            fsutil::validate_id(id).map_err(|err| CommandError {
                code: err.code().to_string(),
                message: err.to_string(),
            })?;
            format!("{INTAKE_WINDOW_PREFIX}{id}")
        }
        None => format!("{INTAKE_WINDOW_PREFIX}new-{}", fsutil::new_id()),
    };
    let encode = |value: &str| utf8_percent_encode(value, NON_ALPHANUMERIC).to_string();
    let url = format!(
        "index.html?view=intake&root={}&intake={}&workflow={}",
        encode(project_root),
        encode(intake_id.unwrap_or("")),
        encode(workflow_id.unwrap_or("")),
    );
    Ok((label, url))
}

/// Brings an existing window to the front.
fn focus_window(window: &WebviewWindow) -> Result<(), CommandError> {
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Opens the intake window of `intake_id` (which must exist), or a window
/// for a new intake of `workflow_id` when it is `None`; an already open
/// window of the intake is focused instead. Returns the window label.
/// `project_root` should be the normalized root (the value
/// [`workflow_attach_project`] returns): the window uses it as is.
#[tauri::command]
pub async fn workflow_open_intake_window(
    app: AppHandle,
    state: tauri::State<'_, WorkflowState>,
    project_root: String,
    intake_id: Option<String>,
    workflow_id: Option<String>,
) -> Result<String, CommandError> {
    let (label, url) =
        intake_window_spec(&project_root, intake_id.as_deref(), workflow_id.as_deref())?;
    with_project_cmd(state, project_root, move |orch, root| {
        if let Some(id) = intake_id {
            intake::get_session(&orch.store(root), &id)?;
        }
        Ok(())
    })
    .await?;
    if let Some(window) = app.get_webview_window(&label) {
        focus_window(&window)?;
        return Ok(label);
    }
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("MDium")
        .inner_size(900.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .decorations(true)
        .build();
    match built {
        Ok(_) => Ok(label),
        // A concurrent call created the same intake's window first.
        Err(err) => match app.get_webview_window(&label) {
            Some(window) => {
                focus_window(&window)?;
                Ok(label)
            }
            None => Err(err.into()),
        },
    }
}

/// Closes every intake window; called when the main window is gone, just
/// before the app exits.
pub fn close_intake_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(INTAKE_WINDOW_PREFIX) {
            if let Err(err) = window.destroy() {
                eprintln!("[workflow] closing intake window {label} failed: {err}");
            }
        }
    }
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

    /// A throwaway repo whose excludes file is empty, so the user's global
    /// or XDG excludes cannot affect the ignore checks.
    fn isolated_fixture() -> gitops::test_support::Fixture {
        let fixture = gitops::test_support::Fixture::new();
        let excludes = fixture.base().join("empty-excludes");
        std::fs::write(&excludes, "").unwrap();
        fixture.run(&["config", "core.excludesFile", &excludes.to_string_lossy()]);
        fixture
    }

    #[test]
    fn intake_changed_payload_shape() {
        let payload = IntakeChangedPayload::new(
            Path::new("C:/repo"),
            "0123456789abcdef",
            IntakeStatus::Finalizing,
            true,
        );
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({
                "projectRoot": "C:/repo",
                "intakeId": "0123456789abcdef",
                "status": "finalizing",
                "busy": true,
            })
        );
    }

    #[test]
    fn workflows_changed_payload_shape() {
        let payload = WorkflowsChangedPayload::new(Path::new("C:/repo"));
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({ "projectRoot": "C:/repo" })
        );
    }

    fn sample_session() -> IntakeSession {
        IntakeSession {
            schema_version: 1,
            id: "0123456789abcdef".into(),
            workflow_id: "wf1".into(),
            kind: IntakeKind::Feature,
            provider: Provider::Codex,
            model: None,
            status: IntakeStatus::Active,
            messages: vec![],
            last_question: None,
            proposal: None,
            doc_updates: vec![],
            finalize: Default::default(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn intake_session_view_flattens_the_session_and_adds_busy() {
        let session = sample_session();
        let view = IntakeSessionView {
            session: session.clone(),
            busy: true,
            applied_doc_paths: vec!["docs/a.md".into()],
        };
        let mut expected = serde_json::to_value(&session).unwrap();
        expected["busy"] = json!(true);
        expected["appliedDocPaths"] = json!(["docs/a.md"]);
        assert_eq!(serde_json::to_value(&view).unwrap(), expected);
        assert_eq!(expected["workflowId"], json!("wf1"));
    }

    #[test]
    fn intake_list_view_shape() {
        let list = IntakeListView {
            sessions: vec![IntakeSessionView {
                session: sample_session(),
                busy: false,
                applied_doc_paths: vec![],
            }],
            warnings: vec![],
        };
        let value = serde_json::to_value(&list).unwrap();
        assert_eq!(value["sessions"][0]["busy"], json!(false));
        assert_eq!(value["sessions"][0]["appliedDocPaths"], json!([]));
        assert_eq!(value["sessions"][0]["id"], json!("0123456789abcdef"));
        assert_eq!(value["warnings"], json!([]));
    }

    #[test]
    fn command_error_keeps_intake_and_attachment_codes() {
        let err = CommandError::from(IntakeError::InvalidState(
            crate::workflow::intake::INTAKE_NOT_ACTIVE,
        ));
        assert_eq!(err.code, "INTAKE_NOT_ACTIVE");
        let err = CommandError::from(IntakeError::Attachment(AttachmentError::TooLarge));
        assert_eq!(err.code, "ATTACHMENT_TOO_LARGE");
        let err = CommandError::from(AttachmentError::NotFound);
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({ "code": "ATTACHMENT_NOT_FOUND", "message": "ATTACHMENT_NOT_FOUND" })
        );
    }

    #[test]
    fn draft_bytes_are_decoded_within_the_size_limit() {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"hello");
        assert_eq!(decode_draft_bytes(&encoded).unwrap(), b"hello");
        assert_eq!(decode_draft_bytes("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn draft_bytes_over_the_limit_are_refused_before_decoding() {
        // One base64 quantum more than the limit allows; not valid base64
        // either, so only the size check can have refused it.
        let too_long = "!".repeat(max_base64_len() + 4);
        assert_eq!(
            decode_draft_bytes(&too_long).unwrap_err().code,
            "ATTACHMENT_TOO_LARGE"
        );
        // The largest decodable size is exactly the attachment limit.
        assert!(max_base64_len() / 4 * 3 >= MAX_ATTACHMENT_BYTES as usize);
        assert!((max_base64_len() / 4 - 1) * 3 < MAX_ATTACHMENT_BYTES as usize);
    }

    #[test]
    fn invalid_draft_bytes_are_refused() {
        assert_eq!(
            decode_draft_bytes("not base64!").unwrap_err().code,
            ATTACHMENT_INVALID_DATA
        );
    }

    /// Two existing project directories.
    fn two_projects() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let (one, other) = (dir.path().join("one"), dir.path().join("other"));
        std::fs::create_dir(&one).unwrap();
        std::fs::create_dir(&other).unwrap();
        (dir, one, other)
    }

    #[test]
    fn a_second_turn_of_a_busy_intake_is_refused() {
        static TURNS: IntakeTurns = IntakeTurns::new();
        let (_dir, one, other) = two_projects();
        let slot = TURNS.begin(&one, "a").unwrap();
        assert!(TURNS.is_busy(&one, "a"));
        assert_eq!(
            TURNS.begin(&one, "a").map(|_| ()).unwrap_err().code,
            INTAKE_TURN_BUSY
        );
        // Another spelling of the same root is the same project.
        assert!(TURNS.is_busy(&one.join(""), "a"));
        // Another intake, or the same id in another project, is independent.
        drop(TURNS.begin(&one, "b").unwrap());
        assert!(!TURNS.is_busy(&other, "a"));
        drop(TURNS.begin(&other, "a").unwrap());
        drop(slot);
        assert!(!TURNS.is_busy(&one, "a"));
        assert!(TURNS.begin(&one, "a").is_ok());
    }

    #[test]
    fn cancelling_a_turn_sets_its_token() {
        static TURNS: IntakeTurns = IntakeTurns::new();
        let (_dir, one, other) = two_projects();
        assert!(!TURNS.cancel(&one, "a"));
        let slot = TURNS.begin(&one, "a").unwrap();
        assert_eq!(slot.token().reason(), None);
        assert!(!TURNS.cancel(&other, "a"));
        assert_eq!(slot.token().reason(), None);
        assert!(TURNS.cancel(&one, "a"));
        assert_eq!(slot.token().reason(), Some(CancelReason::User));
        drop(slot);
        assert!(!TURNS.cancel(&one, "a"));
    }

    /// A runner whose sessions panic when started.
    struct PanickingRunner;

    impl RunnerApi for PanickingRunner {
        fn start_session(
            &self,
            _params: StartSessionParams,
            _timeout: Duration,
        ) -> Result<(Receiver<RunnerEvent>, Option<String>), RunnerError> {
            panic!("runner panicked on purpose");
        }

        fn send(&self, _: &str, _: &str, _: &[String]) -> Result<(), RunnerError> {
            Ok(())
        }

        fn cancel(&self, _: &str) -> Result<(), RunnerError> {
            Ok(())
        }

        fn respond_permission(&self, _: &str, _: &str, _: bool) -> Result<(), RunnerError> {
            Ok(())
        }

        fn close_session(&self, _: &str) -> Result<(), RunnerError> {
            Ok(())
        }

        fn probe(&self, _: Provider, _: Duration) -> Result<serde_json::Value, RunnerError> {
            Err(runner_missing())
        }

        fn shutdown(&self) {}
    }

    /// Records the intake-changed reports.
    #[derive(Default)]
    struct IntakeSink {
        reports: Mutex<Vec<(String, IntakeStatus, bool)>>,
    }

    impl EventSink for IntakeSink {
        fn task_changed(&self, _: &Path, _: &Task) {}
        fn run_changed(&self, _: &Path, _: &WorkflowRun) {}
        fn progress(&self, _: &Path, _: &str, _: &str, _: &ProgressUpdate) {}
        fn intake_changed(&self, _: &Path, intake_id: &str, status: IntakeStatus, busy: bool) {
            self.reports
                .lock()
                .unwrap()
                .push((intake_id.to_string(), status, busy));
        }
        fn workflows_changed(&self, _: &Path) {}
    }

    /// A store with one enabled workflow; returns its id.
    fn store_with_workflow(dir: &Path) -> (WorkflowStore, String) {
        let store = WorkflowStore::new(dir.to_path_buf());
        let mut workflow =
            crate::workflow::template::standard_workflow("Standard", Provider::Codex);
        workflow.enabled = true;
        let id = workflow.id.clone();
        store
            .save_workflows(&WorkflowsFile {
                schema_version: 1,
                workflows: vec![workflow],
            })
            .unwrap();
        (store, id)
    }

    #[test]
    fn a_panicked_turn_records_its_code_and_ends() {
        let dir = tempfile::tempdir().unwrap();
        let (store, workflow_id) = store_with_workflow(dir.path());
        let session = {
            let guard = store.lock();
            let session = intake::create_session(
                &store,
                &guard,
                &workflow_id,
                IntakeKind::Feature,
                Provider::Codex,
                None,
            )
            .unwrap();
            intake::add_user_message(&guard, &store, &session.id, "hello", &[]).unwrap()
        };
        let sink = IntakeSink::default();
        let slot = INTAKE_TURNS
            .begin(store.project_root(), &session.id)
            .unwrap();

        run_turn_to_end(&PanickingRunner, &sink, &store, &session.id, slot);

        assert!(!INTAKE_TURNS.is_busy(store.project_root(), &session.id));
        let updated = intake::get_session(&store, &session.id).unwrap();
        let last = updated.messages.last().unwrap();
        assert_eq!(
            (last.role.as_str(), last.text.as_str()),
            ("error", INTAKE_TURN_PANICKED)
        );
        assert_eq!(
            *sink.reports.lock().unwrap(),
            vec![(session.id.clone(), IntakeStatus::Active, false)]
        );
    }

    #[test]
    fn proposals_are_not_edited_while_a_turn_runs() {
        static TURNS: IntakeTurns = IntakeTurns::new();
        let dir = tempfile::tempdir().unwrap();
        let (store, workflow_id) = store_with_workflow(dir.path());
        let session = {
            let guard = store.lock();
            let mut session = intake::create_session(
                &store,
                &guard,
                &workflow_id,
                IntakeKind::Feature,
                Provider::Codex,
                None,
            )
            .unwrap();
            session.proposal = Some(crate::workflow::model::IntakeProposal {
                title: "T".into(),
                body: "B".into(),
            });
            intake::save_session(&store, &guard, &session).unwrap()
        };
        let slot = TURNS.begin(store.project_root(), &session.id).unwrap();
        assert_eq!(
            update_proposal_when_idle(&TURNS, &store, &session.id, "New", "Body")
                .unwrap_err()
                .code,
            INTAKE_TURN_BUSY
        );
        drop(slot);
        let updated =
            update_proposal_when_idle(&TURNS, &store, &session.id, "New", "Body").unwrap();
        assert_eq!(updated.proposal.unwrap().title, "New");
        // The slot is released again.
        assert!(!TURNS.is_busy(store.project_root(), &session.id));
    }

    #[test]
    fn verified_paths_are_returned_as_strings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        assert_eq!(
            path_string(path.clone()).unwrap(),
            path.to_str().unwrap().to_string()
        );
    }

    #[test]
    fn cancelling_all_turns_cancels_every_project() {
        static TURNS: IntakeTurns = IntakeTurns::new();
        let (_dir, one, other) = two_projects();
        let first = TURNS.begin(&one, "a").unwrap();
        let second = TURNS.begin(&other, "b").unwrap();
        TURNS.cancel_all(CancelReason::Shutdown);
        assert_eq!(first.token().reason(), Some(CancelReason::Shutdown));
        assert_eq!(second.token().reason(), Some(CancelReason::Shutdown));
    }

    #[test]
    fn gitignore_status_shape() {
        let status = GitignoreStatus {
            missing: vec![".mdium/runs/".into()],
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "missing": [".mdium/runs/"] })
        );
    }

    #[test]
    fn gitignore_status_is_empty_when_mdium_is_ignored() {
        let fixture = isolated_fixture();
        fixture.write(".gitignore", ".mdium/\n");
        assert!(gitignore_missing(fixture.root()).is_empty());
    }

    #[test]
    fn gitignore_status_lists_every_path_without_rules() {
        let fixture = isolated_fixture();
        fixture.write(".gitignore", "");
        assert_eq!(gitignore_missing(fixture.root()), GITIGNORE_PATHS);
    }

    #[test]
    fn gitignore_status_lists_only_uncovered_paths() {
        let fixture = isolated_fixture();
        fixture.write(".gitignore", ".mdium/tasks/\n.mdium/runs/\n");
        assert_eq!(
            gitignore_missing(fixture.root()),
            vec![".mdium/task-attachments/", ".mdium/intakes/"]
        );
    }

    #[test]
    fn gitignore_status_lists_every_path_outside_git() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(gitignore_missing(dir.path()), GITIGNORE_PATHS);
    }

    #[test]
    fn intake_window_spec_of_an_existing_intake() {
        let (label, url) =
            intake_window_spec(r"C:\my proj&x", Some("0123456789abcdef"), Some("wf 1")).unwrap();
        assert_eq!(label, "intake-0123456789abcdef");
        assert_eq!(
            url,
            "index.html?view=intake&root=C%3A%5Cmy%20proj%26x&intake=0123456789abcdef&workflow=wf%201"
        );
    }

    #[test]
    fn intake_window_spec_of_a_new_intake_uses_a_fresh_label() {
        let (label, url) = intake_window_spec("/repo", None, Some("wf1")).unwrap();
        let nonce = label.strip_prefix("intake-new-").unwrap();
        assert!(crate::workflow::fsutil::is_valid_id(nonce));
        assert_eq!(
            url,
            "index.html?view=intake&root=%2Frepo&intake=&workflow=wf1"
        );
        let (other, _) = intake_window_spec("/repo", None, None).unwrap();
        assert_ne!(label, other);
    }

    #[test]
    fn intake_window_spec_without_a_workflow_leaves_it_empty() {
        let (_, url) = intake_window_spec("/repo", Some("0123456789abcdef"), None).unwrap();
        assert!(url.ends_with("&workflow="));
    }

    #[test]
    fn intake_window_spec_rejects_invalid_intake_ids() {
        for id in ["", "../x", "0123456789ABCDEF", "0123456789abcdef0"] {
            let err = intake_window_spec("/repo", Some(id), None).unwrap_err();
            assert_eq!(err.code, "STORE_INVALID_ID", "{id:?}");
        }
    }
}

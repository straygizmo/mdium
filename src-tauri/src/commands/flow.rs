// src-tauri/src/commands/flow.rs
//! Tauri commands of the generic flow engine (definitions). Every command
//! is a thin wrapper over `flow_core::service::FlowService`; the UI that
//! calls these is gated behind the `experimentalFlows` setting.

use flow_core::load::FlowSummary;
use flow_core::service::FlowService;
use flow_core::service::ProjectLoadResult;
pub use flow_core::service::{FlowCommandError, FlowLoadResult, FLOW_COMMAND_FAILED};
use flow_core::setup::{SetupProgress, SetupResult};
use serde::Serialize;
use std::sync::Arc;
use tauri::Emitter;

/// The process-wide service, managed as Tauri state.
pub type FlowServiceState = Arc<FlowService>;

pub(crate) async fn blocking<T, F>(op: F) -> Result<T, FlowCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, FlowCommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(op)
        .await
        .map_err(|err| FlowCommandError::new(FLOW_COMMAND_FAILED, err))?
}

/// Runs `op` on the service off the async runtime.
pub(crate) async fn with_service<T, F>(
    state: tauri::State<'_, FlowServiceState>,
    op: F,
) -> Result<T, FlowCommandError>
where
    T: Send + 'static,
    F: FnOnce(&FlowService) -> Result<T, FlowCommandError> + Send + 'static,
{
    let service = state.inner().clone();
    blocking(move || op(&service)).await
}

#[tauri::command]
pub async fn flow_list(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
) -> Result<Vec<FlowSummary>, FlowCommandError> {
    with_service(state, move |s| s.list_flows(&project_root)).await
}

#[tauri::command]
pub async fn flow_load(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    path: String,
) -> Result<FlowLoadResult, FlowCommandError> {
    with_service(state, move |s| s.load_flow(&project_root, &path)).await
}

#[tauri::command]
pub async fn flow_validate(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    path: String,
    content: String,
) -> Result<FlowLoadResult, FlowCommandError> {
    with_service(state, move |s| {
        s.validate_flow(&project_root, &path, &content)
    })
    .await
}

#[tauri::command]
pub async fn flow_project_load(
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
) -> Result<ProjectLoadResult, FlowCommandError> {
    with_service(state, move |s| s.project_load(&project_root)).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupProgressPayload {
    project_root: String,
    #[serde(flatten)]
    progress: SetupProgress,
}

#[tauri::command]
pub async fn flow_project_setup(
    app: tauri::AppHandle,
    state: tauri::State<'_, FlowServiceState>,
    project_root: String,
    sha256: String,
) -> Result<SetupResult, FlowCommandError> {
    with_service(state, move |s| {
        let root = project_root.clone();
        s.project_setup(&project_root, &sha256, &move |p| {
            let payload = SetupProgressPayload {
                project_root: root.clone(),
                progress: p.clone(),
            };
            if let Err(err) = app.emit(super::flow_run::SETUP_PROGRESS_EVENT, payload) {
                eprintln!("[flow] emitting setup progress failed: {err}");
            }
        })
    })
    .await
}

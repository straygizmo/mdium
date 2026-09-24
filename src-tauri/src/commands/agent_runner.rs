// src-tauri/src/commands/agent_runner.rs
// Agent runner sidecar (Codex / Copilot) commands; plumbing lives in node_sidecar.
use super::node_sidecar;
use tauri::AppHandle;

const EVENT_PREFIX: &str = "agent-runner";

#[tauri::command]
pub fn resolve_agent_runner_path(app: AppHandle) -> Result<String, String> {
    node_sidecar::resolve_script(&app, "agent-runner", "agent-runner.mjs")
}

#[tauri::command]
pub fn spawn_agent_runner(app: AppHandle, script_path: String) -> Result<u32, String> {
    node_sidecar::spawn(app, &script_path, EVENT_PREFIX)
}

#[tauri::command]
pub fn write_agent_runner(id: u32, line: String) -> Result<(), String> {
    node_sidecar::write(id, &line)
}

#[tauri::command]
pub fn kill_agent_runner(id: u32) -> Result<(), String> {
    node_sidecar::kill(id)
}

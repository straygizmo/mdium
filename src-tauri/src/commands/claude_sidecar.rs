// src-tauri/src/commands/claude_sidecar.rs
// Claude Agent SDK sidecar commands; process plumbing lives in node_sidecar.
use super::node_sidecar;
use tauri::AppHandle;

const EVENT_PREFIX: &str = "claude-sidecar";

#[tauri::command]
pub fn resolve_claude_sidecar_path(app: AppHandle) -> Result<String, String> {
    node_sidecar::resolve_script(&app, "claude-sidecar", "claude-sidecar.cjs")
}

#[tauri::command]
pub fn spawn_claude_sidecar(app: AppHandle, script_path: String) -> Result<u32, String> {
    node_sidecar::spawn(app, &script_path, EVENT_PREFIX)
}

#[tauri::command]
pub fn write_claude_sidecar(id: u32, line: String) -> Result<(), String> {
    node_sidecar::write(id, &line)
}

#[tauri::command]
pub fn kill_claude_sidecar(id: u32) -> Result<(), String> {
    node_sidecar::kill(id)
}

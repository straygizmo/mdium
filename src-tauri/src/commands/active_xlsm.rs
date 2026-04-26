use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::http_bridge::{HttpBridgeInfo, HttpBridgeState};
use serde::Serialize;

/// Shared state tracking which xlsm is currently previewed in the active tab.
/// `None` means the active tab is not an xlsm/xlam (or no tab is active).
pub type ActiveXlsmState = Arc<Mutex<Option<PathBuf>>>;

pub fn new_state() -> ActiveXlsmState {
    Arc::new(Mutex::new(None))
}

#[tauri::command]
pub fn set_active_xlsm_path(
    path: Option<String>,
    state: State<'_, ActiveXlsmState>,
) -> Result<(), String> {
    let mut guard = state
        .lock()
        .map_err(|e| format!("Failed to lock active xlsm state: {}", e))?;
    *guard = path.map(PathBuf::from);
    Ok(())
}

#[tauri::command]
pub fn get_active_xlsm_path(
    state: State<'_, ActiveXlsmState>,
) -> Result<Option<String>, String> {
    let guard = state
        .lock()
        .map_err(|e| format!("Failed to lock active xlsm state: {}", e))?;
    Ok(guard.as_ref().map(|p| p.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpBridgeClientInfo {
    pub port: u16,
    pub token: String,
}

#[tauri::command]
pub fn get_http_bridge_info(
    state: State<'_, HttpBridgeState>,
) -> Result<Option<HttpBridgeClientInfo>, String> {
    let guard = state
        .lock()
        .map_err(|e| format!("Failed to lock HTTP bridge state: {}", e))?;
    Ok(guard.as_ref().map(|info: &HttpBridgeInfo| HttpBridgeClientInfo {
        port: info.port,
        token: info.token.clone(),
    }))
}

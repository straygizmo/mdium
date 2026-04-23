use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

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

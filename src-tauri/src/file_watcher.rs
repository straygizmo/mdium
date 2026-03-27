use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub struct FileWatcherState {
    watcher: Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>,
    watched_path: Option<PathBuf>,
}

impl FileWatcherState {
    pub fn new() -> Self {
        Self {
            watcher: None,
            watched_path: None,
        }
    }
}

pub struct FolderWatcherState {
    watchers: HashMap<PathBuf, notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>,
}

impl FolderWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: HashMap::new(),
        }
    }
}

#[tauri::command]
pub fn watch_file(
    app: AppHandle,
    state: State<'_, Arc<Mutex<FileWatcherState>>>,
    file_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err("File does not exist".to_string());
    }

    let mut fw = state.lock().map_err(|e| e.to_string())?;

    // If already watching this path, do nothing
    if let Some(ref watched) = fw.watched_path {
        if watched == &path {
            return Ok(());
        }
    }

    // Stop previous watcher
    fw.watcher = None;
    fw.watched_path = None;

    let watched_path = path.clone();
    let app_clone = app.clone();

    let mut debouncer = new_debouncer(Duration::from_millis(500), move |res: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
        if let Ok(events) = res {
            for event in events {
                if event.kind == DebouncedEventKind::Any {
                    let changed_path = event.path.to_string_lossy().to_string();
                    let _ = app_clone.emit("file-changed", changed_path);
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&path, notify::RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    fw.watcher = Some(debouncer);
    fw.watched_path = Some(watched_path);

    Ok(())
}

#[tauri::command]
pub fn unwatch_file(
    state: State<'_, Arc<Mutex<FileWatcherState>>>,
) -> Result<(), String> {
    let mut fw = state.lock().map_err(|e| e.to_string())?;
    fw.watcher = None;
    fw.watched_path = None;
    Ok(())
}

#[tauri::command]
pub fn watch_folder(
    app: AppHandle,
    state: State<'_, Arc<Mutex<FolderWatcherState>>>,
    folder_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(&folder_path);
    if !path.is_dir() {
        return Err("Folder does not exist".to_string());
    }

    let mut fw = state.lock().map_err(|e| e.to_string())?;

    // Already watching this folder
    if fw.watchers.contains_key(&path) {
        return Ok(());
    }

    let folder_path_str = folder_path.clone();
    let app_clone = app.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(800),
        move |res: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
            if let Ok(events) = res {
                if events.iter().any(|e| e.kind == DebouncedEventKind::Any) {
                    let _ = app_clone.emit("folder-changed", folder_path_str.clone());
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&path, notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    fw.watchers.insert(path, debouncer);
    Ok(())
}

#[tauri::command]
pub fn unwatch_folder(
    state: State<'_, Arc<Mutex<FolderWatcherState>>>,
    folder_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(&folder_path);
    let mut fw = state.lock().map_err(|e| e.to_string())?;
    fw.watchers.remove(&path);
    Ok(())
}

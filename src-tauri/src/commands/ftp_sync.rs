//! Local mirrors of FTP folders.
//!
//! Opening an FTP folder downloads it into a local directory (the mirror)
//! that the whole app, agents, RAG and converters use like any local folder.
//! Local changes are uploaded automatically (watched with `notify`); server
//! changes are pulled on open, on refresh and every few minutes. Deletions
//! made locally are only applied to the server after the user approves them,
//! and conflicting edits are never resolved automatically.
//!
//! The state of the last sync is kept per mirror in a manifest outside the
//! mirror tree. [`plan`] compares it with the current server and local
//! listings and decides what to do; it does no I/O so every case is unit
//! tested.

use crate::commands::ftp::{self, RemotePath};
use notify_debouncer_mini::new_debouncer;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use suppaftp::NativeTlsFtpStream;
use tauri::{AppHandle, Emitter};

/// Directories that are never synced in either direction (local data such
/// as the RAG index and converted Markdown live in `.mdium`).
const EXCLUDED_DIRS: &[&str] = &[".mdium", ".git", "node_modules"];
const DOWNLOAD_SUFFIX: &str = ".mdium-dl";
const UPLOAD_SUFFIX: &str = ".mdium-tmp";
const CONFLICT_MARKER: &str = ".remote-";
const PULL_INTERVAL: Duration = Duration::from_secs(5 * 60);
const WATCH_DEBOUNCE: Duration = Duration::from_millis(1500);
const STATUS_EVENT: &str = "ftp-sync-status";
const MAX_FILE_ERRORS: usize = 20;

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/// Whether a conflict copy name like `a.remote-20261029-101500.md`.
fn is_conflict_copy(name: &str) -> bool {
    let Some(i) = name.find(CONFLICT_MARKER) else { return false };
    let stamp = &name[i + CONFLICT_MARKER.len()..];
    let bytes = stamp.as_bytes();
    bytes.len() >= 15
        && bytes[..8].iter().all(u8::is_ascii_digit)
        && bytes[8] == b'-'
        && bytes[9..15].iter().all(u8::is_ascii_digit)
}

/// Whether a relative path (with `/` separators) is left out of syncing.
pub fn is_excluded(rel: &str) -> bool {
    let mut parts = rel.split('/').peekable();
    while let Some(part) = parts.next() {
        let is_last = parts.peek().is_none();
        if EXCLUDED_DIRS.contains(&part) && !is_last {
            return true;
        }
        if is_last {
            return EXCLUDED_DIRS.contains(&part)
                || part.starts_with("~$")
                || part.ends_with(DOWNLOAD_SUFFIX)
                || part.ends_with(UPLOAD_SUFFIX)
                || is_conflict_copy(part);
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Manifest and planning
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteStamp {
    pub modified: Option<i64>,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalStamp {
    pub mtime_ms: u64,
    pub size: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    /// Changed on both sides since the last sync.
    BothChanged,
    /// Created on both sides with no common version.
    BothNew,
    /// Deleted on the server while changed locally.
    RemoteDeleted,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    /// Server version at the last sync.
    pub remote: Option<RemoteStamp>,
    /// Local version at the last sync.
    pub local: Option<LocalStamp>,
    /// Deleted locally; waiting for the user to approve the server deletion.
    pub pending_delete: bool,
    pub conflict: Option<ConflictKind>,
    /// Relative path of the server copy saved next to a conflicting file.
    pub conflict_copy: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Manifest {
    pub entries: BTreeMap<String, Entry>,
}

/// A local file as scanned now. `hash` is only computed when size or mtime
/// differ from the manifest, so unchanged files are never re-read.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalState {
    pub mtime_ms: u64,
    pub size: u64,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Download(String),
    Upload(String),
    /// Deleted on the server and unchanged locally: move the local file to
    /// the recycle bin.
    TrashLocal(String),
    /// Deleted locally: ask before deleting it on the server.
    MarkPendingDelete(String),
    Conflict(String, ConflictKind),
    /// Gone on both sides.
    Forget(String),
    /// Only the mtime moved (same content), or a pending deletion was undone
    /// by restoring the file: record the local stamp.
    RefreshLocal(String),
}

#[derive(Debug, PartialEq)]
enum LocalChange {
    Unchanged,
    Touched,
    Changed,
}

fn local_change(known: Option<&LocalStamp>, now: &LocalState) -> LocalChange {
    match known {
        None => LocalChange::Changed,
        Some(k) if k.size == now.size && k.mtime_ms == now.mtime_ms => LocalChange::Unchanged,
        Some(k) if now.hash.as_deref() == Some(k.hash.as_str()) => LocalChange::Touched,
        Some(_) => LocalChange::Changed,
    }
}

/// Decide what to do for every path. `remote` is the current server listing,
/// or `None` for a push (only local changes are looked at; the server is
/// assumed to still match the manifest).
pub fn plan(
    manifest: &Manifest,
    remote: Option<&BTreeMap<String, RemoteStamp>>,
    local: &BTreeMap<String, LocalState>,
) -> Vec<Action> {
    let mut paths: BTreeSet<&String> = manifest.entries.keys().chain(local.keys()).collect();
    if let Some(r) = remote {
        paths.extend(r.keys());
    }
    let mut actions = Vec::new();
    for path in paths {
        let entry = manifest.entries.get(path);
        let l = local.get(path);
        let r = match remote {
            Some(map) => map.get(path),
            None => entry.and_then(|e| e.remote.as_ref()),
        };
        if let Some(e) = entry {
            if e.conflict.is_some() || (e.pending_delete && l.is_none()) {
                continue;
            }
        }
        let p = path.clone();
        let action = match entry {
            Some(e) => {
                let remote_changed = e.remote.as_ref() != r;
                match (r, l) {
                    (Some(_), Some(l)) => match (remote_changed, local_change(e.local.as_ref(), l)) {
                        (false, LocalChange::Unchanged) => None,
                        (false, LocalChange::Touched) => Some(Action::RefreshLocal(p)),
                        (false, LocalChange::Changed) => Some(Action::Upload(p)),
                        (true, LocalChange::Changed) => Some(Action::Conflict(p, ConflictKind::BothChanged)),
                        (true, _) => Some(Action::Download(p)),
                    },
                    (None, Some(l)) => match local_change(e.local.as_ref(), l) {
                        LocalChange::Changed => Some(Action::Conflict(p, ConflictKind::RemoteDeleted)),
                        _ => Some(Action::TrashLocal(p)),
                    },
                    (Some(_), None) if remote_changed => Some(Action::Download(p)),
                    (Some(_), None) => Some(Action::MarkPendingDelete(p)),
                    (None, None) => Some(Action::Forget(p)),
                }
                .or_else(|| e.pending_delete.then(|| Action::RefreshLocal(path.clone())))
            }
            None => match (r, l) {
                (Some(_), Some(_)) => Some(Action::Conflict(p, ConflictKind::BothNew)),
                (Some(_), None) => Some(Action::Download(p)),
                (None, Some(_)) => Some(Action::Upload(p)),
                (None, None) => None,
            },
        };
        actions.extend(action);
    }
    actions
}

// ---------------------------------------------------------------------------
// Mirror registry: ftp:// URI <-> local directory
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorInfo {
    pub uri: String,
    pub root: String,
}

fn mirrors_base() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("mdium")
        .join("ftp")
}

fn registry_path() -> PathBuf {
    mirrors_base().join("mirrors.json")
}

fn registry() -> &'static Mutex<Option<BTreeMap<String, String>>> {
    static REGISTRY: OnceLock<Mutex<Option<BTreeMap<String, String>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(None))
}

fn with_registry<R>(f: impl FnOnce(&mut BTreeMap<String, String>) -> R) -> R {
    let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(|| {
        fs::read_to_string(registry_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    });
    f(map)
}

fn sanitize_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*@".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() { "ftp".to_string() } else { trimmed.to_string() }
}

/// `<base>/<host>-<hash>/<remote folder name>`: short enough to stay clear of
/// MAX_PATH for agents and tools, readable in the folder tab.
fn new_mirror_root(uri: &str) -> Result<PathBuf, String> {
    let rp = RemotePath::parse(uri)?;
    let host = rp.authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(&rp.authority);
    let host = host.split(':').next().unwrap_or(host);
    let digest = Sha256::digest(uri.as_bytes());
    let hash: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    let leaf = if rp.path == "/" { host.to_string() } else { rp.name().to_string() };
    Ok(mirrors_base()
        .join(format!("{}-{hash}", sanitize_component(host)))
        .join(sanitize_component(&leaf)))
}

fn register_mirror(uri: &str) -> Result<PathBuf, String> {
    if let Some(root) = with_registry(|m| m.get(uri).cloned()) {
        return Ok(PathBuf::from(root));
    }
    let root = new_mirror_root(uri)?;
    with_registry(|m| {
        m.insert(uri.to_string(), root.to_string_lossy().to_string());
        save_registry(m)
    })?;
    Ok(root)
}

fn save_registry(map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = registry_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Failed to save FTP mirrors: {e}"))
}

fn uri_for_root(root: &str) -> Option<String> {
    with_registry(|m| m.iter().find(|(_, r)| r.as_str() == root).map(|(u, _)| u.clone()))
}

fn manifest_path(root: &Path) -> PathBuf {
    // Next to the mirror, not inside it, so agents never see it.
    root.parent().unwrap_or(root).join("manifest.json")
}

fn load_manifest(path: &Path) -> Manifest {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_manifest(path: &Path, manifest: &Manifest) -> Result<(), String> {
    let json = serde_json::to_string(manifest).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("Failed to save the sync manifest: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("Failed to save the sync manifest: {e}"))
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hash_bytes(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

fn local_path(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

fn scan_local(root: &Path, manifest: &Manifest) -> BTreeMap<String, LocalState> {
    fn walk(root: &Path, dir: &Path, prefix: &str, manifest: &Manifest, out: &mut BTreeMap<String, LocalState>) {
        let Ok(read_dir) = fs::read_dir(dir) else { return };
        for item in read_dir.flatten() {
            let Ok(file_type) = item.file_type() else { continue };
            if file_type.is_symlink() {
                continue;
            }
            let name = item.file_name().to_string_lossy().to_string();
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if is_excluded(&rel) {
                continue;
            }
            let path = item.path();
            if file_type.is_dir() {
                walk(root, &path, &rel, manifest, out);
                continue;
            }
            let Ok(meta) = item.metadata() else { continue };
            let (mtime_ms, size) = (mtime_ms(&meta), meta.len());
            let known = manifest.entries.get(&rel).and_then(|e| e.local.as_ref());
            let same = known.is_some_and(|k| k.size == size && k.mtime_ms == mtime_ms);
            // Unreadable (e.g. still being written): treated as changed and
            // retried on the next pass.
            let hash = if same { None } else { fs::read(&path).ok().map(|d| hash_bytes(&d)) };
            out.insert(rel, LocalState { mtime_ms, size, hash });
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, "", manifest, &mut out);
    out
}

fn scan_remote(s: &mut NativeTlsFtpStream, root: &str) -> Result<BTreeMap<String, RemoteStamp>, String> {
    fn walk(
        s: &mut NativeTlsFtpStream,
        dir: &str,
        prefix: &str,
        depth: u32,
        out: &mut BTreeMap<String, RemoteStamp>,
    ) -> Result<(), String> {
        if depth > 32 {
            return Ok(());
        }
        for item in ftp::list_raw(s, dir)? {
            let rel = if prefix.is_empty() { item.name.clone() } else { format!("{prefix}/{}", item.name) };
            if is_excluded(&rel) {
                continue;
            }
            if item.is_dir {
                walk(s, &ftp::join_remote(dir, &item.name), &rel, depth + 1, out)?;
            } else {
                out.insert(rel, RemoteStamp { modified: item.modified, size: item.size });
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(s, root, "", 0, &mut out)?;
    Ok(out)
}

/// Current server stamp of one file, taken from its directory listing so it
/// is comparable with the stamps of a full scan.
fn remote_stat(s: &mut NativeTlsFtpStream, remote_path: &str) -> Result<Option<RemoteStamp>, String> {
    let (dir, name) = match remote_path.rsplit_once('/') {
        Some(("", name)) => ("/", name),
        Some((dir, name)) => (dir, name),
        None => ("/", remote_path),
    };
    if s.cwd(dir).is_err() {
        return Ok(None);
    }
    let _ = s.cwd("/");
    Ok(ftp::list_raw(s, dir)?
        .into_iter()
        .find(|e| e.name == name && !e.is_dir)
        .map(|e| RemoteStamp { modified: e.modified, size: e.size }))
}

// ---------------------------------------------------------------------------
// Runtime per open mirror
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub path: String,
    pub kind: ConflictKind,
    pub copy: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub root: String,
    pub uri: String,
    pub syncing: bool,
    /// Unix milliseconds of the last successful sync.
    pub last_sync: Option<u64>,
    pub error: Option<String>,
    pub file_errors: Vec<String>,
    pub conflicts: Vec<ConflictInfo>,
    pub pending_deletes: Vec<String>,
    pub progress: Option<Progress>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    Pull,
    Push,
}

struct Runtime {
    root: PathBuf,
    remote: RemotePath,
    manifest_path: PathBuf,
    manifest: Mutex<Manifest>,
    job: Mutex<()>,
    rerun: AtomicBool,
    stop: AtomicBool,
    status: Mutex<SyncStatus>,
    watcher: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
}

fn runtimes() -> &'static Mutex<HashMap<String, Arc<Runtime>>> {
    static RUNTIMES: OnceLock<Mutex<HashMap<String, Arc<Runtime>>>> = OnceLock::new();
    RUNTIMES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn app_handle() -> &'static OnceLock<AppHandle> {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    &APP
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Runtime {
    fn root_key(&self) -> String {
        self.root.to_string_lossy().to_string()
    }

    fn remote_path(&self, rel: &str) -> String {
        if self.remote.path == "/" {
            format!("/{rel}")
        } else {
            format!("{}/{rel}", self.remote.path)
        }
    }

    fn emit(&self) {
        let status = self.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(app) = app_handle().get() {
            let _ = app.emit(STATUS_EVENT, status);
        }
    }

    fn update_status(&self, f: impl FnOnce(&mut SyncStatus)) {
        f(&mut self.status.lock().unwrap_or_else(|e| e.into_inner()));
        self.emit();
    }

    /// Refresh the conflict / pending-deletion lists from the manifest.
    fn sync_lists(&self) {
        let manifest = self.manifest.lock().unwrap_or_else(|e| e.into_inner());
        let conflicts = manifest
            .entries
            .iter()
            .filter_map(|(path, e)| {
                e.conflict.map(|kind| ConflictInfo { path: path.clone(), kind, copy: e.conflict_copy.clone() })
            })
            .collect();
        let pending = manifest
            .entries
            .iter()
            .filter(|(_, e)| e.pending_delete)
            .map(|(p, _)| p.clone())
            .collect();
        drop(manifest);
        self.update_status(|s| {
            s.conflicts = conflicts;
            s.pending_deletes = pending;
        });
    }

    fn status(&self) -> SyncStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

fn start_runtime(uri: &str, root: PathBuf) -> Result<Arc<Runtime>, String> {
    let key = root.to_string_lossy().to_string();
    if let Some(rt) = runtimes().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Ok(rt.clone());
    }
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create the local mirror: {e}"))?;
    let manifest_path = manifest_path(&root);
    let rt = Arc::new(Runtime {
        remote: RemotePath::parse(uri)?,
        manifest: Mutex::new(load_manifest(&manifest_path)),
        manifest_path,
        root: root.clone(),
        job: Mutex::new(()),
        rerun: AtomicBool::new(false),
        stop: AtomicBool::new(false),
        status: Mutex::new(SyncStatus { root: key.clone(), uri: uri.to_string(), ..Default::default() }),
        watcher: Mutex::new(None),
    });
    rt.sync_lists();

    // Local changes: push after the writes settle.
    let weak = Arc::downgrade(&rt);
    let watch_root = root.clone();
    let mut debouncer = new_debouncer(WATCH_DEBOUNCE, move |res: notify_debouncer_mini::DebounceEventResult| {
        let Ok(events) = res else { return };
        let relevant = events.iter().any(|ev| {
            ev.path
                .strip_prefix(&watch_root)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .is_some_and(|rel| !rel.is_empty() && !is_excluded(&rel))
        });
        if relevant {
            if let Some(rt) = weak.upgrade() {
                rt.rerun.store(true, Ordering::SeqCst);
                std::thread::spawn(move || run_queued_push(&rt));
            }
        }
    })
    .map_err(|e| format!("Failed to watch the local mirror: {e}"))?;
    debouncer
        .watcher()
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch the local mirror: {e}"))?;
    *rt.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(debouncer);

    // Server changes: pull periodically while the mirror is open.
    let weak = Arc::downgrade(&rt);
    std::thread::spawn(move || {
        let mut last = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let Some(rt) = weak.upgrade() else { return };
            if rt.stop.load(Ordering::SeqCst) {
                return;
            }
            if last.elapsed() >= PULL_INTERVAL {
                let _ = run_job(&rt, Mode::Pull);
                last = Instant::now();
            }
        }
    });

    runtimes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, rt.clone());
    Ok(rt)
}

fn stop_runtime(root: &str) {
    if let Some(rt) = runtimes().lock().unwrap_or_else(|e| e.into_inner()).remove(root) {
        rt.stop.store(true, Ordering::SeqCst);
        rt.watcher.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

/// Push queued by the watcher. Skips when a job is running: that job sees
/// `rerun` and pushes again before it releases the lock.
fn run_queued_push(rt: &Arc<Runtime>) {
    loop {
        {
            let Ok(_guard) = rt.job.try_lock() else { return };
            while rt.rerun.swap(false, Ordering::SeqCst) {
                let result = sync_once(rt, Mode::Push);
                finish(rt, result);
            }
        }
        // A trigger may have arrived after the last check, before unlock.
        if !rt.rerun.load(Ordering::SeqCst) {
            return;
        }
    }
}

/// Run one sync, waiting for a running one to finish first.
fn run_job(rt: &Arc<Runtime>, mode: Mode) -> Result<(), String> {
    let _guard = rt.job.lock().unwrap_or_else(|e| e.into_inner());
    rt.rerun.store(false, Ordering::SeqCst);
    let result = sync_once(rt, mode);
    finish(rt, result.clone());
    if rt.rerun.swap(false, Ordering::SeqCst) {
        let again = sync_once(rt, Mode::Push);
        finish(rt, again);
    }
    result
}

fn finish(rt: &Runtime, result: Result<(), String>) {
    rt.sync_lists();
    rt.update_status(|s| {
        s.syncing = false;
        s.progress = None;
        match &result {
            Ok(()) => {
                s.error = None;
                s.last_sync = Some(now_ms());
            }
            Err(e) => s.error = Some(e.clone()),
        }
    });
}

fn conflict_copy_name(rel: &str) -> String {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let (dir, name) = match rel.rsplit_once('/') {
        Some((d, n)) => (Some(d), n),
        None => (None, rel),
    };
    let copy = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}{CONFLICT_MARKER}{stamp}.{ext}"),
        _ => format!("{name}{CONFLICT_MARKER}{stamp}"),
    };
    match dir {
        Some(d) => format!("{d}/{copy}"),
        None => copy,
    }
}

/// Write a downloaded file through a temporary name so the watcher and other
/// readers never see a partial file. Returns the local stamp.
fn write_local(root: &Path, rel: &str, data: &[u8]) -> Result<LocalStamp, String> {
    let path = local_path(root, rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{rel}: {e}"))?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}{DOWNLOAD_SUFFIX}"));
    fs::write(&tmp, data).map_err(|e| format!("{rel}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{rel}: {e}")
    })?;
    let meta = fs::metadata(&path).map_err(|e| format!("{rel}: {e}"))?;
    Ok(LocalStamp { mtime_ms: mtime_ms(&meta), size: meta.len(), hash: hash_bytes(data) })
}

fn download(rt: &Runtime, s: &mut NativeTlsFtpStream, rel: &str) -> Result<(RemoteStamp, LocalStamp), String> {
    let remote_path = rt.remote_path(rel);
    let data = s
        .retr_as_buffer(&remote_path)
        .map_err(|e| format!("{rel}: download failed: {e}"))?
        .into_inner();
    let local = write_local(&rt.root, rel, &data)?;
    let remote = remote_stat(s, &remote_path)?
        .unwrap_or(RemoteStamp { modified: None, size: data.len() as u64 });
    Ok((remote, local))
}

/// Outcome of trying to upload one file.
enum Uploaded {
    Done(RemoteStamp, LocalStamp),
    /// The server copy changed (or appeared) since the last sync.
    Conflict(ConflictKind),
}

fn upload(
    rt: &Runtime,
    s: &mut NativeTlsFtpStream,
    rel: &str,
    expected: Option<&RemoteStamp>,
    force: bool,
) -> Result<Uploaded, String> {
    let path = local_path(&rt.root, rel);
    // Stamp before reading: a write that lands after this is seen next time.
    let meta = fs::metadata(&path).map_err(|e| format!("{rel}: {e}"))?;
    let data = fs::read(&path).map_err(|e| format!("{rel}: {e}"))?;
    let local = LocalStamp { mtime_ms: mtime_ms(&meta), size: meta.len(), hash: hash_bytes(&data) };
    let remote_path = rt.remote_path(rel);
    if !force {
        let now = remote_stat(s, &remote_path)?;
        match (expected, &now) {
            (None, Some(_)) => return Ok(Uploaded::Conflict(ConflictKind::BothNew)),
            (Some(_), None) => return Ok(Uploaded::Conflict(ConflictKind::RemoteDeleted)),
            (Some(e), Some(n)) if e != n => return Ok(Uploaded::Conflict(ConflictKind::BothChanged)),
            _ => {}
        }
    }
    let rp = RemotePath { authority: rt.remote.authority.clone(), path: remote_path.clone() };
    ftp::ensure_remote_dir(s, &rp.parent().path)?;
    ftp::put_atomic(s, &rp, &data).map_err(|e| format!("{rel}: {e}"))?;
    let remote = remote_stat(s, &remote_path)?
        .unwrap_or(RemoteStamp { modified: None, size: data.len() as u64 });
    Ok(Uploaded::Done(remote, local))
}

/// Mark `rel` as conflicting; the server version (if any) is saved next to
/// it so both can be compared.
fn record_conflict(
    rt: &Runtime,
    s: &mut NativeTlsFtpStream,
    manifest: &mut Manifest,
    rel: &str,
    kind: ConflictKind,
) -> Result<(), String> {
    let mut copy = None;
    let mut remote = None;
    if kind != ConflictKind::RemoteDeleted {
        let remote_path = rt.remote_path(rel);
        let data = s
            .retr_as_buffer(&remote_path)
            .map_err(|e| format!("{rel}: download failed: {e}"))?
            .into_inner();
        let copy_rel = conflict_copy_name(rel);
        write_local(&rt.root, &copy_rel, &data)?;
        copy = Some(copy_rel);
        remote = remote_stat(s, &remote_path)?;
    }
    let entry = manifest.entries.entry(rel.to_string()).or_default();
    entry.conflict = Some(kind);
    entry.conflict_copy = copy;
    entry.pending_delete = false;
    if remote.is_some() || kind == ConflictKind::RemoteDeleted {
        entry.remote = remote;
    }
    Ok(())
}

fn trash_local(root: &Path, rel: &str) -> Result<(), String> {
    let path = local_path(root, rel);
    if !path.exists() {
        return Ok(());
    }
    trash::delete(&path)
        .or_else(|_| fs::remove_file(&path).map_err(|e| e.to_string()))
        .map_err(|e| format!("{rel}: {e}"))
}

fn sync_once(rt: &Runtime, mode: Mode) -> Result<(), String> {
    rt.update_status(|s| {
        s.syncing = true;
        s.file_errors.clear();
    });
    let mut manifest = rt.manifest.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let remote = match mode {
        Mode::Pull => Some(ftp::with_session(&rt.remote.authority, |s| scan_remote(s, &rt.remote.path))?),
        Mode::Push => None,
    };
    let local = scan_local(&rt.root, &manifest);
    let actions = plan(&manifest, remote.as_ref(), &local);
    if actions.is_empty() {
        return Ok(());
    }

    let total = actions.len();
    let mut file_errors = Vec::new();
    let mut failures = 0usize;
    let mut last_progress = Instant::now();
    for (i, action) in actions.into_iter().enumerate() {
        if last_progress.elapsed() > Duration::from_millis(200) {
            rt.update_status(|s| s.progress = Some(Progress { done: i, total }));
            last_progress = Instant::now();
        }
        let result = match &action {
            Action::Download(rel) => ftp::with_session(&rt.remote.authority, |s| download(rt, s, rel)).map(
                |(remote, local)| {
                    let e = manifest.entries.entry(rel.clone()).or_default();
                    e.remote = Some(remote);
                    e.local = Some(local);
                    e.pending_delete = false;
                },
            ),
            Action::Upload(rel) => {
                let expected = manifest.entries.get(rel).and_then(|e| e.remote.clone());
                ftp::with_session(&rt.remote.authority, |s| {
                    match upload(rt, s, rel, expected.as_ref(), false)? {
                        Uploaded::Done(remote, local) => {
                            let e = manifest.entries.entry(rel.clone()).or_default();
                            e.remote = Some(remote);
                            e.local = Some(local);
                            e.pending_delete = false;
                            Ok(())
                        }
                        Uploaded::Conflict(kind) => record_conflict(rt, s, &mut manifest, rel, kind),
                    }
                })
            }
            Action::Conflict(rel, kind) => {
                ftp::with_session(&rt.remote.authority, |s| record_conflict(rt, s, &mut manifest, rel, *kind))
            }
            Action::TrashLocal(rel) => trash_local(&rt.root, rel).map(|()| {
                manifest.entries.remove(rel);
            }),
            Action::MarkPendingDelete(rel) => {
                manifest.entries.entry(rel.clone()).or_default().pending_delete = true;
                Ok(())
            }
            Action::Forget(rel) => {
                manifest.entries.remove(rel);
                Ok(())
            }
            Action::RefreshLocal(rel) => {
                let e = manifest.entries.entry(rel.clone()).or_default();
                if let (Some(now), Some(hash)) = (local.get(rel), local.get(rel).and_then(|l| l.hash.clone())) {
                    e.local = Some(LocalStamp { mtime_ms: now.mtime_ms, size: now.size, hash });
                }
                e.pending_delete = false;
                Ok(())
            }
        };
        if let Err(e) = result {
            failures += 1;
            if file_errors.len() < MAX_FILE_ERRORS {
                file_errors.push(e);
            }
        }
        if i % 25 == 24 {
            let _ = save_manifest(&rt.manifest_path, &manifest);
        }
    }
    save_manifest(&rt.manifest_path, &manifest)?;
    *rt.manifest.lock().unwrap_or_else(|e| e.into_inner()) = manifest;
    // Nothing went through (typically offline): report it as a failed sync
    // instead of a successful one with per-file errors.
    let first_error = (failures == total).then(|| file_errors.first().cloned()).flatten();
    rt.update_status(|s| s.file_errors = file_errors);
    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// User decision on a conflict or a pending deletion.
fn resolve(rt: &Arc<Runtime>, rel: &str, action: &str) -> Result<(), String> {
    let _guard = rt.job.lock().unwrap_or_else(|e| e.into_inner());
    let mut manifest = rt.manifest.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let entry = manifest.entries.get(rel).cloned().unwrap_or_default();
    let authority = rt.remote.authority.clone();
    match action {
        // Conflicts: keep the local file and overwrite the server, or the reverse.
        "keepLocal" => {
            let uploaded = ftp::with_session(&authority, |s| upload(rt, s, rel, None, true))?;
            if let Uploaded::Done(remote, local) = uploaded {
                manifest.entries.insert(rel.to_string(), Entry { remote: Some(remote), local: Some(local), ..Default::default() });
            }
        }
        "useRemote" if entry.conflict == Some(ConflictKind::RemoteDeleted) => {
            trash_local(&rt.root, rel)?;
            manifest.entries.remove(rel);
        }
        "useRemote" | "restore" => {
            let (remote, local) = ftp::with_session(&authority, |s| download(rt, s, rel))?;
            manifest.entries.insert(rel.to_string(), Entry { remote: Some(remote), local: Some(local), ..Default::default() });
        }
        // Pending deletion: apply it on the server.
        "approveDelete" => {
            let remote_path = rt.remote_path(rel);
            ftp::with_session(&authority, |s| {
                if remote_stat(s, &remote_path)?.is_some() {
                    s.rm(&remote_path).map_err(|e| format!("{rel}: delete failed: {e}"))?;
                }
                Ok(())
            })?;
            manifest.entries.remove(rel);
        }
        other => return Err(format!("Unknown action: {other}")),
    }
    if let Some(copy) = &entry.conflict_copy {
        let _ = fs::remove_file(local_path(&rt.root, copy));
    }
    save_manifest(&rt.manifest_path, &manifest)?;
    *rt.manifest.lock().unwrap_or_else(|e| e.into_inner()) = manifest;
    rt.sync_lists();
    Ok(())
}

fn runtime_for(root: &str) -> Result<Arc<Runtime>, String> {
    runtimes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(root)
        .cloned()
        .ok_or_else(|| format!("FTP mirror is not open: {root}"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Create or reuse the local mirror of `uri`, bring it up to date and keep
/// it synced. Returns the local folder to open.
#[tauri::command]
pub async fn ftp_mirror_open(app: AppHandle, uri: String) -> Result<String, String> {
    let _ = app_handle().set(app);
    ftp::run(move || {
        let known = with_registry(|m| m.contains_key(&uri));
        let root = register_mirror(&uri)?;
        let rt = start_runtime(&uri, root)?;
        // An existing mirror still opens offline: its files are local, the
        // badge shows the error and the next edit or timer retries.
        if let Err(e) = run_job(&rt, Mode::Pull) {
            if !known {
                return Err(e);
            }
        }
        Ok(rt.root_key())
    })
    .await
}

/// Known mirrors (URI and local folder).
#[tauri::command]
pub async fn ftp_mirror_list() -> Result<Vec<MirrorInfo>, String> {
    ftp::run(|| {
        Ok(with_registry(|m| {
            m.iter().map(|(uri, root)| MirrorInfo { uri: uri.clone(), root: root.clone() }).collect()
        }))
    })
    .await
}

/// Start syncing a mirror folder that is open in the app (e.g. restored on
/// startup). Returns at once; the first pull runs in the background.
#[tauri::command]
pub async fn ftp_mirror_start(app: AppHandle, root: String) -> Result<(), String> {
    let _ = app_handle().set(app);
    ftp::run(move || {
        let uri = uri_for_root(&root).ok_or_else(|| format!("Not an FTP mirror: {root}"))?;
        let already = runtimes().lock().unwrap_or_else(|e| e.into_inner()).contains_key(&root);
        let rt = start_runtime(&uri, PathBuf::from(&root))?;
        if !already {
            std::thread::spawn(move || {
                let _ = run_job(&rt, Mode::Pull);
            });
        }
        Ok(())
    })
    .await
}

/// Stop syncing a mirror whose folder was closed.
#[tauri::command]
pub async fn ftp_mirror_stop(root: String) -> Result<(), String> {
    ftp::run(move || {
        stop_runtime(&root);
        Ok(())
    })
    .await
}

/// Pull now (refresh button) and return the resulting status.
#[tauri::command]
pub async fn ftp_mirror_sync(root: String) -> Result<SyncStatus, String> {
    ftp::run(move || {
        let rt = runtime_for(&root)?;
        let _ = run_job(&rt, Mode::Pull);
        Ok(rt.status())
    })
    .await
}

#[tauri::command]
pub async fn ftp_mirror_status(root: String) -> Result<Option<SyncStatus>, String> {
    ftp::run(move || Ok(runtime_for(&root).ok().map(|rt| rt.status()))).await
}

/// Resolve a conflict (`keepLocal` / `useRemote`) or a pending deletion
/// (`approveDelete` / `restore`).
#[tauri::command]
pub async fn ftp_mirror_resolve(root: String, path: String, action: String) -> Result<SyncStatus, String> {
    ftp::run(move || {
        let rt = runtime_for(&root)?;
        resolve(&rt, &path, &action)?;
        Ok(rt.status())
    })
    .await
}

/// Changes in a mirror that have not reached the server yet.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorPending {
    /// New or changed local files not uploaded.
    pub uploads: usize,
    /// Local deletions not applied on the server (pending or not yet noticed).
    pub deletes: usize,
    pub conflicts: usize,
}

impl MirrorPending {
    fn total(&self) -> usize {
        self.uploads + self.deletes + self.conflicts
    }
}

fn pending_counts(root: &Path, manifest: &Manifest) -> MirrorPending {
    let local = scan_local(root, manifest);
    let mut pending = MirrorPending {
        deletes: manifest.entries.values().filter(|e| e.pending_delete).count(),
        conflicts: manifest.entries.values().filter(|e| e.conflict.is_some()).count(),
        ..Default::default()
    };
    for action in plan(manifest, None, &local) {
        match action {
            Action::Upload(_) => pending.uploads += 1,
            Action::MarkPendingDelete(_) => pending.deletes += 1,
            Action::Conflict(..) => pending.conflicts += 1,
            _ => {}
        }
    }
    pending
}

/// Delete a mirror (its folder, manifest and registry entry). Refused while
/// it still holds changes that have not reached the server.
fn remove_mirror(root: &str) -> Result<(), String> {
    let uri = uri_for_root(root).ok_or_else(|| format!("Not an FTP mirror: {root}"))?;
    let root_path = PathBuf::from(root);
    let base = root_path.parent().map(Path::to_path_buf).unwrap_or_default();
    // Only ever delete a per-mirror folder under our own base directory.
    let mirrors = mirrors_base();
    if !base.starts_with(&mirrors) || base == mirrors {
        return Err(format!("Refusing to delete {}", base.display()));
    }
    let runtime = runtimes().lock().unwrap_or_else(|e| e.into_inner()).remove(root);
    let _guard;
    let manifest = match &runtime {
        Some(rt) => {
            rt.stop.store(true, Ordering::SeqCst);
            rt.watcher.lock().unwrap_or_else(|e| e.into_inner()).take();
            // Wait for a running sync and keep others out while deleting.
            _guard = rt.job.lock().unwrap_or_else(|e| e.into_inner());
            rt.manifest.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
        None => load_manifest(&manifest_path(&root_path)),
    };
    let pending = pending_counts(&root_path, &manifest);
    if pending.total() > 0 {
        return Err(format!("The mirror has unsynced changes: {pending:?}"));
    }
    if base.exists() {
        fs::remove_dir_all(&base)
            .map_err(|e| format!("Failed to delete the local copy (is a file or terminal still using it?): {e}"))?;
    }
    with_registry(|m| {
        m.remove(&uri);
        save_registry(m)
    })
}

/// Push pending local changes once more, then report what is still not on
/// the server. Used before offering to delete a mirror whose tab closes.
#[tauri::command]
pub async fn ftp_mirror_pending(root: String) -> Result<MirrorPending, String> {
    ftp::run(move || {
        uri_for_root(&root).ok_or_else(|| format!("Not an FTP mirror: {root}"))?;
        let root_path = PathBuf::from(&root);
        let runtime = runtimes().lock().unwrap_or_else(|e| e.into_inner()).get(&root).cloned();
        let manifest = match runtime {
            Some(rt) => {
                let _ = run_job(&rt, Mode::Push);
                let manifest = rt.manifest.lock().unwrap_or_else(|e| e.into_inner()).clone();
                manifest
            }
            None => load_manifest(&manifest_path(&root_path)),
        };
        Ok(pending_counts(&root_path, &manifest))
    })
    .await
}

/// Delete the local copy of a mirror (see [`remove_mirror`]).
#[tauri::command]
pub async fn ftp_mirror_remove(root: String) -> Result<(), String> {
    ftp::run(move || remove_mirror(&root)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rs(modified: i64, size: u64) -> RemoteStamp {
        RemoteStamp { modified: Some(modified), size }
    }

    fn ls(mtime_ms: u64, size: u64, hash: &str) -> LocalStamp {
        LocalStamp { mtime_ms, size, hash: hash.into() }
    }

    fn synced(remote: RemoteStamp, local: LocalStamp) -> Entry {
        Entry { remote: Some(remote), local: Some(local), ..Default::default() }
    }

    fn unchanged(l: &LocalStamp) -> LocalState {
        LocalState { mtime_ms: l.mtime_ms, size: l.size, hash: None }
    }

    fn manifest(entries: Vec<(&str, Entry)>) -> Manifest {
        Manifest { entries: entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect() }
    }

    fn map<T>(items: Vec<(&str, T)>) -> BTreeMap<String, T> {
        items.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    #[test]
    fn nothing_to_do_when_both_sides_match() {
        let (r, l) = (rs(10, 3), ls(100, 3, "h"));
        let m = manifest(vec![("a.md", synced(r.clone(), l.clone()))]);
        assert!(plan(&m, Some(&map(vec![("a.md", r)])), &map(vec![("a.md", unchanged(&l))])).is_empty());
    }

    #[test]
    fn new_files_are_copied_to_the_other_side() {
        let m = Manifest::default();
        let remote = map(vec![("server.md", rs(1, 1))]);
        let local = map(vec![("local.md", LocalState { mtime_ms: 1, size: 1, hash: Some("x".into()) })]);
        assert_eq!(
            plan(&m, Some(&remote), &local),
            vec![Action::Upload("local.md".into()), Action::Download("server.md".into())]
        );
    }

    #[test]
    fn one_sided_changes_are_applied() {
        let (r, l) = (rs(10, 3), ls(100, 3, "h"));
        let m = manifest(vec![("a.md", synced(r.clone(), l.clone()))]);
        // Server changed, local unchanged.
        assert_eq!(
            plan(&m, Some(&map(vec![("a.md", rs(20, 3))])), &map(vec![("a.md", unchanged(&l))])),
            vec![Action::Download("a.md".into())]
        );
        // Local changed, server unchanged.
        let edited = LocalState { mtime_ms: 200, size: 4, hash: Some("h2".into()) };
        assert_eq!(
            plan(&m, Some(&map(vec![("a.md", r.clone())])), &map(vec![("a.md", edited.clone())])),
            vec![Action::Upload("a.md".into())]
        );
        // A push (no server listing) sees the same local change.
        assert_eq!(plan(&m, None, &map(vec![("a.md", edited)])), vec![Action::Upload("a.md".into())]);
    }

    #[test]
    fn touched_but_identical_files_only_refresh_the_stamp() {
        let (r, l) = (rs(10, 3), ls(100, 3, "h"));
        let m = manifest(vec![("a.md", synced(r.clone(), l))]);
        let touched = LocalState { mtime_ms: 999, size: 3, hash: Some("h".into()) };
        assert_eq!(
            plan(&m, Some(&map(vec![("a.md", r)])), &map(vec![("a.md", touched)])),
            vec![Action::RefreshLocal("a.md".into())]
        );
    }

    #[test]
    fn edits_on_both_sides_conflict() {
        let m = manifest(vec![("a.md", synced(rs(10, 3), ls(100, 3, "h")))]);
        let edited = LocalState { mtime_ms: 200, size: 4, hash: Some("h2".into()) };
        assert_eq!(
            plan(&m, Some(&map(vec![("a.md", rs(20, 5))])), &map(vec![("a.md", edited)])),
            vec![Action::Conflict("a.md".into(), ConflictKind::BothChanged)]
        );
        // Created on both sides without a common version.
        let fresh = LocalState { mtime_ms: 1, size: 1, hash: Some("x".into()) };
        assert_eq!(
            plan(&Manifest::default(), Some(&map(vec![("b.md", rs(1, 1))])), &map(vec![("b.md", fresh)])),
            vec![Action::Conflict("b.md".into(), ConflictKind::BothNew)]
        );
    }

    #[test]
    fn server_deletions_trash_unchanged_local_files_only() {
        let l = ls(100, 3, "h");
        let m = manifest(vec![("a.md", synced(rs(10, 3), l.clone()))]);
        assert_eq!(
            plan(&m, Some(&BTreeMap::new()), &map(vec![("a.md", unchanged(&l))])),
            vec![Action::TrashLocal("a.md".into())]
        );
        let edited = LocalState { mtime_ms: 200, size: 4, hash: Some("h2".into()) };
        assert_eq!(
            plan(&m, Some(&BTreeMap::new()), &map(vec![("a.md", edited)])),
            vec![Action::Conflict("a.md".into(), ConflictKind::RemoteDeleted)]
        );
    }

    #[test]
    fn local_deletions_wait_for_approval_and_survive_pulls() {
        let r = rs(10, 3);
        let m = manifest(vec![("a.md", synced(r.clone(), ls(100, 3, "h")))]);
        let remote = map(vec![("a.md", r.clone())]);
        assert_eq!(plan(&m, Some(&remote), &BTreeMap::new()), vec![Action::MarkPendingDelete("a.md".into())]);
        assert_eq!(plan(&m, None, &BTreeMap::new()), vec![Action::MarkPendingDelete("a.md".into())]);

        // Once pending, a pull must not download it again.
        let mut pending = m.clone();
        pending.entries.get_mut("a.md").unwrap().pending_delete = true;
        assert!(plan(&pending, Some(&remote), &BTreeMap::new()).is_empty());

        // Restoring the file locally clears the pending state.
        let l = ls(100, 3, "h");
        assert_eq!(
            plan(&pending, Some(&remote), &map(vec![("a.md", unchanged(&l))])),
            vec![Action::RefreshLocal("a.md".into())]
        );

        // Deleted locally but changed on the server: the server wins.
        assert_eq!(
            plan(&m, Some(&map(vec![("a.md", rs(20, 9))])), &BTreeMap::new()),
            vec![Action::Download("a.md".into())]
        );
    }

    #[test]
    fn conflicts_are_left_alone_until_resolved() {
        let mut e = synced(rs(10, 3), ls(100, 3, "h"));
        e.conflict = Some(ConflictKind::BothChanged);
        let m = manifest(vec![("a.md", e)]);
        let edited = LocalState { mtime_ms: 300, size: 7, hash: Some("z".into()) };
        assert!(plan(&m, Some(&map(vec![("a.md", rs(30, 8))])), &map(vec![("a.md", edited)])).is_empty());
    }

    #[test]
    fn gone_on_both_sides_is_forgotten() {
        let m = manifest(vec![("a.md", synced(rs(10, 3), ls(100, 3, "h")))]);
        assert_eq!(plan(&m, Some(&BTreeMap::new()), &BTreeMap::new()), vec![Action::Forget("a.md".into())]);
    }

    #[test]
    fn exclusions() {
        for rel in [
            ".mdium/rag.db",
            "docs/.mdium/a.md",
            ".git/config",
            "node_modules/x/index.js",
            "~$report.docx",
            "dir/.a.md.mdium-dl",
            "dir/.a.md.mdium-tmp",
            "a.remote-20261029-101500.md",
            "noext.remote-20261029-101500",
        ] {
            assert!(is_excluded(rel), "{rel} should be excluded");
        }
        for rel in [".htaccess", "index.html", "docs/a.md", "my.remote-notes.md", "gitignore/.keep"] {
            assert!(!is_excluded(rel), "{rel} should be synced");
        }
    }

    #[test]
    fn conflict_copy_names_are_excluded() {
        for rel in ["a.md", "dir/b.tar.gz", "README", ".htaccess"] {
            let copy = conflict_copy_name(rel);
            assert!(is_excluded(&copy), "{copy}");
            assert!(copy.contains(CONFLICT_MARKER));
        }
        assert!(conflict_copy_name("dir/a.md").starts_with("dir/a.remote-"));
        assert!(conflict_copy_name("dir/a.md").ends_with(".md"));
    }

    /// End-to-end sync against a real server. Run with
    /// `MDIUM_FTP_TEST=host:port:secure:/server/root/on/disk cargo test -- --ignored --test-threads=1 ftp_`
    /// (user `tester` / `secret`; one thread, since the FTP tests share the
    /// connection profile). Uses `<server root>/mirror-test` and a
    /// temporary local mirror; stores and then deletes a connection profile.
    #[test]
    #[ignore]
    fn ftp_mirror_round_trip() {
        let spec = std::env::var("MDIUM_FTP_TEST").expect("MDIUM_FTP_TEST not set");
        let mut parts = spec.splitn(4, ':');
        let host = parts.next().unwrap().to_string();
        let port: u16 = parts.next().unwrap().parse().unwrap();
        let secure = parts.next().unwrap() == "true";
        let server = PathBuf::from(parts.next().unwrap()).join("mirror-test");
        let _ = fs::remove_dir_all(&server);
        for (rel, text) in [
            ("a.md", "a v1"),
            ("sub/b.md", "b v1"),
            ("c.md", "c v1"),
            (".htaccess", "deny"),
            (".mdium/local-only.md", "x"),
            ("node_modules/pkg/index.js", "x"),
        ] {
            let p = local_path(&server, rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        let profile = ftp::FtpProfile {
            host,
            port,
            user: "tester".into(),
            secure,
            accept_invalid_certs: secure,
        };
        let root_uri = tauri::async_runtime::block_on(ftp::ftp_connect(
            profile.clone(),
            Some("secret".into()),
            "/mirror-test".into(),
        ))
        .unwrap();

        let tmp = tempfile::tempdir().unwrap();
        let mirror = tmp.path().join("site");
        let rt = start_runtime(&root_uri, mirror.clone()).unwrap();
        let read = |rel: &str| fs::read_to_string(local_path(&mirror, rel)).unwrap();
        let server_read = |rel: &str| fs::read_to_string(local_path(&server, rel)).unwrap();
        let wait_until = |what: &str, cond: &dyn Fn() -> bool| {
            let end = Instant::now() + Duration::from_secs(15);
            while !cond() {
                assert!(Instant::now() < end, "timed out: {what}");
                std::thread::sleep(Duration::from_millis(200));
            }
        };

        // Initial pull: everything except the excluded folders.
        run_job(&rt, Mode::Pull).unwrap();
        assert_eq!(read("a.md"), "a v1");
        assert_eq!(read("sub/b.md"), "b v1");
        assert_eq!(read(".htaccess"), "deny");
        assert!(!mirror.join(".mdium").exists() && !mirror.join("node_modules").exists());
        assert!(rt.status().error.is_none(), "{:?}", rt.status());

        // A local edit (e.g. by an agent) is uploaded by the watcher.
        fs::write(mirror.join("a.md"), "a v2 from agent").unwrap();
        wait_until("watcher upload", &|| server_read("a.md") == "a v2 from agent");
        // New files in new folders too; local-only folders stay local.
        fs::create_dir_all(mirror.join("new/deep")).unwrap();
        fs::write(mirror.join("new/deep/n.md"), "new").unwrap();
        fs::create_dir_all(mirror.join(".mdium")).unwrap();
        fs::write(mirror.join(".mdium/rag.db"), "index").unwrap();
        wait_until("new file upload", &|| local_path(&server, "new/deep/n.md").exists());
        std::thread::sleep(Duration::from_secs(3));
        assert!(!server.join(".mdium/rag.db").exists());
        assert!(server.join(".mdium/local-only.md").exists());

        // A server edit arrives on pull.
        std::thread::sleep(Duration::from_millis(1100));
        fs::write(server.join("sub/b.md"), "b v2 on server").unwrap();
        run_job(&rt, Mode::Pull).unwrap();
        assert_eq!(read("sub/b.md"), "b v2 on server");

        // Edits on both sides conflict; the server copy is kept beside it.
        let _watch_pause = rt.job.lock().unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        fs::write(server.join("a.md"), "a v3 server").unwrap();
        fs::write(mirror.join("a.md"), "a v3 local").unwrap();
        drop(_watch_pause);
        run_job(&rt, Mode::Pull).unwrap();
        let status = rt.status();
        let conflict = status.conflicts.iter().find(|c| c.path == "a.md").expect("conflict");
        let copy = conflict.copy.clone().unwrap();
        assert_eq!(read(&copy), "a v3 server");
        assert_eq!(read("a.md"), "a v3 local");
        assert_eq!(server_read("a.md"), "a v3 server");
        resolve(&rt, "a.md", "keepLocal").unwrap();
        assert_eq!(server_read("a.md"), "a v3 local");
        assert!(!local_path(&mirror, &copy).exists());
        assert!(rt.status().conflicts.is_empty());

        // A local deletion waits for approval, also across pulls.
        fs::remove_file(mirror.join("sub/b.md")).unwrap();
        wait_until("pending deletion", &|| rt.status().pending_deletes.contains(&"sub/b.md".to_string()));
        run_job(&rt, Mode::Pull).unwrap();
        assert!(!mirror.join("sub/b.md").exists());
        assert!(server.join("sub/b.md").exists());
        resolve(&rt, "sub/b.md", "approveDelete").unwrap();
        assert!(!server.join("sub/b.md").exists());
        assert!(rt.status().pending_deletes.is_empty());

        // A server deletion removes the unchanged local copy.
        fs::remove_file(server.join("c.md")).unwrap();
        run_job(&rt, Mode::Pull).unwrap();
        assert!(!mirror.join("c.md").exists());

        let status = rt.status();
        assert!(status.error.is_none() && status.file_errors.is_empty(), "{status:?}");

        // When nothing can be uploaded (here: the password is gone, as when
        // the server is unreachable) the sync is reported as failed.
        tauri::async_runtime::block_on(ftp::ftp_delete_connection(profile)).unwrap();
        let synced_at = rt.status().last_sync;
        let _pause = rt.job.lock().unwrap();
        fs::write(mirror.join("offline.md"), "written offline").unwrap();
        drop(_pause);
        let _ = run_job(&rt, Mode::Push);
        let status = rt.status();
        assert!(status.error.is_some(), "{status:?}");
        assert_eq!(status.last_sync, synced_at);
        stop_runtime(&rt.root_key());
        let _ = fs::remove_dir_all(&server);
    }

    #[test]
    fn pending_counts_cover_uploads_deletions_and_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("synced.md"), "same").unwrap();
        fs::write(root.join("new.md"), "new").unwrap();
        fs::create_dir_all(root.join(".mdium")).unwrap();
        fs::write(root.join(".mdium/index.db"), "local only").unwrap();
        let meta = fs::metadata(root.join("synced.md")).unwrap();
        let synced_local = LocalStamp { mtime_ms: mtime_ms(&meta), size: meta.len(), hash: hash_bytes(b"same") };
        let mut conflicted = synced(rs(1, 1), ls(1, 1, "x"));
        conflicted.conflict = Some(ConflictKind::BothChanged);
        let mut pending_delete = synced(rs(1, 1), ls(1, 1, "y"));
        pending_delete.pending_delete = true;
        let m = manifest(vec![
            ("synced.md", synced(rs(1, 4), synced_local.clone())),
            ("deleted-unnoticed.md", synced(rs(1, 1), ls(1, 1, "z"))),
            ("pending.md", pending_delete),
            ("conflict.md", conflicted),
        ]);
        assert_eq!(
            pending_counts(root, &m),
            MirrorPending { uploads: 1, deletes: 2, conflicts: 1 }
        );
        // Fully synced: nothing pending (local-only .mdium does not count).
        fs::remove_file(root.join("new.md")).unwrap();
        let clean = manifest(vec![("synced.md", synced(rs(1, 4), synced_local))]);
        assert_eq!(pending_counts(root, &clean), MirrorPending::default());
    }

    #[test]
    fn mirror_roots_are_short_and_safe() {
        let root = new_mirror_root("ftp://me%40example.com@ftp.example.com:21/public_html/site").unwrap();
        let leaf = root.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(leaf, "site");
        let parent = root.parent().unwrap().file_name().unwrap().to_string_lossy().to_string();
        assert!(parent.starts_with("ftp.example.com-"), "{parent}");
        let server_root = new_mirror_root("ftp://me@ftp.example.com:21").unwrap();
        assert_eq!(server_root.file_name().unwrap(), "ftp.example.com");
        assert_ne!(root.parent(), server_root.parent());
    }
}

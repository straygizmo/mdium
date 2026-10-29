//! Remote folders over FTP / FTPS (explicit TLS).
//!
//! A remote item is addressed by a URI of the form
//! `ftp://<user>@<host>:<port>/<remote/path>` (the user part is
//! percent-encoded, the password is never part of the URI). Every place in the
//! app that holds a local path can hold such a URI instead, and the file
//! commands in `file.rs` route it here. Passwords live in the OS credential
//! store (Windows Credential Manager) under the service `mdium-ftp`.
//!
//! Sessions are kept open per `user@host:port` and re-opened once when the
//! server has dropped an idle connection.

use crate::commands::file::{is_target_file, FileEntry};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use suppaftp::list::{File as FtpFile, ListParser};
use suppaftp::types::FileType;
use suppaftp::{NativeTlsConnector, NativeTlsFtpStream};

pub const SCHEME: &str = "ftp://";
const KEYRING_SERVICE: &str = "mdium-ftp";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// After a failed connect, calls fail fast for this long instead of each
/// waiting for the timeout (e.g. many restored tabs while offline).
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(10);
/// Prefix of the error returned when the remote file changed after it was read.
pub const REMOTE_CHANGED: &str = "FTP_REMOTE_CHANGED";

/// Characters escaped in the user part of the URI.
const USER_ESCAPE: &AsciiSet = &CONTROLS.add(b'@').add(b':').add(b'/').add(b'%').add(b' ');

pub fn is_remote(path: &str) -> bool {
    path.starts_with(SCHEME)
}

/// Run a blocking FTP operation off the async runtime / main thread.
pub async fn run<R: Send + 'static>(
    f: impl FnOnce() -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("ftp task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// URI handling
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct RemotePath {
    /// `user@host:port` with the user percent-encoded; the session key.
    pub authority: String,
    /// Absolute remote path, `/` for the server root, never a trailing slash.
    pub path: String,
}

impl RemotePath {
    pub fn parse(uri: &str) -> Result<Self, String> {
        let rest = uri
            .strip_prefix(SCHEME)
            .ok_or_else(|| format!("Not an FTP path: {uri}"))?;
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        if !authority.contains('@') || !authority.contains(':') {
            return Err(format!("Invalid FTP path: {uri}"));
        }
        Ok(Self {
            authority: authority.to_string(),
            path: normalize_remote(path),
        })
    }

    pub fn uri(&self) -> String {
        if self.path == "/" {
            format!("{SCHEME}{}", self.authority)
        } else {
            format!("{SCHEME}{}{}", self.authority, self.path)
        }
    }

    pub fn join(&self, name: &str) -> Self {
        let path = if self.path == "/" {
            format!("/{name}")
        } else {
            format!("{}/{name}", self.path)
        };
        Self { authority: self.authority.clone(), path }
    }

    pub fn name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or("")
    }

    pub fn parent(&self) -> Self {
        let path = match self.path.rfind('/') {
            Some(0) | None => "/".to_string(),
            Some(i) => self.path[..i].to_string(),
        };
        Self { authority: self.authority.clone(), path }
    }
}

/// Collapse duplicate slashes and drop a trailing slash; the result always
/// starts with `/`.
fn normalize_remote(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    format!("/{}", parts.join("/"))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FtpProfile {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Explicit FTPS (AUTH TLS).
    pub secure: bool,
    /// Accept self-signed / mismatched certificates (FTPS only).
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

impl FtpProfile {
    pub fn authority(&self) -> String {
        format!(
            "{}@{}:{}",
            utf8_percent_encode(&self.user, USER_ESCAPE),
            self.host,
            self.port
        )
    }

    fn keyring_account(&self) -> String {
        format!("{}@{}:{}", self.user, self.host, self.port)
    }
}

// ---------------------------------------------------------------------------
// State: saved profiles, open sessions, versions of downloaded files
// ---------------------------------------------------------------------------

/// Size and modification time observed when a file was last read or written.
#[derive(Debug, Clone, PartialEq)]
struct RemoteVersion {
    modified: Option<String>,
    size: Option<usize>,
}

type Session = Arc<Mutex<Option<NativeTlsFtpStream>>>;

struct FtpState {
    profiles: Mutex<Option<HashMap<String, FtpProfile>>>,
    sessions: Mutex<HashMap<String, Session>>,
    versions: Mutex<HashMap<String, RemoteVersion>>,
    /// Last failed connect per authority: when it happened and the error.
    connect_failures: Mutex<HashMap<String, (Instant, String)>>,
}

fn state() -> &'static FtpState {
    static STATE: OnceLock<FtpState> = OnceLock::new();
    STATE.get_or_init(|| FtpState {
        profiles: Mutex::new(None),
        sessions: Mutex::new(HashMap::new()),
        versions: Mutex::new(HashMap::new()),
        connect_failures: Mutex::new(HashMap::new()),
    })
}

fn profiles_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("mdium")
        .join("ftp-connections.json")
}

fn with_profiles<R>(f: impl FnOnce(&mut HashMap<String, FtpProfile>) -> R) -> R {
    let mut guard = state().profiles.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(|| {
        fs::read_to_string(profiles_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    });
    f(map)
}

fn save_profiles(map: &HashMap<String, FtpProfile>) -> Result<(), String> {
    let path = profiles_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Failed to save FTP connections: {e}"))
}

fn profile_for(authority: &str) -> Result<FtpProfile, String> {
    with_profiles(|m| m.get(authority).cloned())
        .ok_or_else(|| format!("No saved FTP connection for {authority}"))
}

fn keyring_entry(profile: &FtpProfile) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &profile.keyring_account()).map_err(|e| e.to_string())
}

fn load_password(profile: &FtpProfile) -> Result<String, String> {
    keyring_entry(profile)?
        .get_password()
        .map_err(|e| format!("FTP password not found for {}: {e}", profile.keyring_account()))
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

fn open_stream(profile: &FtpProfile, password: &str) -> Result<NativeTlsFtpStream, String> {
    let addr = (profile.host.as_str(), profile.port)
        .to_socket_addrs()
        .map_err(|e| format!("Cannot resolve {}: {e}", profile.host))?
        .next()
        .ok_or_else(|| format!("Cannot resolve {}", profile.host))?;
    let mut stream = NativeTlsFtpStream::connect_timeout(addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("Cannot connect to {}:{}: {e}", profile.host, profile.port))?;
    if profile.secure {
        let tls = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(profile.accept_invalid_certs)
            .danger_accept_invalid_hostnames(profile.accept_invalid_certs)
            .build()
            .map_err(|e| e.to_string())?;
        stream = stream
            .into_secure(NativeTlsConnector::from(tls), &profile.host)
            .map_err(|e| format!("TLS negotiation failed: {e}"))?;
    }
    // Servers behind NAT often advertise a private address for PASV.
    stream.set_passive_nat_workaround(true);
    stream
        .login(profile.user.as_str(), password)
        .map_err(|e| format!("FTP login failed: {e}"))?;
    stream
        .transfer_type(FileType::Binary)
        .map_err(|e| e.to_string())?;
    Ok(stream)
}

/// Run `op` on the session for `authority`, opening it if needed. When the
/// operation fails and the connection turns out to be dead (idle timeout,
/// network change), the session is re-opened and the operation retried once.
pub(crate) fn with_session<R>(
    authority: &str,
    mut op: impl FnMut(&mut NativeTlsFtpStream) -> Result<R, String>,
) -> Result<R, String> {
    let session = {
        let mut sessions = state().sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.entry(authority.to_string()).or_default().clone()
    };
    let mut guard = session.lock().unwrap_or_else(|e| e.into_inner());
    for attempt in 0..2 {
        if guard.is_none() {
            *guard = Some(connect_session(authority)?);
        }
        let stream = guard.as_mut().expect("session was just opened");
        match op(stream) {
            Ok(v) => return Ok(v),
            Err(e) => {
                if attempt == 0 && stream.noop().is_err() {
                    *guard = None;
                    continue;
                }
                return Err(e);
            }
        }
    }
    unreachable!("the retry loop always returns")
}

/// Open a session from the saved profile, failing fast while a recent
/// connect attempt to the same server is known to have failed.
fn connect_session(authority: &str) -> Result<NativeTlsFtpStream, String> {
    let mut failures = state().connect_failures.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, err)) = failures.get(authority) {
        if at.elapsed() < RETRY_AFTER_FAILURE {
            return Err(err.clone());
        }
    }
    drop(failures);
    let result = profile_for(authority)
        .and_then(|profile| load_password(&profile).map(|pw| (profile, pw)))
        .and_then(|(profile, pw)| open_stream(&profile, &pw));
    failures = state().connect_failures.lock().unwrap_or_else(|e| e.into_inner());
    match &result {
        Ok(_) => {
            failures.remove(authority);
        }
        Err(e) => {
            failures.insert(authority.to_string(), (Instant::now(), e.clone()));
        }
    }
    result
}

fn current_version(stream: &mut NativeTlsFtpStream, path: &str) -> RemoteVersion {
    RemoteVersion {
        modified: stream.mdtm(path).ok().map(|t| t.to_string()),
        size: stream.size(path).ok(),
    }
}

fn record_version(uri: &str, version: RemoteVersion) {
    state()
        .versions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(uri.to_string(), version);
}

fn recorded_version(uri: &str) -> Option<RemoteVersion> {
    state()
        .versions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(uri)
        .cloned()
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

pub(crate) struct ListedEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Modification time in Unix seconds, when the listing provides one.
    pub modified: Option<i64>,
}

fn parse_listing(lines: &[String], mlsd: bool) -> Vec<FtpFile> {
    lines
        .iter()
        .filter_map(|line| {
            if mlsd {
                ListParser::parse_mlsd(line).ok()
            } else {
                line.parse::<FtpFile>().ok()
            }
        })
        .collect()
}

pub(crate) fn list_raw(
    stream: &mut NativeTlsFtpStream,
    path: &str,
) -> Result<Vec<ListedEntry>, String> {
    let files = match stream.mlsd(Some(path)) {
        Ok(lines) => parse_listing(&lines, true),
        Err(_) => {
            let lines = stream
                .list(Some(path))
                .map_err(|e| format!("Failed to list {path}: {e}"))?;
            parse_listing(&lines, false)
        }
    };
    let mut out = Vec::new();
    for f in files {
        let name = f.name().to_string();
        if name == "." || name == ".." || name.is_empty() {
            continue;
        }
        let is_dir = if f.is_symlink() {
            // A symlink may point to a directory (common for `public_html`).
            let target = join_remote(path, &name);
            let is_dir = stream.cwd(&target).is_ok();
            let _ = stream.cwd("/");
            is_dir
        } else {
            f.is_directory()
        };
        let modified = f
            .modified()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs() as i64);
        out.push(ListedEntry { name, is_dir, size: f.size() as u64, modified });
    }
    Ok(out)
}

pub(crate) fn join_remote(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Same names the local tree hides.
fn is_hidden_name(name: &str) -> bool {
    (name.starts_with('.') && name != ".mdium")
        || name.starts_with("~$")
        || name == "node_modules"
        || name == "target"
        || name == "dist"
}

#[derive(Debug, Clone, Copy, Default)]
pub struct TreeFilter {
    pub show_all: bool,
    pub include_docx: bool,
    pub include_xls: bool,
    pub include_pptx: bool,
    pub include_km: bool,
    pub include_images: bool,
    pub include_pdf: bool,
}

impl TreeFilter {
    fn accepts(&self, name: &str) -> bool {
        self.show_all
            || is_target_file(
                name,
                self.include_docx,
                self.include_xls,
                self.include_pptx,
                self.include_km,
                self.include_images,
                self.include_pdf,
            )
    }
}

/// List one directory level. Subdirectories listed in `expanded` are loaded
/// too (recursively); every other directory gets `children: None`, which the
/// tree treats as "not loaded yet".
fn build_entries(
    stream: &mut NativeTlsFtpStream,
    dir: &RemotePath,
    filter: TreeFilter,
    expanded: &HashSet<String>,
    depth: u32,
) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();
    for item in list_raw(stream, &dir.path)? {
        if is_hidden_name(&item.name) {
            continue;
        }
        let child = dir.join(&item.name);
        let uri = child.uri();
        if item.is_dir {
            let children = if depth < 10 && expanded.contains(&uri) {
                build_entries(stream, &child, filter, expanded, depth + 1).ok()
            } else {
                None
            };
            entries.push(FileEntry { name: item.name, path: uri, is_directory: true, children });
        } else if filter.accepts(&item.name) {
            entries.push(FileEntry { name: item.name, path: uri, is_directory: false, children: None });
        }
    }
    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

// ---------------------------------------------------------------------------
// Blocking operations (called from `file.rs` via spawn_blocking)
// ---------------------------------------------------------------------------

pub fn list_tree(uri: &str, filter: TreeFilter, expanded: &[String]) -> Result<Vec<FileEntry>, String> {
    let dir = RemotePath::parse(uri)?;
    let expanded: HashSet<String> = expanded.iter().cloned().collect();
    with_session(&dir.authority, |s| build_entries(s, &dir, filter, &expanded, 0))
}

pub fn read_bytes(uri: &str) -> Result<Vec<u8>, String> {
    let rp = RemotePath::parse(uri)?;
    with_session(&rp.authority, |s| {
        let data = s
            .retr_as_buffer(&rp.path)
            .map_err(|e| format!("Failed to download {}: {e}", rp.path))?
            .into_inner();
        let version = current_version(s, &rp.path);
        record_version(uri, version);
        Ok(data)
    })
}

/// Upload `data` to `uri`. Unless `force` is set, the upload is refused with a
/// `FTP_REMOTE_CHANGED` error when the server copy changed since it was read.
/// The data goes to a temporary name first and is then renamed over the
/// target, so a dropped connection never leaves a truncated file behind.
pub fn write_bytes(uri: &str, data: &[u8], force: bool) -> Result<(), String> {
    let rp = RemotePath::parse(uri)?;
    let known = recorded_version(uri);
    with_session(&rp.authority, |s| {
        if !force {
            if let Some(known) = &known {
                let now = current_version(s, &rp.path);
                let comparable = known.modified.is_some() || known.size.is_some();
                if comparable && now != *known {
                    return Err(format!("{REMOTE_CHANGED}: {}", rp.path));
                }
            }
        }
        put_atomic(s, &rp, data)?;
        let version = current_version(s, &rp.path);
        record_version(uri, version);
        Ok(())
    })
}

/// Upload to a temporary name next to the target, then rename it over the
/// target, so a dropped connection never leaves a truncated file behind.
pub(crate) fn put_atomic(s: &mut NativeTlsFtpStream, rp: &RemotePath, data: &[u8]) -> Result<(), String> {
    let tmp = rp.parent().join(&format!(".{}.mdium-tmp", rp.name()));
    s.put_file(&tmp.path, &mut Cursor::new(data))
        .map_err(|e| format!("Failed to upload {}: {e}", rp.path))?;
    if s.rename(&tmp.path, &rp.path).is_err() {
        // Some servers (e.g. IIS) refuse to rename over an existing file.
        let _ = s.rm(&rp.path);
        s.rename(&tmp.path, &rp.path).map_err(|e| {
            let _ = s.rm(&tmp.path);
            format!("Failed to replace {}: {e}", rp.path)
        })?;
    }
    Ok(())
}

/// Create `dir` and its missing parents on the server.
pub(crate) fn ensure_remote_dir(s: &mut NativeTlsFtpStream, dir: &str) -> Result<(), String> {
    let mut current = String::new();
    for part in dir.split('/').filter(|p| !p.is_empty()) {
        current.push('/');
        current.push_str(part);
        if s.cwd(&current).is_err() {
            s.mkdir(&current)
                .map_err(|e| format!("Failed to create folder {current}: {e}"))?;
        }
    }
    let _ = s.cwd("/");
    Ok(())
}

pub fn dir_exists(uri: &str) -> bool {
    let Ok(rp) = RemotePath::parse(uri) else { return false };
    with_session(&rp.authority, |s| {
        let ok = s.cwd(&rp.path).is_ok();
        let _ = s.cwd("/");
        Ok(ok)
    })
    .unwrap_or(false)
}

pub fn create_dir(uri: &str) -> Result<(), String> {
    let rp = RemotePath::parse(uri)?;
    with_session(&rp.authority, |s| {
        s.mkdir(&rp.path).map_err(|e| format!("Failed to create folder: {e}"))
    })
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    let src = RemotePath::parse(from)?;
    let dst = RemotePath::parse(to)?;
    if src.authority != dst.authority {
        return Err("Moving between different FTP servers is not supported".to_string());
    }
    with_session(&src.authority, |s| {
        if s.size(&dst.path).is_ok() || s.cwd(&dst.path).is_ok() {
            let _ = s.cwd("/");
            return Err("Destination path already exists".to_string());
        }
        s.rename(&src.path, &dst.path).map_err(|e| format!("Failed to rename: {e}"))
    })?;
    let mut versions = state().versions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = versions.remove(from) {
        versions.insert(to.to_string(), v);
    }
    Ok(())
}

pub(crate) fn remove_recursive(s: &mut NativeTlsFtpStream, path: &str) -> Result<(), String> {
    if s.rm(path).is_ok() {
        return Ok(());
    }
    for item in list_raw(s, path)? {
        let child = join_remote(path, &item.name);
        if item.is_dir {
            remove_recursive(s, &child)?;
        } else {
            s.rm(&child).map_err(|e| format!("Failed to delete {child}: {e}"))?;
        }
    }
    s.rmdir(path).map_err(|e| format!("Failed to delete directory {path}: {e}"))
}

pub fn remove(uri: &str) -> Result<(), String> {
    let rp = RemotePath::parse(uri)?;
    if rp.path == "/" {
        return Err("Refusing to delete the server root".to_string());
    }
    with_session(&rp.authority, |s| remove_recursive(s, &rp.path))
}

/// Local cache file for a remote file (used to hand it to other apps).
/// Only the file name is kept readable; the directory is a hash of the
/// remote URI, so invalid Windows characters or long remote paths are safe.
pub fn cache_path(uri: &str) -> Result<PathBuf, String> {
    let rp = RemotePath::parse(uri)?;
    let digest = Sha256::digest(rp.parent().uri().as_bytes());
    let dir_hash: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Ok(std::env::temp_dir()
        .join("mdium-ftp")
        .join(dir_hash)
        .join(sanitize_file_name(rp.name())))
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() { "file".to_string() } else { trimmed.to_string() }
}

pub fn download_to_cache(uri: &str) -> Result<PathBuf, String> {
    let data = read_bytes(uri)?;
    let path = cache_path(uri)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| format!("Failed to write cache file: {e}"))?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Tauri commands for connection management
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    #[serde(flatten)]
    pub profile: FtpProfile,
    pub has_password: bool,
}

/// Saved connections (without passwords), sorted by host and user.
#[tauri::command]
pub async fn ftp_list_connections() -> Result<Vec<SavedConnection>, String> {
    tokio::task::spawn_blocking(|| {
        let mut list: Vec<SavedConnection> = with_profiles(|m| m.values().cloned().collect::<Vec<_>>())
            .into_iter()
            .map(|profile| {
                let has_password = keyring_entry(&profile)
                    .and_then(|e| e.get_password().map_err(|e| e.to_string()))
                    .is_ok();
                SavedConnection { profile, has_password }
            })
            .collect();
        list.sort_by(|a, b| (&a.profile.host, &a.profile.user).cmp(&(&b.profile.host, &b.profile.user)));
        Ok(list)
    })
    .await
    .map_err(|e| format!("ftp task failed: {e}"))?
}

/// Log in, check that `remote_path` is a directory, then save the connection
/// (password into the OS credential store) and return the folder URI.
/// An empty `password` reuses the stored one.
#[tauri::command]
pub async fn ftp_connect(
    profile: FtpProfile,
    password: Option<String>,
    remote_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if profile.host.trim().is_empty() || profile.user.trim().is_empty() {
            return Err("Host and user are required".to_string());
        }
        let password = match password.filter(|p| !p.is_empty()) {
            Some(p) => p,
            None => load_password(&profile)?,
        };
        let mut stream = open_stream(&profile, &password)?;
        let root = normalize_remote(&remote_path);
        stream
            .cwd(&root)
            .map_err(|e| format!("Remote folder not found: {root} ({e})"))?;
        let _ = stream.cwd("/");

        keyring_entry(&profile)?
            .set_password(&password)
            .map_err(|e| format!("Failed to store the password: {e}"))?;
        let authority = profile.authority();
        with_profiles(|m| {
            m.insert(authority.clone(), profile.clone());
            save_profiles(m)
        })?;

        // Replace any stale session with the freshly authenticated one.
        state()
            .connect_failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&authority);
        let session: Session = Arc::new(Mutex::new(Some(stream)));
        state()
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(authority.clone(), session);

        Ok(RemotePath { authority, path: root }.uri())
    })
    .await
    .map_err(|e| format!("ftp task failed: {e}"))?
}

/// Forget a saved connection and its stored password.
#[tauri::command]
pub async fn ftp_delete_connection(profile: FtpProfile) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if let Ok(entry) = keyring_entry(&profile) {
            let _ = entry.delete_credential();
        }
        let authority = profile.authority();
        state()
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&authority);
        with_profiles(|m| {
            m.remove(&authority);
            save_profiles(m)
        })
    })
    .await
    .map_err(|e| format!("ftp task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_uris() {
        let rp = RemotePath::parse("ftp://me@example.com:21/public_html/docs/").unwrap();
        assert_eq!(rp.authority, "me@example.com:21");
        assert_eq!(rp.path, "/public_html/docs");
        assert_eq!(rp.uri(), "ftp://me@example.com:21/public_html/docs");
        assert_eq!(rp.name(), "docs");
        assert_eq!(rp.parent().uri(), "ftp://me@example.com:21/public_html");
        assert_eq!(rp.parent().parent().uri(), "ftp://me@example.com:21");
        assert_eq!(rp.join("a.md").path, "/public_html/docs/a.md");
    }

    #[test]
    fn root_uri_has_no_trailing_slash() {
        let rp = RemotePath::parse("ftp://me@example.com:21").unwrap();
        assert_eq!(rp.path, "/");
        assert_eq!(rp.uri(), "ftp://me@example.com:21");
        assert_eq!(rp.join("index.html").uri(), "ftp://me@example.com:21/index.html");
        assert_eq!(RemotePath::parse("ftp://me@example.com:21/").unwrap(), rp);
    }

    #[test]
    fn rejects_non_ftp_paths() {
        assert!(RemotePath::parse("C:\\docs\\a.md").is_err());
        assert!(RemotePath::parse("ftp://example.com/a").is_err());
        assert!(!is_remote("C:\\ftp\\a.md"));
        assert!(is_remote("ftp://me@h:21/a"));
    }

    #[test]
    fn user_with_at_sign_is_encoded() {
        let profile = FtpProfile {
            host: "ftp.example.com".into(),
            port: 21,
            user: "me@example.com".into(),
            secure: true,
            accept_invalid_certs: false,
        };
        let authority = profile.authority();
        assert_eq!(authority, "me%40example.com@ftp.example.com:21");
        let rp = RemotePath::parse(&format!("ftp://{authority}/a.md")).unwrap();
        assert_eq!(rp.authority, authority);
        assert_eq!(rp.path, "/a.md");
    }

    #[test]
    fn cache_path_is_safe_on_windows() {
        let p = cache_path("ftp://me@h:21/very/deep/dir/we:ird?.md").unwrap();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, "we_ird_.md");
        let other = cache_path("ftp://me@h:21/other/we:ird?.md").unwrap();
        assert_ne!(p.parent(), other.parent());
        assert_eq!(sanitize_file_name("trailing. "), "trailing");
    }

    /// End-to-end check against a real server. Run with
    /// `MDIUM_FTP_TEST=host:port:secure:/server/root/on/disk cargo test -- --ignored ftp_server`
    /// (user `tester` / `secret`, write permission required). It stores and
    /// then deletes a connection profile and a credential-store entry.
    #[test]
    #[ignore]
    fn ftp_server_round_trip() {
        let spec = std::env::var("MDIUM_FTP_TEST").expect("MDIUM_FTP_TEST not set");
        let mut parts = spec.splitn(4, ':');
        let host = parts.next().unwrap().to_string();
        let port: u16 = parts.next().unwrap().parse().unwrap();
        let secure = parts.next().unwrap() == "true";
        let disk_root = PathBuf::from(parts.next().unwrap());
        let profile = FtpProfile {
            host,
            port,
            user: "tester".into(),
            secure,
            accept_invalid_certs: secure,
        };

        let root = tauri::async_runtime::block_on(ftp_connect(profile.clone(), Some("secret".into()), "/".into())).unwrap();
        assert_eq!(root, format!("ftp://tester@{}:{}", profile.host, port));

        // Lazy listing: hidden files skipped, directories not loaded.
        let filter = TreeFilter::default();
        let tree = list_tree(&root, filter, &[]).unwrap();
        let names: Vec<&str> = tree.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"docs") && names.contains(&"README.md"), "{names:?}");
        assert!(!names.contains(&".hidden"));
        let docs = tree.iter().find(|e| e.name == "docs").unwrap();
        assert!(docs.is_directory && docs.children.is_none());

        // Expanded directories come back loaded; their subdirectories do not.
        let tree = list_tree(&root, filter, &[docs.path.clone()]).unwrap();
        let docs = tree.iter().find(|e| e.name == "docs").unwrap();
        let children = docs.children.as_ref().unwrap();
        assert!(children.iter().any(|e| e.name == "guide.md"));
        assert!(children.iter().find(|e| e.name == "deep").unwrap().children.is_none());

        // Non-ASCII names.
        let jp = format!("{root}/日本語フォルダ/メモ.md");
        assert!(String::from_utf8(read_bytes(&jp).unwrap()).unwrap().contains("日本語"));

        // Read, write, read back.
        let file = format!("{root}/docs/roundtrip.md");
        let _ = remove(&file);
        write_bytes(&file, b"one", false).unwrap();
        assert_eq!(read_bytes(&file).unwrap(), b"one");
        write_bytes(&file, "二".as_bytes(), false).unwrap();
        assert_eq!(read_bytes(&file).unwrap(), "二".as_bytes());
        // No temp file left behind.
        let tree = list_tree(&format!("{root}/docs"), TreeFilter { show_all: true, ..filter }, &[]).unwrap();
        assert!(!tree.iter().any(|e| e.name.contains("mdium-tmp")));

        // A change made on the server is detected; `force` overwrites it.
        std::thread::sleep(Duration::from_millis(1100));
        fs::write(disk_root.join("docs/roundtrip.md"), "changed on server, longer").unwrap();
        let err = write_bytes(&file, b"mine", false).unwrap_err();
        assert!(err.starts_with(REMOTE_CHANGED), "{err}");
        write_bytes(&file, b"mine", true).unwrap();
        assert_eq!(fs::read(disk_root.join("docs/roundtrip.md")).unwrap(), b"mine");

        // Folder operations.
        let dir = format!("{root}/mdium-test-dir");
        let _ = remove(&dir);
        create_dir(&dir).unwrap();
        assert!(dir_exists(&dir));
        write_bytes(&format!("{dir}/a.md"), b"a", false).unwrap();
        create_dir(&format!("{dir}/sub")).unwrap();
        write_bytes(&format!("{dir}/sub/b.md"), b"b", false).unwrap();
        let renamed = format!("{root}/mdium-test-renamed");
        let _ = remove(&renamed);
        rename(&dir, &renamed).unwrap();
        assert!(!dir_exists(&dir));
        assert!(rename(&file, &renamed).is_err(), "rename onto an existing path must fail");
        remove(&renamed).unwrap();
        assert!(!dir_exists(&renamed));
        remove(&file).unwrap();

        // A dropped session is re-opened transparently.
        {
            let sessions = state().sessions.lock().unwrap();
            let session = sessions.get(&profile.authority()).unwrap().clone();
            drop(sessions);
            let mut guard = session.lock().unwrap();
            let _ = guard.as_mut().unwrap().quit();
        }
        assert!(read_bytes(&format!("{root}/README.md")).is_ok());

        // Cache download for "open in default app".
        let cached = download_to_cache(&format!("{root}/README.md")).unwrap();
        assert!(fs::read_to_string(cached).unwrap().contains("Hello"));

        tauri::async_runtime::block_on(ftp_delete_connection(profile.clone())).unwrap();
        assert!(load_password(&profile).is_err());
        assert!(read_bytes(&format!("{root}/README.md")).is_err());
    }

    #[test]
    fn parses_unix_and_mlsd_listings() {
        let unix = vec![
            "drwxr-xr-x    2 1000     1000         4096 Oct 01 12:00 docs".to_string(),
            "-rw-r--r--    1 1000     1000          120 Oct 01 12:00 README.md".to_string(),
        ];
        let files = parse_listing(&unix, false);
        assert_eq!(files.len(), 2);
        assert!(files[0].is_directory());
        assert_eq!(files[1].name(), "README.md");

        let mlsd = vec!["type=file;size=12;modify=20261001120000; a b.md".to_string()];
        let files = parse_listing(&mlsd, true);
        assert_eq!(files[0].name(), "a b.md");
        assert!(files[0].is_file());
    }
}

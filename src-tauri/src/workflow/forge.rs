//! Forge (GitHub / GitLab) detection and a small client for the Issue
//! operations the workflow needs, implemented on top of the user's `gh` /
//! `glab` CLIs.
//!
//! Every CLI call is blocking, runs with MDium's normal environment (not the
//! containment env) and without a console window, names the repository
//! explicitly (`--hostname` plus the API path), and passes user-authored
//! text (issue/comment bodies) through a temp file under the OS temp dir
//! that is removed after the call — never on the command line.

use crate::workflow::fsutil::new_id;
use crate::workflow::gitops::run_git_raw;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The CLI is not on `PATH`.
pub const FORGE_NOT_INSTALLED: &str = "FORGE_NOT_INSTALLED";
/// The CLI is not logged in to the forge host.
pub const FORGE_NOT_AUTHENTICATED: &str = "FORGE_NOT_AUTHENTICATED";
/// The CLI exited non-zero (or a temp body file could not be written).
pub const FORGE_COMMAND_FAILED: &str = "FORGE_COMMAND_FAILED";
/// The CLI succeeded but its output was not the expected JSON.
pub const FORGE_BAD_RESPONSE: &str = "FORGE_BAD_RESPONSE";

/// Maximum number of characters of CLI stderr kept in an error.
const MAX_STDERR_CHARS: usize = 500;

/// Which forge a repository lives on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeKind {
    GitHub,
    GitLab,
}

/// A repository on a forge: host (lowercase, `host[:port]`) and path
/// (`owner/repo` or `group/sub/project`, without `.git`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRepo {
    pub kind: ForgeKind,
    pub host: String,
    pub path: String,
}

/// A created Issue: its number (GitHub `number`, GitLab `iid`) and web URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRefData {
    pub number: u64,
    pub url: String,
}

/// One Issue comment (GitLab: note).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub body: String,
}

/// A failed forge operation. Serializes as `{ code, message }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeError {
    NotInstalled,
    NotAuthenticated,
    /// Non-zero exit (`code` is -1 when there was no exit code, e.g. the
    /// temp body file could not be written); `stderr` is capped at 500 chars.
    CommandFailed {
        code: i32,
        stderr: String,
    },
    BadResponse(String),
}

impl ForgeError {
    /// Stable machine code (`FORGE_*`).
    pub fn code(&self) -> &'static str {
        match self {
            ForgeError::NotInstalled => FORGE_NOT_INSTALLED,
            ForgeError::NotAuthenticated => FORGE_NOT_AUTHENTICATED,
            ForgeError::CommandFailed { .. } => FORGE_COMMAND_FAILED,
            ForgeError::BadResponse(_) => FORGE_BAD_RESPONSE,
        }
    }

    /// A `CommandFailed` with `stderr` capped at [`MAX_STDERR_CHARS`].
    pub fn command_failed(code: i32, stderr: &str) -> Self {
        ForgeError::CommandFailed {
            code,
            stderr: cap_chars(stderr.trim(), MAX_STDERR_CHARS),
        }
    }
}

impl std::fmt::Display for ForgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ForgeError::NotInstalled | ForgeError::NotAuthenticated => f.write_str(self.code()),
            ForgeError::CommandFailed { code, stderr } => {
                write!(f, "{} (exit {code}): {stderr}", self.code())
            }
            ForgeError::BadResponse(detail) => write!(f, "{}: {detail}", self.code()),
        }
    }
}

crate::workflow::errors::impl_workflow_error!(ForgeError);

/// Keeps at most `max` characters of `text`.
fn cap_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The Issue operations the workflow performs on a forge.
pub trait ForgeCli: Send + Sync {
    /// Whether the CLI for `kind` is on `PATH`.
    fn available(&self, kind: ForgeKind) -> bool;
    /// Whether the CLI for `kind` is logged in to `host`.
    fn is_authenticated(&self, kind: ForgeKind, host: &str) -> bool;
    fn create_issue(
        &self,
        repo: &ForgeRepo,
        title: &str,
        body: &str,
    ) -> Result<IssueRefData, ForgeError>;
    /// All comments of the Issue (every page).
    fn list_comments(&self, repo: &ForgeRepo, number: u64) -> Result<Vec<Comment>, ForgeError>;
    fn add_comment(&self, repo: &ForgeRepo, number: u64, body: &str) -> Result<(), ForgeError>;
    fn close_issue(&self, repo: &ForgeRepo, number: u64) -> Result<(), ForgeError>;
}

/// What the UI needs to know before an intake starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeProbe {
    /// The detected forge repository, if `origin` points at one.
    pub repo: Option<ForgeRepo>,
    /// The detected forge's CLI is installed (with no repo: either CLI is).
    pub cli_available: bool,
    /// The detected forge's CLI is logged in to its host.
    pub authenticated: bool,
}

// ---------------------------------------------------------------------------
// Remote URL parsing and detection
// ---------------------------------------------------------------------------

/// Whether `host` is a plausible DNS host name (lowercase letters, digits,
/// `.` and `-`, not starting or ending with `.`/`-`).
fn valid_host_name(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
        && !host.starts_with(['.', '-'])
        && !host.ends_with(['.', '-'])
}

/// Normalizes a repository path: trims slashes and one `.git` suffix,
/// requires at least two segments of `[A-Za-z0-9._-]`, none `.`/`..`.
fn normalize_repo_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let trimmed = trimmed.trim_end_matches('/');
    let segments: Vec<&str> = trimmed.split('/').collect();
    if segments.len() < 2 {
        return None;
    }
    let valid = segments.iter().all(|seg| {
        !seg.is_empty()
            && *seg != "."
            && *seg != ".."
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    });
    valid.then(|| segments.join("/"))
}

/// Parses a git remote URL into `(host, path)`.
///
/// Supported forms: `http(s)://[user[:pass]@]host[:port]/path[.git][/]`
/// (the host keeps a web port), `ssh://[user@]host[:port]/path` (the SSH
/// port is dropped: it says nothing about the web host) and scp-like
/// `[user@]host:path`. The host is lowercased; the path loses `.git` and
/// surrounding slashes and must have at least two segments. Anything else
/// (local paths, `file://`, odd characters) is `None`.
pub fn parse_remote_url(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    if url.contains('\\') || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    let (rest, keep_port) = if lower.starts_with("https://") {
        (&url["https://".len()..], true)
    } else if lower.starts_with("http://") {
        (&url["http://".len()..], true)
    } else if lower.starts_with("ssh://") {
        (&url["ssh://".len()..], false)
    } else if url.contains("://") {
        return None;
    } else {
        return parse_scp_like(url);
    };
    let (authority, path) = rest.split_once('/')?;
    // Drop any userinfo (it may hold a token; never keep it).
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (host, port) = match host_port.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (host_port, None),
    };
    let host = host.to_ascii_lowercase();
    if !valid_host_name(&host) {
        return None;
    }
    if let Some(port) = port {
        if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
    }
    let host = match (keep_port, port) {
        (true, Some(port)) => format!("{host}:{port}"),
        _ => host,
    };
    Some((host, normalize_repo_path(path)?))
}

/// Parses scp-like `[user@]host:path`. A one-letter host is rejected so a
/// Windows drive path (`C:/repo`) is never mistaken for a remote.
fn parse_scp_like(url: &str) -> Option<(String, String)> {
    let (authority, path) = url.split_once(':')?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.to_ascii_lowercase();
    if host.len() < 2 || !valid_host_name(&host) {
        return None;
    }
    Some((host, normalize_repo_path(path)?))
}

/// Resolves the forge for an already-parsed origin: `github.com` ⇒ GitHub,
/// `gitlab.com` ⇒ GitLab, any other host ⇒ whichever CLI is logged in to it
/// (GitHub first), else `None`. GitHub paths must be exactly `owner/repo`.
pub fn detect_from_url(url: &str, cli: &dyn ForgeCli) -> Option<ForgeRepo> {
    let (host, path) = parse_remote_url(url)?;
    let kind = match host.as_str() {
        "github.com" => ForgeKind::GitHub,
        "gitlab.com" => ForgeKind::GitLab,
        _ if cli.is_authenticated(ForgeKind::GitHub, &host) => ForgeKind::GitHub,
        _ if cli.is_authenticated(ForgeKind::GitLab, &host) => ForgeKind::GitLab,
        _ => return None,
    };
    if kind == ForgeKind::GitHub && path.split('/').count() != 2 {
        return None;
    }
    Some(ForgeRepo { kind, host, path })
}

/// Detects the forge repository behind `repo_root`'s `origin` remote.
/// No `origin` (or not a git repository, or not a forge URL) is `Ok(None)`;
/// only failing to run git at all is an error.
pub fn detect(repo_root: &Path, cli: &dyn ForgeCli) -> Result<Option<ForgeRepo>, ForgeError> {
    let output = run_git_raw(repo_root, &["remote", "get-url", "origin"])
        .map_err(|err| ForgeError::command_failed(-1, &err.to_string()))?;
    if !output.success {
        return Ok(None);
    }
    Ok(detect_from_url(output.stdout.trim(), cli))
}

/// Detects the forge and checks its CLI, never failing: a detection error
/// reads as "no forge".
pub fn probe(repo_root: &Path, cli: &dyn ForgeCli) -> ForgeProbe {
    let repo = detect(repo_root, cli).ok().flatten();
    match repo {
        Some(repo) => {
            let cli_available = cli.available(repo.kind);
            let authenticated = cli_available && cli.is_authenticated(repo.kind, &repo.host);
            ForgeProbe {
                repo: Some(repo),
                cli_available,
                authenticated,
            }
        }
        None => ForgeProbe {
            repo: None,
            cli_available: cli.available(ForgeKind::GitHub) || cli.available(ForgeKind::GitLab),
            authenticated: false,
        },
    }
}

// ---------------------------------------------------------------------------
// Real CLI client
// ---------------------------------------------------------------------------

/// Characters left unescaped in a GitLab project id (RFC 3986 unreserved).
const GITLAB_PATH_ENCODE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Comments/notes requested per page.
const PER_PAGE: u32 = 100;

/// One CLI operation, as passed to [`build_args`]. `body_file` is the temp
/// file holding the user-authored text: for GitHub the raw body, for GitLab
/// the whole JSON request body.
#[derive(Debug, Clone, Copy)]
pub enum ForgeOp<'a> {
    AuthStatus { host: &'a str },
    CreateIssue { title: &'a str, body_file: &'a Path },
    ListComments { number: u64 },
    AddComment { number: u64, body_file: &'a Path },
    CloseIssue { number: u64 },
}

/// The CLI program for a forge.
fn program(kind: ForgeKind) -> &'static str {
    match kind {
        ForgeKind::GitHub => "gh",
        ForgeKind::GitLab => "glab",
    }
}

/// Builds the CLI arguments (after the program name) for `op` on `repo`.
/// `repo` is ignored for [`ForgeOp::AuthStatus`] except for its kind.
///
/// GitHub (`gh api`): `-f` raw-string fields (never `-F`, which would turn a
/// title like `true` or `42` into a non-string), bodies via `-F body=@file`.
/// GitLab (`glab api`): JSON request bodies via `--input file` with an
/// explicit JSON content type.
pub fn build_args(repo: &ForgeRepo, op: &ForgeOp) -> Vec<String> {
    let host = repo.host.as_str();
    let mut args: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| args.extend(items.iter().map(|s| s.to_string()));
    match repo.kind {
        ForgeKind::GitHub => {
            let base = format!("repos/{}/issues", repo.path);
            match op {
                ForgeOp::AuthStatus { host } => push(&["auth", "status", "--hostname", host]),
                ForgeOp::CreateIssue { title, body_file } => push(&[
                    "api",
                    "--hostname",
                    host,
                    "--method",
                    "POST",
                    &base,
                    "-f",
                    &format!("title={title}"),
                    "-F",
                    &format!("body=@{}", body_file.display()),
                ]),
                ForgeOp::ListComments { number } => push(&[
                    "api",
                    "--hostname",
                    host,
                    "--method",
                    "GET",
                    "--paginate",
                    &format!("{base}/{number}/comments?per_page={PER_PAGE}"),
                ]),
                ForgeOp::AddComment { number, body_file } => push(&[
                    "api",
                    "--hostname",
                    host,
                    "--method",
                    "POST",
                    &format!("{base}/{number}/comments"),
                    "-F",
                    &format!("body=@{}", body_file.display()),
                ]),
                ForgeOp::CloseIssue { number } => push(&[
                    "api",
                    "--hostname",
                    host,
                    "--method",
                    "PATCH",
                    &format!("{base}/{number}"),
                    "-f",
                    "state=closed",
                ]),
            }
        }
        ForgeKind::GitLab => {
            let project = utf8_percent_encode(&repo.path, GITLAB_PATH_ENCODE).to_string();
            let base = format!("projects/{project}/issues");
            const JSON: [&str; 2] = ["--header", "Content-Type: application/json"];
            match op {
                ForgeOp::AuthStatus { host } => push(&["auth", "status", "--hostname", host]),
                ForgeOp::CreateIssue { body_file, .. } => {
                    push(&["api", "--hostname", host, "--method", "POST", &base]);
                    push(&JSON);
                    push(&["--input", &body_file.display().to_string()]);
                }
                ForgeOp::ListComments { number } => push(&[
                    "api",
                    "--hostname",
                    host,
                    "--method",
                    "GET",
                    "--paginate",
                    &format!("{base}/{number}/notes?per_page={PER_PAGE}"),
                ]),
                ForgeOp::AddComment { number, body_file } => {
                    push(&[
                        "api",
                        "--hostname",
                        host,
                        "--method",
                        "POST",
                        &format!("{base}/{number}/notes"),
                    ]);
                    push(&JSON);
                    push(&["--input", &body_file.display().to_string()]);
                }
                ForgeOp::CloseIssue { number } => push(&[
                    "api",
                    "--hostname",
                    host,
                    "--method",
                    "PUT",
                    &format!("{base}/{number}"),
                    "-f",
                    "state_event=close",
                ]),
            }
        }
    }
    args
}

/// Removes the wrapped file on drop (also on early return or panic).
struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Writes `contents` to a fresh file under the OS temp dir, runs `f` with
/// its path, and removes the file afterwards whatever `f` returns.
pub fn with_temp_body<R>(
    contents: &str,
    f: impl FnOnce(&Path) -> Result<R, ForgeError>,
) -> Result<R, ForgeError> {
    let path = std::env::temp_dir().join(format!("mdium-forge-{}.txt", new_id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|err| ForgeError::command_failed(-1, &format!("temp body file: {err}")))?;
    let guard = TempFileGuard(path);
    file.write_all(contents.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|err| ForgeError::command_failed(-1, &format!("temp body file: {err}")))?;
    drop(file);
    let result = f(&guard.0);
    drop(guard);
    result
}

/// Parses a create-issue response: GitHub `{ number, html_url }`, GitLab
/// `{ iid, web_url }`.
pub fn parse_issue(kind: ForgeKind, stdout: &str) -> Result<IssueRefData, ForgeError> {
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|err| ForgeError::BadResponse(format!("issue json: {err}")))?;
    let (number_key, url_key) = match kind {
        ForgeKind::GitHub => ("number", "html_url"),
        ForgeKind::GitLab => ("iid", "web_url"),
    };
    let number = value
        .get(number_key)
        .and_then(|v| v.as_u64())
        .ok_or_else(|| ForgeError::BadResponse(format!("missing {number_key}")))?;
    let url = value
        .get(url_key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| ForgeError::BadResponse(format!("missing {url_key}")))?;
    Ok(IssueRefData {
        number,
        url: url.to_string(),
    })
}

/// Parses a (possibly paginated) comments/notes listing: one or more JSON
/// arrays back to back (how `--paginate` prints pages), each element an
/// object with a string `body`.
pub fn parse_comments(stdout: &str) -> Result<Vec<Comment>, ForgeError> {
    let mut comments = Vec::new();
    for page in serde_json::Deserializer::from_str(stdout).into_iter::<serde_json::Value>() {
        let page = page.map_err(|err| ForgeError::BadResponse(format!("comments json: {err}")))?;
        let items = page
            .as_array()
            .ok_or_else(|| ForgeError::BadResponse("comments page is not an array".into()))?;
        for item in items {
            let body = item
                .get("body")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ForgeError::BadResponse("comment without body".into()))?;
            comments.push(Comment {
                body: body.to_string(),
            });
        }
    }
    Ok(comments)
}

/// The real client: shells out to `gh` / `glab`.
pub struct CliForge;

impl CliForge {
    /// Runs the forge CLI with `args` and returns stdout. A missing program
    /// is `NotInstalled`; a non-zero exit is `CommandFailed`.
    fn run(kind: ForgeKind, args: &[String]) -> Result<String, ForgeError> {
        let mut cmd = Command::new(program(kind));
        cmd.args(args)
            .stdin(Stdio::null())
            // Never block on an interactive prompt.
            .env("GH_PROMPT_DISABLED", "1")
            .env("NO_PROMPT", "1");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let output = cmd.output().map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                ForgeError::NotInstalled
            } else {
                ForgeError::command_failed(-1, &err.to_string())
            }
        })?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(ForgeError::command_failed(
                output.status.code().unwrap_or(-1),
                &String::from_utf8_lossy(&output.stderr),
            ))
        }
    }
}

impl ForgeCli for CliForge {
    fn available(&self, kind: ForgeKind) -> bool {
        CliForge::run(kind, &["--version".to_string()]).is_ok()
    }

    fn is_authenticated(&self, kind: ForgeKind, host: &str) -> bool {
        let repo = ForgeRepo {
            kind,
            host: host.to_string(),
            path: String::new(),
        };
        CliForge::run(kind, &build_args(&repo, &ForgeOp::AuthStatus { host })).is_ok()
    }

    fn create_issue(
        &self,
        repo: &ForgeRepo,
        title: &str,
        body: &str,
    ) -> Result<IssueRefData, ForgeError> {
        let contents = match repo.kind {
            ForgeKind::GitHub => body.to_string(),
            ForgeKind::GitLab => {
                serde_json::json!({ "title": title, "description": body }).to_string()
            }
        };
        let stdout = with_temp_body(&contents, |body_file| {
            CliForge::run(
                repo.kind,
                &build_args(repo, &ForgeOp::CreateIssue { title, body_file }),
            )
        })?;
        parse_issue(repo.kind, &stdout)
    }

    fn list_comments(&self, repo: &ForgeRepo, number: u64) -> Result<Vec<Comment>, ForgeError> {
        let stdout = CliForge::run(
            repo.kind,
            &build_args(repo, &ForgeOp::ListComments { number }),
        )?;
        parse_comments(&stdout)
    }

    fn add_comment(&self, repo: &ForgeRepo, number: u64, body: &str) -> Result<(), ForgeError> {
        let contents = match repo.kind {
            ForgeKind::GitHub => body.to_string(),
            ForgeKind::GitLab => serde_json::json!({ "body": body }).to_string(),
        };
        with_temp_body(&contents, |body_file| {
            CliForge::run(
                repo.kind,
                &build_args(repo, &ForgeOp::AddComment { number, body_file }),
            )
        })?;
        Ok(())
    }

    fn close_issue(&self, repo: &ForgeRepo, number: u64) -> Result<(), ForgeError> {
        CliForge::run(
            repo.kind,
            &build_args(repo, &ForgeOp::CloseIssue { number }),
        )?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

/// A recorded [`FakeForge`] call.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeCall {
    Available(ForgeKind),
    IsAuthenticated(ForgeKind, String),
    CreateIssue { title: String, body: String },
    ListComments(u64),
    AddComment { number: u64, body: String },
    CloseIssue(u64),
}

/// Which [`FakeForge`] operation a configured failure applies to.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FakeOp {
    CreateIssue,
    ListComments,
    AddComment,
    CloseIssue,
}

#[cfg(test)]
#[derive(Default)]
struct FakeState {
    calls: Vec<ForgeCall>,
    available: std::collections::HashSet<ForgeKind>,
    authenticated: std::collections::HashSet<(ForgeKind, String)>,
    failures: std::collections::HashMap<FakeOp, ForgeError>,
    comments: std::collections::BTreeMap<u64, Vec<Comment>>,
    closed: Vec<u64>,
    next_number: u64,
}

/// In-memory forge for tests: records every call, stores Issues' comments,
/// and fails configured operations until the failure is cleared.
#[cfg(test)]
pub struct FakeForge {
    state: std::sync::Mutex<FakeState>,
}

#[cfg(test)]
impl FakeForge {
    /// Both CLIs available; none authenticated; no failures.
    pub fn new() -> Self {
        let state = FakeState {
            available: [ForgeKind::GitHub, ForgeKind::GitLab].into_iter().collect(),
            next_number: 1,
            ..FakeState::default()
        };
        FakeForge {
            state: std::sync::Mutex::new(state),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn set_available(&self, kind: ForgeKind, available: bool) {
        let mut state = self.lock();
        if available {
            state.available.insert(kind);
        } else {
            state.available.remove(&kind);
        }
    }

    pub fn set_authenticated(&self, kind: ForgeKind, host: &str, authenticated: bool) {
        let mut state = self.lock();
        let key = (kind, host.to_string());
        if authenticated {
            state.authenticated.insert(key);
        } else {
            state.authenticated.remove(&key);
        }
    }

    /// Makes `op` fail with `err` (`None` clears it) until changed again.
    pub fn set_failure(&self, op: FakeOp, err: Option<ForgeError>) {
        let mut state = self.lock();
        match err {
            Some(err) => state.failures.insert(op, err),
            None => state.failures.remove(&op),
        };
    }

    /// Pre-seeds (or replaces) an Issue's comments.
    pub fn set_comments(&self, number: u64, bodies: &[&str]) {
        self.lock().comments.insert(
            number,
            bodies
                .iter()
                .map(|b| Comment {
                    body: b.to_string(),
                })
                .collect(),
        );
    }

    pub fn calls(&self) -> Vec<ForgeCall> {
        self.lock().calls.clone()
    }

    pub fn clear_calls(&self) {
        self.lock().calls.clear();
    }

    pub fn comments(&self, number: u64) -> Vec<Comment> {
        self.lock()
            .comments
            .get(&number)
            .cloned()
            .unwrap_or_default()
    }

    pub fn closed(&self) -> Vec<u64> {
        self.lock().closed.clone()
    }

    fn check(state: &FakeState, op: FakeOp) -> Result<(), ForgeError> {
        match state.failures.get(&op) {
            Some(err) => Err(err.clone()),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
impl Default for FakeForge {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl ForgeCli for FakeForge {
    fn available(&self, kind: ForgeKind) -> bool {
        let mut state = self.lock();
        state.calls.push(ForgeCall::Available(kind));
        state.available.contains(&kind)
    }

    fn is_authenticated(&self, kind: ForgeKind, host: &str) -> bool {
        let mut state = self.lock();
        state
            .calls
            .push(ForgeCall::IsAuthenticated(kind, host.to_string()));
        state.available.contains(&kind) && state.authenticated.contains(&(kind, host.to_string()))
    }

    fn create_issue(
        &self,
        _repo: &ForgeRepo,
        title: &str,
        body: &str,
    ) -> Result<IssueRefData, ForgeError> {
        let mut state = self.lock();
        state.calls.push(ForgeCall::CreateIssue {
            title: title.to_string(),
            body: body.to_string(),
        });
        Self::check(&state, FakeOp::CreateIssue)?;
        let number = state.next_number;
        state.next_number += 1;
        state.comments.entry(number).or_default();
        Ok(IssueRefData {
            number,
            url: format!("https://forge.test/issues/{number}"),
        })
    }

    fn list_comments(&self, _repo: &ForgeRepo, number: u64) -> Result<Vec<Comment>, ForgeError> {
        let mut state = self.lock();
        state.calls.push(ForgeCall::ListComments(number));
        Self::check(&state, FakeOp::ListComments)?;
        Ok(state.comments.get(&number).cloned().unwrap_or_default())
    }

    fn add_comment(&self, _repo: &ForgeRepo, number: u64, body: &str) -> Result<(), ForgeError> {
        let mut state = self.lock();
        state.calls.push(ForgeCall::AddComment {
            number,
            body: body.to_string(),
        });
        Self::check(&state, FakeOp::AddComment)?;
        state.comments.entry(number).or_default().push(Comment {
            body: body.to_string(),
        });
        Ok(())
    }

    fn close_issue(&self, _repo: &ForgeRepo, number: u64) -> Result<(), ForgeError> {
        let mut state = self.lock();
        state.calls.push(ForgeCall::CloseIssue(number));
        Self::check(&state, FakeOp::CloseIssue)?;
        state.closed.push(number);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn some(host: &str, path: &str) -> Option<(String, String)> {
        Some((host.to_string(), path.to_string()))
    }

    #[test]
    fn parse_remote_url_table() {
        let cases: &[(&str, Option<(String, String)>)] = &[
            (
                "https://github.com/owner/repo.git",
                some("github.com", "owner/repo"),
            ),
            (
                "https://github.com/owner/repo",
                some("github.com", "owner/repo"),
            ),
            (
                "https://github.com/owner/repo/",
                some("github.com", "owner/repo"),
            ),
            (
                "https://github.com/owner/repo.git/",
                some("github.com", "owner/repo"),
            ),
            (
                "HTTPS://GitHub.com/Owner/Repo",
                some("github.com", "Owner/Repo"),
            ),
            ("http://git.example.com/a/b", some("git.example.com", "a/b")),
            (
                "https://user:tok@github.com/owner/repo.git",
                some("github.com", "owner/repo"),
            ),
            (
                "https://gitlab.example.com:8443/group/sub/project.git",
                some("gitlab.example.com:8443", "group/sub/project"),
            ),
            (
                "git@github.com:owner/repo.git",
                some("github.com", "owner/repo"),
            ),
            (
                "git@gitlab.com:group/sub/proj",
                some("gitlab.com", "group/sub/proj"),
            ),
            (
                "gitlab.com:group/proj.git",
                some("gitlab.com", "group/proj"),
            ),
            (
                "ssh://git@gitlab.com/group/sub/sub2/proj.git",
                some("gitlab.com", "group/sub/sub2/proj"),
            ),
            (
                "ssh://git@git.example.com:2222/team/app.git",
                some("git.example.com", "team/app"),
            ),
            (
                "ssh://git.example.com/team/my_app-1.x",
                some("git.example.com", "team/my_app-1.x"),
            ),
            ("  https://github.com/o/r.git\n", some("github.com", "o/r")),
            // Invalid.
            ("", None),
            ("https://github.com", None),
            ("https://github.com/", None),
            ("https://github.com/onlyone", None),
            ("https://github.com/o/../r", None),
            ("https://github.com//r", None),
            ("https://github.com/o/r%20x", None),
            ("https://github.com:abc/o/r", None),
            ("https://-bad.com/o/r", None),
            ("file:///srv/git/o/r.git", None),
            ("git://github.com/o/r.git", None),
            ("/srv/git/o/r.git", None),
            ("../other/repo", None),
            ("C:/repos/o/r", None),
            ("C:\\repos\\o\\r", None),
            ("git@github.com:", None),
            ("git@github.com:o r/x", None),
        ];
        for (url, expected) in cases {
            assert_eq!(&parse_remote_url(url), expected, "url: {url:?}");
        }
    }

    fn repo(kind: ForgeKind, host: &str, path: &str) -> ForgeRepo {
        ForgeRepo {
            kind,
            host: host.to_string(),
            path: path.to_string(),
        }
    }

    #[test]
    fn detect_from_url_well_known_hosts_need_no_probe() {
        let fake = FakeForge::new();
        assert_eq!(
            detect_from_url("git@github.com:o/r.git", &fake),
            Some(repo(ForgeKind::GitHub, "github.com", "o/r"))
        );
        assert_eq!(
            detect_from_url("https://gitlab.com/g/s/p.git", &fake),
            Some(repo(ForgeKind::GitLab, "gitlab.com", "g/s/p"))
        );
        assert!(fake.calls().is_empty(), "{:?}", fake.calls());
    }

    #[test]
    fn detect_from_url_rejects_nested_github_paths() {
        let fake = FakeForge::new();
        assert_eq!(detect_from_url("https://github.com/a/b/c", &fake), None);
    }

    #[test]
    fn detect_from_url_self_hosted_resolved_by_auth_probe() {
        let fake = FakeForge::new();
        fake.set_authenticated(ForgeKind::GitHub, "ghe.corp", true);
        fake.set_authenticated(ForgeKind::GitLab, "gl.corp", true);
        assert_eq!(
            detect_from_url("https://ghe.corp/o/r", &fake),
            Some(repo(ForgeKind::GitHub, "ghe.corp", "o/r"))
        );
        assert_eq!(
            detect_from_url("git@gl.corp:g/s/p.git", &fake),
            Some(repo(ForgeKind::GitLab, "gl.corp", "g/s/p"))
        );
        assert_eq!(
            fake.calls(),
            vec![
                ForgeCall::IsAuthenticated(ForgeKind::GitHub, "ghe.corp".into()),
                ForgeCall::IsAuthenticated(ForgeKind::GitHub, "gl.corp".into()),
                ForgeCall::IsAuthenticated(ForgeKind::GitLab, "gl.corp".into()),
            ]
        );
        assert_eq!(detect_from_url("https://unknown.corp/o/r", &fake), None);
    }

    /// Creates a temp git repository, optionally with an `origin` remote.
    fn temp_repo(origin: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let out = run_git_raw(dir.path(), &["init", "-q"]).unwrap();
        assert!(out.success, "{}", out.stderr);
        if let Some(url) = origin {
            let out = run_git_raw(dir.path(), &["remote", "add", "origin", url]).unwrap();
            assert!(out.success, "{}", out.stderr);
        }
        dir
    }

    #[test]
    fn detect_reads_origin() {
        let fake = FakeForge::new();
        let gh = temp_repo(Some("https://github.com/o/r.git"));
        assert_eq!(
            detect(gh.path(), &fake).unwrap(),
            Some(repo(ForgeKind::GitHub, "github.com", "o/r"))
        );
        let gl = temp_repo(Some("git@gitlab.com:g/sub/p.git"));
        assert_eq!(
            detect(gl.path(), &fake).unwrap(),
            Some(repo(ForgeKind::GitLab, "gitlab.com", "g/sub/p"))
        );
        fake.set_authenticated(ForgeKind::GitLab, "git.corp", true);
        let hosted = temp_repo(Some("ssh://git@git.corp:2222/team/app.git"));
        assert_eq!(
            detect(hosted.path(), &fake).unwrap(),
            Some(repo(ForgeKind::GitLab, "git.corp", "team/app"))
        );
    }

    #[test]
    fn detect_without_forge_is_none() {
        let fake = FakeForge::new();
        let no_origin = temp_repo(None);
        assert_eq!(detect(no_origin.path(), &fake).unwrap(), None);
        let local = temp_repo(Some("/srv/git/app.git"));
        assert_eq!(detect(local.path(), &fake).unwrap(), None);
        let unknown = temp_repo(Some("https://git.corp/team/app.git"));
        assert_eq!(detect(unknown.path(), &fake).unwrap(), None);
        let not_a_repo = tempfile::tempdir().unwrap();
        assert_eq!(detect(not_a_repo.path(), &fake).unwrap(), None);
    }

    #[test]
    fn probe_reports_cli_and_auth() {
        let gh = temp_repo(Some("https://github.com/o/r.git"));

        let fake = FakeForge::new();
        fake.set_authenticated(ForgeKind::GitHub, "github.com", true);
        assert_eq!(
            probe(gh.path(), &fake),
            ForgeProbe {
                repo: Some(repo(ForgeKind::GitHub, "github.com", "o/r")),
                cli_available: true,
                authenticated: true,
            }
        );

        let unauthenticated = FakeForge::new();
        assert_eq!(
            probe(gh.path(), &unauthenticated),
            ForgeProbe {
                repo: Some(repo(ForgeKind::GitHub, "github.com", "o/r")),
                cli_available: true,
                authenticated: false,
            }
        );

        let missing = FakeForge::new();
        missing.set_available(ForgeKind::GitHub, false);
        missing.set_authenticated(ForgeKind::GitHub, "github.com", true);
        assert_eq!(
            probe(gh.path(), &missing),
            ForgeProbe {
                repo: Some(repo(ForgeKind::GitHub, "github.com", "o/r")),
                cli_available: false,
                authenticated: false,
            }
        );

        let none = temp_repo(None);
        assert_eq!(
            probe(none.path(), &FakeForge::new()),
            ForgeProbe {
                repo: None,
                cli_available: true,
                authenticated: false,
            }
        );
        let nothing = FakeForge::new();
        nothing.set_available(ForgeKind::GitHub, false);
        nothing.set_available(ForgeKind::GitLab, false);
        assert!(!probe(none.path(), &nothing).cli_available);
    }

    #[test]
    fn probe_serializes_camel_case() {
        let value = serde_json::to_value(ForgeProbe {
            repo: Some(repo(ForgeKind::GitLab, "gitlab.com", "g/p")),
            cli_available: true,
            authenticated: false,
        })
        .unwrap();
        assert_eq!(
            value,
            json!({
                "repo": { "kind": "gitlab", "host": "gitlab.com", "path": "g/p" },
                "cliAvailable": true,
                "authenticated": false,
            })
        );
    }

    fn strs(args: &[String]) -> Vec<&str> {
        args.iter().map(String::as_str).collect()
    }

    #[test]
    fn build_args_github() {
        let r = repo(ForgeKind::GitHub, "ghe.corp", "o/r");
        let file = Path::new("/tmp/body.txt");
        assert_eq!(
            strs(&build_args(&r, &ForgeOp::AuthStatus { host: "ghe.corp" })),
            ["auth", "status", "--hostname", "ghe.corp"]
        );
        assert_eq!(
            strs(&build_args(
                &r,
                &ForgeOp::CreateIssue {
                    title: "Fix = bug",
                    body_file: file
                }
            )),
            [
                "api",
                "--hostname",
                "ghe.corp",
                "--method",
                "POST",
                "repos/o/r/issues",
                "-f",
                "title=Fix = bug",
                "-F",
                &format!("body=@{}", file.display()),
            ]
        );
        assert_eq!(
            strs(&build_args(&r, &ForgeOp::ListComments { number: 7 })),
            [
                "api",
                "--hostname",
                "ghe.corp",
                "--method",
                "GET",
                "--paginate",
                "repos/o/r/issues/7/comments?per_page=100",
            ]
        );
        assert_eq!(
            strs(&build_args(
                &r,
                &ForgeOp::AddComment {
                    number: 7,
                    body_file: file
                }
            )),
            [
                "api",
                "--hostname",
                "ghe.corp",
                "--method",
                "POST",
                "repos/o/r/issues/7/comments",
                "-F",
                &format!("body=@{}", file.display()),
            ]
        );
        assert_eq!(
            strs(&build_args(&r, &ForgeOp::CloseIssue { number: 7 })),
            [
                "api",
                "--hostname",
                "ghe.corp",
                "--method",
                "PATCH",
                "repos/o/r/issues/7",
                "-f",
                "state=closed",
            ]
        );
    }

    #[test]
    fn build_args_gitlab() {
        let r = repo(ForgeKind::GitLab, "gitlab.com", "group/sub.x/my_proj-1");
        let file = Path::new("/tmp/body.json");
        let file_str = file.display().to_string();
        assert_eq!(
            strs(&build_args(&r, &ForgeOp::AuthStatus { host: "gitlab.com" })),
            ["auth", "status", "--hostname", "gitlab.com"]
        );
        assert_eq!(
            strs(&build_args(
                &r,
                &ForgeOp::CreateIssue {
                    title: "ignored: title is in the JSON body",
                    body_file: file
                }
            )),
            [
                "api",
                "--hostname",
                "gitlab.com",
                "--method",
                "POST",
                "projects/group%2Fsub.x%2Fmy_proj-1/issues",
                "--header",
                "Content-Type: application/json",
                "--input",
                file_str.as_str(),
            ]
        );
        assert_eq!(
            strs(&build_args(&r, &ForgeOp::ListComments { number: 3 })),
            [
                "api",
                "--hostname",
                "gitlab.com",
                "--method",
                "GET",
                "--paginate",
                "projects/group%2Fsub.x%2Fmy_proj-1/issues/3/notes?per_page=100",
            ]
        );
        assert_eq!(
            strs(&build_args(
                &r,
                &ForgeOp::AddComment {
                    number: 3,
                    body_file: file
                }
            )),
            [
                "api",
                "--hostname",
                "gitlab.com",
                "--method",
                "POST",
                "projects/group%2Fsub.x%2Fmy_proj-1/issues/3/notes",
                "--header",
                "Content-Type: application/json",
                "--input",
                file_str.as_str(),
            ]
        );
        assert_eq!(
            strs(&build_args(&r, &ForgeOp::CloseIssue { number: 3 })),
            [
                "api",
                "--hostname",
                "gitlab.com",
                "--method",
                "PUT",
                "projects/group%2Fsub.x%2Fmy_proj-1/issues/3",
                "-f",
                "state_event=close",
            ]
        );
    }

    #[test]
    fn temp_body_is_written_then_removed() {
        let mut seen = None;
        let out = with_temp_body("hello\n<!-- mdium:entry:x -->", |path| {
            assert!(path.starts_with(std::env::temp_dir()));
            assert_eq!(
                std::fs::read_to_string(path).unwrap(),
                "hello\n<!-- mdium:entry:x -->"
            );
            seen = Some(path.to_path_buf());
            Ok(42)
        })
        .unwrap();
        assert_eq!(out, 42);
        assert!(!seen.unwrap().exists());
    }

    #[test]
    fn temp_body_is_removed_on_error() {
        let mut seen = None;
        let err = with_temp_body("x", |path| {
            seen = Some(path.to_path_buf());
            Err::<(), _>(ForgeError::command_failed(1, "boom"))
        })
        .unwrap_err();
        assert_eq!(err.code(), FORGE_COMMAND_FAILED);
        assert!(!seen.unwrap().exists());
    }

    #[test]
    fn parse_issue_both_kinds() {
        assert_eq!(
            parse_issue(
                ForgeKind::GitHub,
                r#"{"number":12,"html_url":"https://github.com/o/r/issues/12","id":999}"#
            )
            .unwrap(),
            IssueRefData {
                number: 12,
                url: "https://github.com/o/r/issues/12".into()
            }
        );
        assert_eq!(
            parse_issue(
                ForgeKind::GitLab,
                r#"{"id":5000,"iid":4,"web_url":"https://gitlab.com/g/p/-/issues/4"}"#
            )
            .unwrap(),
            IssueRefData {
                number: 4,
                url: "https://gitlab.com/g/p/-/issues/4".into()
            }
        );
        for bad in [
            "",
            "not json",
            r#"{"iid":4}"#,
            r#"{"number":"x","html_url":"u"}"#,
        ] {
            let err = parse_issue(ForgeKind::GitHub, bad).unwrap_err();
            assert_eq!(err.code(), FORGE_BAD_RESPONSE, "{bad:?}");
        }
    }

    #[test]
    fn parse_comments_merges_pages() {
        let stdout =
            "[{\"body\":\"a\",\"id\":1},{\"body\":\"b\"}]\n[{\"body\":\"c\",\"system\":false}]\n";
        let bodies: Vec<String> = parse_comments(stdout)
            .unwrap()
            .into_iter()
            .map(|c| c.body)
            .collect();
        assert_eq!(bodies, ["a", "b", "c"]);
        assert_eq!(parse_comments("[]").unwrap(), vec![]);
        assert_eq!(parse_comments("").unwrap(), vec![]);
        for bad in ["{}", "[{\"id\":1}]", "[1]", "[{\"body\":1}]", "[{"] {
            assert_eq!(
                parse_comments(bad).unwrap_err().code(),
                FORGE_BAD_RESPONSE,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn errors_have_codes_and_capped_stderr() {
        let long = "e".repeat(2000);
        let err = ForgeError::command_failed(2, &long);
        match &err {
            ForgeError::CommandFailed { code, stderr } => {
                assert_eq!(*code, 2);
                assert_eq!(stderr.chars().count(), 500);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(ForgeError::NotInstalled.code(), "FORGE_NOT_INSTALLED");
        assert_eq!(
            ForgeError::NotAuthenticated.code(),
            "FORGE_NOT_AUTHENTICATED"
        );
        assert_eq!(err.code(), "FORGE_COMMAND_FAILED");
        assert_eq!(
            ForgeError::BadResponse("x".into()).code(),
            "FORGE_BAD_RESPONSE"
        );
        let value = serde_json::to_value(ForgeError::BadResponse("x".into())).unwrap();
        assert_eq!(
            value,
            json!({ "code": "FORGE_BAD_RESPONSE", "message": "FORGE_BAD_RESPONSE: x" })
        );
    }

    #[test]
    fn fake_forge_records_stores_and_fails() {
        let fake = FakeForge::new();
        let r = repo(ForgeKind::GitHub, "github.com", "o/r");
        let issue = fake.create_issue(&r, "T", "B").unwrap();
        assert_eq!(issue.number, 1);
        fake.add_comment(&r, 1, "first").unwrap();
        assert_eq!(fake.list_comments(&r, 1).unwrap(), fake.comments(1));
        fake.set_failure(
            FakeOp::AddComment,
            Some(ForgeError::command_failed(1, "rate limited")),
        );
        assert_eq!(
            fake.add_comment(&r, 1, "second").unwrap_err().code(),
            FORGE_COMMAND_FAILED
        );
        assert_eq!(fake.comments(1).len(), 1);
        fake.set_failure(FakeOp::AddComment, None);
        fake.add_comment(&r, 1, "second").unwrap();
        fake.close_issue(&r, 1).unwrap();
        assert_eq!(fake.closed(), vec![1]);
        assert_eq!(fake.calls().len(), 6);
    }
}

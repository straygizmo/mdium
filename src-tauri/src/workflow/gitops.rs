//! Git worktree operations for workflow runs.
//!
//! Every function here is blocking and shells out to the user's `git` with
//! MDium's normal environment (not the containment env), mirroring
//! `commands/git.rs::run_git`. Callers run them off the main thread.

use crate::workflow::fsutil::is_valid_id;
use crate::workflow::model::WorktreeInfo;
use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

/// A failed git operation: a stable machine code (one of the `GIT_*`
/// constants below, read via [`GitError::code`]) plus git's stderr (or
/// other detail) for logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitError {
    code: &'static str,
    pub stderr: String,
}

/// One commit on the worktree branch since its base commit.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CommitSummary {
    pub hash: String,
    pub subject: String,
}

/// Error code for a git command that could not be spawned or exited non-zero.
pub const GIT_FAILED: &str = "GIT_FAILED";
/// A root task id is not a valid 16-hex id.
pub const GIT_INVALID_ID: &str = "GIT_INVALID_ID";
/// The path is not inside a git work tree.
pub const GIT_NOT_A_REPO: &str = "GIT_NOT_A_REPO";
/// The repository's HEAD is detached, so there is no base branch.
pub const GIT_DETACHED_HEAD: &str = "GIT_DETACHED_HEAD";
/// The worktree directory or its branch already exists.
pub const GIT_WORKTREE_EXISTS: &str = "GIT_WORKTREE_EXISTS";
/// A stored `WorktreeInfo` failed validation.
pub const GIT_INVALID_WORKTREE_INFO: &str = "GIT_INVALID_WORKTREE_INFO";
/// A worktree's link to the user's repository is not the one git created.
pub const GIT_WORKTREE_LINK_TAMPERED: &str = "GIT_WORKTREE_LINK_TAMPERED";
/// The user's checkout is not on the run's base branch.
pub const GIT_NOT_ON_BASE_BRANCH: &str = "GIT_NOT_ON_BASE_BRANCH";
/// The user's checkout has uncommitted changes.
pub const GIT_DIRTY_WORKTREE: &str = "GIT_DIRTY_WORKTREE";
/// A merge failed without starting; the repository is untouched.
pub const GIT_MERGE_FAILED: &str = "GIT_MERGE_FAILED";
/// A merge (or its abort) left the repository in a changed state.
pub const GIT_MERGE_ABORT_FAILED: &str = "GIT_MERGE_ABORT_FAILED";
/// A merge conflicted and was aborted cleanly.
pub const GIT_MERGE_CONFLICT: &str = "GIT_MERGE_CONFLICT";

/// Maximum slug length in a branch name.
const MAX_SLUG_LEN: usize = 40;

/// Branch namespace for all workflow branches.
const BRANCH_PREFIX: &str = "mdium/";

/// Number of task-id characters embedded in a branch name.
const BRANCH_ID_LEN: usize = 8;

/// Fallback identity values, used per field only when that field is not
/// configured for the repo.
const FALLBACK_NAME: &str = "user.name=MDium";
const FALLBACK_EMAIL: &str = "user.email=mdium@localhost";

impl GitError {
    pub(crate) fn new(code: &'static str, stderr: impl Into<String>) -> Self {
        GitError {
            code,
            stderr: stderr.into(),
        }
    }

    /// Stable machine code for this failure (a `GIT_*` constant).
    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let detail = self.stderr.trim();
        if detail.is_empty() {
            f.write_str(self.code)
        } else {
            write!(f, "{}: {detail}", self.code)
        }
    }
}

crate::workflow::errors::impl_workflow_error!(GitError);

// Extra environment for git children spawned on the current test thread,
// so tests can isolate git from the machine's global config without
// touching the process environment shared by parallel tests.
#[cfg(test)]
thread_local! {
    static TEST_GIT_ENV: std::cell::RefCell<Vec<(String, String)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Raw result of one git invocation.
pub(crate) struct GitOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `git -c core.quotePath=false <args>` in `repo` without a console
/// window, returning the raw outcome. Only a spawn failure is an error.
pub(crate) fn run_git_raw(repo: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.quotePath=false"])
        .args(args)
        .current_dir(repo);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    #[cfg(test)]
    TEST_GIT_ENV.with(|env| {
        for (key, value) in env.borrow().iter() {
            cmd.env(key, value);
        }
    });
    let output = cmd
        .output()
        .map_err(|err| GitError::new(GIT_FAILED, format!("failed to run git: {err}")))?;
    Ok(GitOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Runs git in `repo` and returns stdout, or `GIT_FAILED` with stderr.
pub fn git(repo: &Path, args: &[&str]) -> Result<String, GitError> {
    let output = run_git_raw(repo, args)?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(GitError::new(GIT_FAILED, output.stderr))
    }
}

/// True if `path` is inside a git work tree.
pub fn is_git_repo(path: &Path) -> bool {
    matches!(
        run_git_raw(path, &["rev-parse", "--is-inside-work-tree"]),
        Ok(output) if output.success && output.stdout.trim() == "true"
    )
}

/// The top-level directory of the work tree containing `path`.
pub fn repo_root(path: &Path) -> Result<PathBuf, GitError> {
    let out = git(path, &["rev-parse", "--show-toplevel"])?;
    Ok(PathBuf::from(out.trim()))
}

/// Base directory for worktrees: the local data dir, or the temp dir when
/// none is known.
pub(crate) fn default_worktree_base() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir)
}

/// `<base>/mdium/worktrees`, the only place MDium creates worktrees.
fn worktrees_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("mdium").join("worktrees")
}

/// `<local data dir>/mdium/worktrees/<16 hex of sha256(canonical common git
/// dir)>/<id>`. The repository is identified by its common git dir, so any
/// path inside the repo — and any linked worktree of it — maps to the same
/// worktree location.
pub fn worktree_path_for(repo_root: &Path, root_task_id: &str) -> PathBuf {
    worktree_path_in(&default_worktree_base(), repo_root, root_task_id)
}

/// [`worktree_path_for`] with an explicit base directory (tests use a
/// temporary one so they never touch the real local data dir).
fn worktree_path_in(base_dir: &Path, repo: &Path, root_task_id: &str) -> PathBuf {
    let identity = common_git_dir(repo).unwrap_or_else(|| repo.to_path_buf());
    let canonical = std::fs::canonicalize(&identity).unwrap_or(identity);
    worktrees_dir(base_dir)
        .join(repo_hash(&canonical))
        .join(root_task_id)
}

/// The absolute common git dir of the repository containing `path`, or
/// `None` outside a repository. Git prints it relative to the directory it
/// ran in, so it is queried from the work tree's top level.
fn common_git_dir(path: &Path) -> Option<PathBuf> {
    let top = repo_root(path).ok()?;
    let out = git(&top, &["rev-parse", "--git-common-dir"]).ok()?;
    let common = PathBuf::from(out.trim_end_matches(['\r', '\n']));
    Some(if common.is_absolute() {
        common
    } else {
        top.join(common)
    })
}

/// `mdium/<first 8 chars of id>-<slug>`. The slug keeps lowercase ASCII
/// letters/digits, collapses every other run to `-`, is trimmed of `-`,
/// capped at 40 chars, and falls back to `task` when empty.
pub fn branch_name(root_task_id: &str, title: &str) -> String {
    let slug = title_slug(title).unwrap_or_else(|| "task".to_string());
    let prefix: String = root_task_id.chars().take(BRANCH_ID_LEN).collect();
    format!("{BRANCH_PREFIX}{prefix}-{slug}")
}

/// The slug rules of [`branch_name`] without the fallback: lowercase ASCII
/// letters/digits, every other run collapsed to `-`, capped at 40 chars and
/// trimmed of `-`. `None` when nothing remains (e.g. a non-ASCII title).
pub(crate) fn title_slug(title: &str) -> Option<String> {
    let mut slug = String::new();
    for c in title.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    // The slug is pure ASCII, so byte truncation is char-safe.
    slug.truncate(MAX_SLUG_LEN);
    let slug = slug.trim_matches('-');
    (!slug.is_empty()).then(|| slug.to_string())
}

/// True if `branch` has the exact shape [`branch_name`] produces for a
/// valid task id: `mdium/<8 lowercase hex>-<1..=40 of [a-z0-9-]>`.
fn is_valid_branch(branch: &str) -> bool {
    let Some(rest) = branch.strip_prefix(BRANCH_PREFIX) else {
        return false;
    };
    let is_hex = |b: u8| matches!(b, b'0'..=b'9' | b'a'..=b'f');
    let bytes = rest.as_bytes();
    if bytes.len() < BRANCH_ID_LEN + 2
        || !bytes[..BRANCH_ID_LEN].iter().all(|b| is_hex(*b))
        || bytes[BRANCH_ID_LEN] != b'-'
    {
        return false;
    }
    let slug = &bytes[BRANCH_ID_LEN + 1..];
    slug.len() <= MAX_SLUG_LEN
        && slug
            .iter()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

/// Resolves `path` to a canonical absolute path even when its tail does not
/// exist (yet or anymore): the deepest existing ancestor is canonicalized
/// and the remaining components are appended. `None` if the path contains
/// `..` or no ancestor resolves.
fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let mut tail = Vec::new();
    let mut current = path;
    loop {
        if let Ok(canonical) = std::fs::canonicalize(current) {
            return Some(
                tail.iter()
                    .rev()
                    .fold(canonical, |acc: PathBuf, part: &OsString| acc.join(part)),
            );
        }
        tail.push(current.file_name()?.to_os_string());
        current = current.parent()?;
    }
}

/// True if `name` is a 16-lowercase-hex path component.
fn is_hex16_component(name: Option<&OsStr>) -> bool {
    name.and_then(OsStr::to_str).is_some_and(is_valid_id)
}

/// Confines a worktree path to the managed layout
/// `<base>/mdium/worktrees/<16 hex repo hash>/<16 hex id>`, compared on
/// canonical paths. With `repo`, the path must also be exactly the one
/// [`worktree_path_in`] derives for that repo and id.
fn validate_worktree_path(base_dir: &Path, repo: Option<&Path>, raw: &str) -> Result<(), GitError> {
    let invalid = || GitError::new(GIT_INVALID_WORKTREE_INFO, format!("path {raw:?}"));
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(invalid());
    }
    let target = canonicalize_lenient(path).ok_or_else(invalid)?;
    let managed = canonicalize_lenient(&worktrees_dir(base_dir)).ok_or_else(invalid)?;
    let hash_dir = target.parent().ok_or_else(invalid)?;
    if hash_dir.parent() != Some(managed.as_path())
        || !is_hex16_component(hash_dir.file_name())
        || !is_hex16_component(target.file_name())
    {
        return Err(invalid());
    }
    if let Some(repo) = repo {
        let id = target
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(invalid)?;
        let expected =
            canonicalize_lenient(&worktree_path_in(base_dir, repo, id)).ok_or_else(invalid)?;
        if expected != target {
            return Err(invalid());
        }
    }
    Ok(())
}

/// Guards every operation on a stored [`WorktreeInfo`]: its values end up
/// as git arguments and filesystem paths, so a tampered run file must never
/// be able to inject options or point git (or a deletion) anywhere but a
/// worktree MDium manages under `<base>/mdium/worktrees` — and, when `repo`
/// is given, the one belonging to that repo.
pub(crate) fn validate_info(
    base_dir: &Path,
    repo: Option<&Path>,
    info: &WorktreeInfo,
) -> Result<(), GitError> {
    let commit_ok = matches!(info.base_commit.len(), 40 | 64)
        && info
            .base_commit
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !commit_ok {
        return Err(GitError::new(
            GIT_INVALID_WORKTREE_INFO,
            format!("base_commit {:?}", info.base_commit),
        ));
    }
    if !is_valid_branch(&info.branch) {
        return Err(GitError::new(
            GIT_INVALID_WORKTREE_INFO,
            format!("branch {:?}", info.branch),
        ));
    }
    validate_worktree_path(base_dir, repo, &info.path)
}

/// Global options for every git command MDium runs inside an agent
/// worktree: never run an fsmonitor hook the agent may have configured.
const WORKTREE_SAFE_OPTS: [&str; 2] = ["-c", "core.fsmonitor=false"];

/// `WORKTREE_SAFE_OPTS` followed by `args`.
fn worktree_args<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut full = WORKTREE_SAFE_OPTS.to_vec();
    full.extend_from_slice(args);
    full
}

/// First 16 hex chars of sha256 over a repository's canonical common git
/// dir (the hash directory of that repo's worktrees).
fn repo_hash(canonical_common_dir: &Path) -> String {
    let digest = Sha256::digest(canonical_common_dir.to_string_lossy().as_bytes());
    format!("{digest:x}").chars().take(16).collect()
}

/// Reads a one-line path file (`.git`, `gitdir`, `commondir`), strips an
/// optional `prefix`, resolves a relative path against `base`, and
/// canonicalizes it. `None` on any failure.
fn read_link_file(file: &Path, prefix: &str, base: &Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(file).ok()?;
    let target = content.strip_prefix(prefix)?.trim_end_matches(['\r', '\n']);
    if target.is_empty() {
        return None;
    }
    std::fs::canonicalize(base.join(target)).ok()
}

/// Verifies that the agent worktree is still linked to the user's
/// repository exactly as git created it, so MDium's own git commands in the
/// worktree cannot be redirected to a git dir (and config) the agent
/// controls. Checks:
/// - `<worktree>/.git` is a regular file (not a directory or symlink)
///   whose `gitdir:` resolves to `<common>/worktrees/<name>`;
/// - the hash of `<common>` names the worktree's hash directory (binding
///   the link to the user's repository, whatever its git dir layout);
/// - the admin dir's `commondir` resolves to `<common>` and its `gitdir`
///   back-link resolves to `<worktree>/.git`.
///
/// Returns the canonical admin dir. Error: `GIT_WORKTREE_LINK_TAMPERED`.
pub(crate) fn verify_worktree_link(info: &WorktreeInfo) -> Result<PathBuf, GitError> {
    let tampered =
        |what: &str| GitError::new(GIT_WORKTREE_LINK_TAMPERED, format!("{what}: {}", info.path));
    let wt = std::fs::canonicalize(&info.path).map_err(|_| tampered("worktree"))?;
    let dot_git = wt.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).map_err(|_| tampered(".git"))?;
    if !meta.file_type().is_file() {
        return Err(tampered(".git"));
    }
    let admin = read_link_file(&dot_git, "gitdir: ", &wt).ok_or_else(|| tampered(".git"))?;
    let worktrees = admin.parent().ok_or_else(|| tampered("gitdir"))?;
    let common = worktrees.parent().ok_or_else(|| tampered("gitdir"))?;
    let hash_dir = wt.parent().and_then(Path::file_name);
    if worktrees.file_name() != Some(OsStr::new("worktrees"))
        || hash_dir != Some(OsStr::new(&repo_hash(common)))
    {
        return Err(tampered("gitdir"));
    }
    let commondir = read_link_file(&admin.join("commondir"), "", &admin);
    if commondir.as_deref() != Some(common) {
        return Err(tampered("commondir"));
    }
    let backlink = read_link_file(&admin.join("gitdir"), "", &admin);
    if backlink.as_deref() != Some(dot_git.as_path()) {
        return Err(tampered("backlink"));
    }
    Ok(admin)
}

/// [`validate_info`] plus [`verify_worktree_link`]: the guard for every
/// operation that runs git inside the worktree.
pub(crate) fn validate_worktree(base_dir: &Path, info: &WorktreeInfo) -> Result<(), GitError> {
    validate_info(base_dir, None, info)?;
    verify_worktree_link(info).map(|_| ())
}

/// Runs git inside a verified agent worktree with [`WORKTREE_SAFE_OPTS`],
/// returning stdout or `GIT_FAILED`.
pub(crate) fn worktree_git(wt: &Path, args: &[&str]) -> Result<String, GitError> {
    git(wt, &worktree_args(args))
}

/// Creates the run's worktree on a new branch off the repo's current HEAD.
/// Errors: `GIT_INVALID_ID`, `GIT_NOT_A_REPO`, `GIT_DETACHED_HEAD`, `GIT_WORKTREE_EXISTS`.
pub fn create_worktree(
    repo_root: &Path,
    root_task_id: &str,
    title: &str,
) -> Result<WorktreeInfo, GitError> {
    create_worktree_in(&default_worktree_base(), repo_root, root_task_id, title)
}

pub(crate) fn create_worktree_in(
    base_dir: &Path,
    repo: &Path,
    root_task_id: &str,
    title: &str,
) -> Result<WorktreeInfo, GitError> {
    if !is_valid_id(root_task_id) {
        return Err(GitError::new(GIT_INVALID_ID, root_task_id));
    }
    if !is_git_repo(repo) {
        return Err(GitError::new(
            GIT_NOT_A_REPO,
            repo.to_string_lossy().into_owned(),
        ));
    }
    let top = repo_root(repo)?;
    let base_branch =
        current_branch(&top)?.ok_or_else(|| GitError::new(GIT_DETACHED_HEAD, String::new()))?;
    let base_commit = git(&top, &["rev-parse", "HEAD"])?.trim().to_string();

    let path = worktree_path_in(base_dir, &top, root_task_id);
    let branch = branch_name(root_task_id, title);
    if path.exists() {
        return Err(GitError::new(
            GIT_WORKTREE_EXISTS,
            path.to_string_lossy().into_owned(),
        ));
    }
    if branch_exists(&top, &branch)? {
        return Err(GitError::new(GIT_WORKTREE_EXISTS, branch));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| GitError::new(GIT_FAILED, err.to_string()))?;
    }
    let path_str = path.to_string_lossy().into_owned();
    if let Err(err) = git(&top, &["worktree", "add", "-b", &branch, &path_str, "HEAD"]) {
        // The branch did not exist before; don't leave a half-created one.
        if branch_exists(&top, &branch).unwrap_or(false) {
            let _ = run_git_raw(&top, &["branch", "-D", &branch]);
        }
        return Err(err);
    }

    Ok(WorktreeInfo {
        path: path_str,
        branch,
        base_branch,
        base_commit,
    })
}

/// The checked-out branch name, or `None` on a detached HEAD.
fn current_branch(repo: &Path) -> Result<Option<String>, GitError> {
    let output = run_git_raw(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let name = output.stdout.trim();
    Ok((output.success && !name.is_empty()).then(|| name.to_string()))
}

/// True if `refs/heads/<branch>` exists in `repo`.
fn branch_exists(repo: &Path, branch: &str) -> Result<bool, GitError> {
    let reference = format!("refs/heads/{branch}");
    Ok(run_git_raw(repo, &["show-ref", "--verify", "--quiet", &reference])?.success)
}

/// True if `git config <key>` yields a non-empty value in `repo`.
fn config_is_set(repo: &Path, key: &str) -> Result<bool, GitError> {
    let output = run_git_raw(repo, &["config", key])?;
    Ok(output.success && !output.stdout.trim().is_empty())
}

/// Runs git with fallback `-c user.name=...` / `-c user.email=...` for
/// whichever identity field is not configured for `repo`, so commits never
/// fail on a fresh machine.
fn git_with_identity(repo: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    let mut full: Vec<&str> = Vec::new();
    if !config_is_set(repo, "user.name")? {
        full.extend_from_slice(&["-c", FALLBACK_NAME]);
    }
    if !config_is_set(repo, "user.email")? {
        full.extend_from_slice(&["-c", FALLBACK_EMAIL]);
    }
    full.extend_from_slice(args);
    run_git_raw(repo, &full)
}

/// The worktree's diff against its base commit (committed + uncommitted
/// tracked changes), followed by a `# Untracked files` section listing
/// untracked, non-ignored paths when there are any.
///
/// Note: `--end-of-options` (used here and below to keep stored revisions
/// from being parsed as options) requires git >= 2.24.
pub fn diff_against_base(info: &WorktreeInfo) -> Result<String, GitError> {
    diff_against_base_in(&default_worktree_base(), info)
}

pub(crate) fn diff_against_base_in(
    base_dir: &Path,
    info: &WorktreeInfo,
) -> Result<String, GitError> {
    validate_worktree(base_dir, info)?;
    let wt = Path::new(&info.path);
    let mut out = worktree_git(
        wt,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--end-of-options",
            &info.base_commit,
            "--",
        ],
    )?;
    let untracked = worktree_git(wt, &["ls-files", "--others", "--exclude-standard"])?;
    let untracked: Vec<&str> = untracked.lines().filter(|l| !l.is_empty()).collect();
    if !untracked.is_empty() {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("# Untracked files\n");
        for path in untracked {
            out.push_str(path);
            out.push('\n');
        }
    }
    Ok(out)
}

/// Commits on the worktree branch since its base commit, oldest first.
pub fn commits_since_base(info: &WorktreeInfo) -> Result<Vec<CommitSummary>, GitError> {
    commits_since_base_in(&default_worktree_base(), info)
}

pub(crate) fn commits_since_base_in(
    base_dir: &Path,
    info: &WorktreeInfo,
) -> Result<Vec<CommitSummary>, GitError> {
    validate_worktree(base_dir, info)?;
    let range = format!("{}..HEAD", info.base_commit);
    let out = worktree_git(
        Path::new(&info.path),
        &[
            "log",
            "--reverse",
            "--format=%H%x1f%s",
            "--end-of-options",
            &range,
            "--",
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|line| line.split_once('\u{1f}'))
        .map(|(hash, subject)| CommitSummary {
            hash: hash.to_string(),
            subject: subject.to_string(),
        })
        .collect())
}

/// Stages `paths` (taken literally, no glob magic) and commits exactly
/// those paths (other staged work is left staged). Returns the new commit
/// hash, or `None` when the paths had no changes.
pub fn commit_paths(
    info: &WorktreeInfo,
    paths: &[&str],
    message: &str,
) -> Result<Option<String>, GitError> {
    commit_paths_in(&default_worktree_base(), info, paths, message)
}

pub(crate) fn commit_paths_in(
    base_dir: &Path,
    info: &WorktreeInfo,
    paths: &[&str],
    message: &str,
) -> Result<Option<String>, GitError> {
    validate_worktree(base_dir, info)?;
    if paths.is_empty() {
        return Ok(None);
    }
    let wt = Path::new(&info.path);
    let mut add = worktree_args(&["--literal-pathspecs", "add", "--"]);
    add.extend_from_slice(paths);
    git(wt, &add)?;

    let mut staged = worktree_args(&["--literal-pathspecs", "diff", "--cached", "--quiet", "--"]);
    staged.extend_from_slice(paths);
    if run_git_raw(wt, &staged)?.success {
        return Ok(None);
    }

    // Hooks stay enabled for the commit itself: they are the user's own.
    let mut commit = worktree_args(&["--literal-pathspecs", "commit", "-m", message, "--"]);
    commit.extend_from_slice(paths);
    let output = git_with_identity(wt, &commit)?;
    if !output.success {
        return Err(GitError::new(GIT_FAILED, output.stderr));
    }
    Ok(Some(
        worktree_git(wt, &["rev-parse", "HEAD"])?.trim().to_string(),
    ))
}

/// True if a merge is in progress in `repo`.
fn merge_in_progress(repo: &Path) -> Result<bool, GitError> {
    Ok(checkout_git_raw(repo, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])?.success)
}

/// Runs git in the user's checkout during a merge with
/// [`WORKTREE_SAFE_OPTS`] (the agent could have configured an fsmonitor
/// hook in the shared git config), returning stdout or `GIT_FAILED`.
fn checkout_git(repo: &Path, args: &[&str]) -> Result<String, GitError> {
    git(repo, &worktree_args(args))
}

/// [`checkout_git`] returning the raw outcome.
fn checkout_git_raw(repo: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    run_git_raw(repo, &worktree_args(args))
}

/// Merges the worktree branch into the base branch of the user's checkout
/// with `--no-ff`, returning the merge commit hash. Refuses unless the
/// checkout is on `base_branch` (`GIT_NOT_ON_BASE_BRANCH`) and has no
/// staged or unstaged changes to tracked files (`GIT_DIRTY_WORKTREE`;
/// untracked files such as `.mdium/` are normal user activity and ignored).
/// A conflicted merge is aborted (`GIT_MERGE_CONFLICT`,
/// or `GIT_MERGE_ABORT_FAILED` if the repo could not be restored); a merge that
/// fails without starting (missing branch, hook rejection, ...) is
/// `GIT_MERGE_FAILED`.
pub fn merge_into_base(repo_root: &Path, info: &WorktreeInfo) -> Result<String, GitError> {
    merge_into_base_in(&default_worktree_base(), repo_root, info)
}

pub(crate) fn merge_into_base_in(
    base_dir: &Path,
    repo_root: &Path,
    info: &WorktreeInfo,
) -> Result<String, GitError> {
    validate_info(base_dir, Some(repo_root), info)?;
    let current = current_branch(repo_root)?;
    if current.as_deref() != Some(info.base_branch.as_str()) {
        return Err(GitError::new(
            GIT_NOT_ON_BASE_BRANCH,
            current.unwrap_or_default(),
        ));
    }
    let status = checkout_git(
        repo_root,
        &["status", "--porcelain", "--untracked-files=no"],
    )?;
    if !status.trim().is_empty() {
        return Err(GitError::new(GIT_DIRTY_WORKTREE, status));
    }

    let before = checkout_git(repo_root, &["rev-parse", "HEAD"])?
        .trim()
        .to_string();
    let branch_ref = format!("refs/heads/{}", info.branch);
    let output = git_with_identity(
        repo_root,
        &[
            WORKTREE_SAFE_OPTS[0],
            WORKTREE_SAFE_OPTS[1],
            "merge",
            "--no-ff",
            "--no-edit",
            "--end-of-options",
            &branch_ref,
        ],
    )?;
    if output.success {
        return Ok(checkout_git(repo_root, &["rev-parse", "HEAD"])?
            .trim()
            .to_string());
    }

    let merge_detail = format!("{}{}", output.stdout, output.stderr);
    if !merge_in_progress(repo_root)? {
        // The merge never started; make sure it left nothing behind.
        let after = checkout_git_raw(repo_root, &["rev-parse", "HEAD"])?;
        let status = checkout_git_raw(
            repo_root,
            &["status", "--porcelain", "--untracked-files=no"],
        )?;
        let untouched = after.success
            && after.stdout.trim() == before
            && status.success
            && status.stdout.trim().is_empty();
        let code = if untouched {
            GIT_MERGE_FAILED
        } else {
            GIT_MERGE_ABORT_FAILED
        };
        return Err(GitError::new(code, merge_detail));
    }
    let abort = checkout_git_raw(repo_root, &["merge", "--abort"])?;
    let after = checkout_git_raw(repo_root, &["rev-parse", "HEAD"])?;
    let restored = abort.success
        && !merge_in_progress(repo_root)?
        && after.success
        && after.stdout.trim() == before;
    if !restored {
        return Err(GitError::new(
            GIT_MERGE_ABORT_FAILED,
            format!("{merge_detail}{}", abort.stderr),
        ));
    }
    Err(GitError::new(GIT_MERGE_CONFLICT, merge_detail))
}

/// Removes the run's worktree (discarding its changes) and deletes its
/// branch. A worktree or branch that is already gone is not an error.
pub fn discard(repo_root: &Path, info: &WorktreeInfo) -> Result<(), GitError> {
    discard_in(&default_worktree_base(), repo_root, info)
}

/// [`discard`] with an explicit worktree base directory. The path is
/// confined by [`validate_info`] to this repo's managed worktree location,
/// so a leftover directory git no longer knows as a worktree can be deleted
/// without ever touching an arbitrary folder.
pub(crate) fn discard_in(
    base_dir: &Path,
    repo_root: &Path,
    info: &WorktreeInfo,
) -> Result<(), GitError> {
    validate_info(base_dir, Some(repo_root), info)?;
    let path = Path::new(&info.path);
    let removed = run_git_raw(
        repo_root,
        &["worktree", "remove", "--force", "--force", &info.path],
    )?;
    if !removed.success && path.exists() {
        if is_registered_worktree(repo_root, path)? {
            return Err(GitError::new(GIT_FAILED, removed.stderr));
        }
        std::fs::remove_dir_all(path).map_err(|err| GitError::new(GIT_FAILED, err.to_string()))?;
    }
    if !removed.success {
        // Drop any stale registration so the branch is no longer considered
        // checked out.
        git(repo_root, &["worktree", "prune"])?;
    }
    if branch_exists(repo_root, &info.branch)? {
        git(repo_root, &["branch", "-D", &info.branch])?;
    }
    Ok(())
}

/// True if `path` is one of the worktrees git has registered for
/// `repo_root` (compared after canonicalization).
fn is_registered_worktree(repo_root: &Path, path: &Path) -> Result<bool, GitError> {
    let Ok(target) = std::fs::canonicalize(path) else {
        return Ok(false);
    };
    let list = git(repo_root, &["worktree", "list", "--porcelain"])?;
    Ok(list
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .filter_map(|listed| std::fs::canonicalize(listed).ok())
        .any(|listed| listed == target))
}

/// Real-git test fixtures shared by the workflow modules' tests.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    pub(crate) const TASK_ID: &str = "0123456789abcdef";

    /// A throwaway repo on `main` with one commit, plus a separate base dir
    /// for worktrees so tests never touch the real local data dir.
    pub(crate) struct Fixture {
        pub repo: TempDir,
        pub worktrees: TempDir,
    }

    impl Fixture {
        pub(crate) fn new() -> Self {
            let repo = TempDir::new().unwrap();
            let worktrees = TempDir::new().unwrap();
            let fixture = Fixture { repo, worktrees };
            fixture.run(&["init", "-b", "main"]);
            fixture.run(&["config", "user.name", "Test"]);
            fixture.run(&["config", "user.email", "test@example.com"]);
            fixture.run(&["config", "commit.gpgsign", "false"]);
            fixture.write("a.txt", "one\n");
            fixture.run(&["add", "."]);
            fixture.run(&["commit", "-m", "initial"]);
            fixture
        }

        pub(crate) fn root(&self) -> &Path {
            self.repo.path()
        }

        pub(crate) fn base(&self) -> &Path {
            self.worktrees.path()
        }

        pub(crate) fn run(&self, args: &[&str]) -> String {
            git(self.root(), args).unwrap_or_else(|err| panic!("git {args:?}: {err:?}"))
        }

        pub(crate) fn write(&self, rel: &str, content: &str) {
            write_file(self.root(), rel, content);
        }

        pub(crate) fn create(&self, title: &str) -> WorktreeInfo {
            create_worktree_in(self.worktrees.path(), self.root(), TASK_ID, title).unwrap()
        }
    }

    pub(crate) fn write_file(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{write_file, Fixture, TASK_ID};
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn wt_git(info: &WorktreeInfo, args: &[&str]) -> String {
        git(Path::new(&info.path), args).unwrap_or_else(|err| panic!("git {args:?}: {err:?}"))
    }

    fn commit_in_worktree(info: &WorktreeInfo, rel: &str, content: &str, message: &str) {
        write_file(Path::new(&info.path), rel, content);
        wt_git(info, &["add", "--", rel]);
        wt_git(info, &["commit", "-m", message]);
    }

    #[test]
    fn branch_name_slugs_titles() {
        assert_eq!(
            branch_name(TASK_ID, "Fix: Login Bug!"),
            "mdium/01234567-fix-login-bug"
        );
        assert_eq!(branch_name(TASK_ID, "ログイン修正"), "mdium/01234567-task");
        assert_eq!(branch_name(TASK_ID, "  --  "), "mdium/01234567-task");
        assert_eq!(
            branch_name(TASK_ID, "Add API v2 (beta)"),
            "mdium/01234567-add-api-v2-beta"
        );
        let long = branch_name(TASK_ID, &"word ".repeat(20));
        let slug = long.strip_prefix("mdium/01234567-").unwrap();
        assert!(slug.len() <= 40, "{slug}");
        assert!(!slug.ends_with('-') && !slug.starts_with('-'), "{slug}");
    }

    #[test]
    fn worktree_path_is_outside_repo_and_hashed() {
        let fixture = Fixture::new();
        let path = worktree_path_for(fixture.root(), TASK_ID);
        assert!(!path.starts_with(fixture.root()));
        let canonical = fs::canonicalize(fixture.root()).unwrap();
        assert!(!path.starts_with(&canonical));
        assert_eq!(path.file_name().unwrap(), TASK_ID);
        let hash = path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(hash.len(), 16);
        assert!(hash.bytes().all(|b| b.is_ascii_hexdigit()));
        let worktrees = path.parent().unwrap().parent().unwrap();
        assert!(worktrees.ends_with(Path::new("mdium").join("worktrees")));
        assert_eq!(path, worktree_path_for(fixture.root(), TASK_ID));
    }

    #[test]
    fn repo_detection() {
        let fixture = Fixture::new();
        assert!(is_git_repo(fixture.root()));
        let root = repo_root(&fixture.root().join(".")).unwrap();
        assert_eq!(
            fs::canonicalize(root).unwrap(),
            fs::canonicalize(fixture.root()).unwrap()
        );
        let plain = TempDir::new().unwrap();
        assert!(!is_git_repo(plain.path()));
        assert!(repo_root(plain.path()).is_err());
        let err =
            create_worktree_in(fixture.worktrees.path(), plain.path(), TASK_ID, "t").unwrap_err();
        assert_eq!(err.code(), "GIT_NOT_A_REPO");
    }

    #[test]
    fn create_worktree_on_named_branch() {
        let fixture = Fixture::new();
        let head = fixture.run(&["rev-parse", "HEAD"]).trim().to_string();
        let info = fixture.create("Fix: Login Bug!");
        assert_eq!(info.branch, "mdium/01234567-fix-login-bug");
        assert_eq!(info.base_branch, "main");
        assert_eq!(info.base_commit, head);
        assert!(Path::new(&info.path).join("a.txt").is_file());
        assert!(!Path::new(&info.path).starts_with(fixture.root()));
        assert_eq!(
            wt_git(&info, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
            info.branch
        );
        // The user's checkout stays on its branch.
        assert_eq!(
            fixture.run(&["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
            "main"
        );
    }

    #[test]
    fn create_worktree_rejects_existing_and_invalid_ids() {
        let fixture = Fixture::new();
        fixture.create("t");
        let err =
            create_worktree_in(fixture.worktrees.path(), fixture.root(), TASK_ID, "t").unwrap_err();
        assert_eq!(err.code(), "GIT_WORKTREE_EXISTS");
        let err = create_worktree_in(fixture.worktrees.path(), fixture.root(), "../evil", "t")
            .unwrap_err();
        assert_eq!(err.code(), "GIT_INVALID_ID");
    }

    #[test]
    fn detached_head_is_rejected() {
        let fixture = Fixture::new();
        fixture.run(&["checkout", "--detach"]);
        let err =
            create_worktree_in(fixture.worktrees.path(), fixture.root(), TASK_ID, "t").unwrap_err();
        assert_eq!(err.code(), "GIT_DETACHED_HEAD");
    }

    #[test]
    fn diff_shows_committed_uncommitted_and_untracked_changes() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        commit_in_worktree(&info, "committed.txt", "committed-line\n", "add committed");
        write_file(Path::new(&info.path), "a.txt", "one\nuncommitted-line\n");
        write_file(
            Path::new(&info.path),
            "new/untracked.txt",
            "untracked-content\n",
        );

        let diff = diff_against_base_in(fixture.base(), &info).unwrap();
        assert!(diff.contains("+committed-line"), "{diff}");
        assert!(diff.contains("+uncommitted-line"), "{diff}");
        assert!(diff.contains("new/untracked.txt"), "{diff}");
        // Untracked files are listed, not diffed.
        assert!(!diff.contains("untracked-content"), "{diff}");
    }

    #[test]
    fn commits_since_base_lists_branch_commits_oldest_first() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        assert!(commits_since_base_in(fixture.base(), &info)
            .unwrap()
            .is_empty());
        commit_in_worktree(&info, "b.txt", "b\n", "first change");
        commit_in_worktree(&info, "c.txt", "c\n", "second change");
        let commits = commits_since_base_in(fixture.base(), &info).unwrap();
        let subjects: Vec<_> = commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["first change", "second change"]);
        assert_eq!(
            commits[1].hash,
            wt_git(&info, &["rev-parse", "HEAD"]).trim()
        );
    }

    #[test]
    fn commit_paths_commits_only_given_paths() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let wt = Path::new(&info.path);
        write_file(wt, "docs/design.md", "design\n");
        write_file(wt, "other.txt", "other\n");
        write_file(wt, "staged.txt", "staged\n");
        wt_git(&info, &["add", "--", "staged.txt"]);

        let hash = commit_paths_in(fixture.base(), &info, &["docs/design.md"], "add design")
            .unwrap()
            .expect("a commit");
        assert_eq!(hash, wt_git(&info, &["rev-parse", "HEAD"]).trim());
        let files = wt_git(&info, &["show", "--name-only", "--format=", "HEAD"]);
        assert_eq!(files.trim(), "docs/design.md");
        // Nothing left to commit for that path.
        assert_eq!(
            commit_paths_in(fixture.base(), &info, &["docs/design.md"], "again").unwrap(),
            None
        );
        // Unrelated staged work stays staged, not committed.
        let status = wt_git(&info, &["status", "--porcelain"]);
        assert!(status.contains("A  staged.txt"), "{status}");
        assert!(status.contains("?? other.txt"), "{status}");
    }

    #[test]
    fn merge_into_base_creates_merge_commit() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        commit_in_worktree(&info, "b.txt", "b\n", "feature");
        let hash = merge_into_base_in(fixture.base(), fixture.root(), &info).unwrap();
        assert_eq!(hash, fixture.run(&["rev-parse", "HEAD"]).trim());
        let parents = fixture.run(&["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(parents.split_whitespace().count(), 3, "{parents}");
        assert!(fixture.root().join("b.txt").is_file());
    }

    #[test]
    fn merge_refuses_dirty_tree() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        commit_in_worktree(&info, "b.txt", "b\n", "feature");
        fixture.write("a.txt", "dirty\n");
        let err = merge_into_base_in(fixture.base(), fixture.root(), &info).unwrap_err();
        assert_eq!(err.code(), "GIT_DIRTY_WORKTREE");
    }

    #[test]
    fn merge_ignores_untracked_files() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        commit_in_worktree(
            &info, "b.txt", "b
", "feature",
        );
        fixture.write(
            ".mdium/tasks/x.md",
            "task
",
        );
        fixture.write(
            "foo.txt", "scratch
",
        );
        merge_into_base_in(fixture.base(), fixture.root(), &info).unwrap();
        assert!(fixture.root().join("b.txt").is_file());
        assert!(fixture.root().join("foo.txt").is_file());
    }

    #[test]
    fn merge_refuses_other_branch() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        commit_in_worktree(&info, "b.txt", "b\n", "feature");
        fixture.run(&["checkout", "-b", "other"]);
        let err = merge_into_base_in(fixture.base(), fixture.root(), &info).unwrap_err();
        assert_eq!(err.code(), "GIT_NOT_ON_BASE_BRANCH");
        fixture.run(&["checkout", "--detach"]);
        let err = merge_into_base_in(fixture.base(), fixture.root(), &info).unwrap_err();
        assert_eq!(err.code(), "GIT_NOT_ON_BASE_BRANCH");
    }

    #[test]
    fn merge_conflict_is_aborted_and_leaves_repo_clean() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        commit_in_worktree(&info, "a.txt", "worktree\n", "worktree change");
        fixture.write("a.txt", "base\n");
        fixture.run(&["commit", "-am", "base change"]);
        let before = fixture.run(&["rev-parse", "HEAD"]);

        let err = merge_into_base_in(fixture.base(), fixture.root(), &info).unwrap_err();
        assert_eq!(err.code(), "GIT_MERGE_CONFLICT");
        let git_dir = fixture.run(&["rev-parse", "--absolute-git-dir"]);
        assert!(!Path::new(git_dir.trim()).join("MERGE_HEAD").exists());
        assert_eq!(fixture.run(&["status", "--porcelain"]), "");
        assert_eq!(fixture.run(&["rev-parse", "HEAD"]), before);
    }

    #[test]
    fn discard_removes_worktree_and_branch_and_is_idempotent() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        write_file(Path::new(&info.path), "scratch.txt", "x\n");
        discard_in(fixture.base(), fixture.root(), &info).unwrap();
        assert!(!Path::new(&info.path).exists());
        assert_eq!(fixture.run(&["branch", "--list", &info.branch]), "");
        let list = fixture.run(&["worktree", "list", "--porcelain"]);
        assert_eq!(list.matches("worktree ").count(), 1, "{list}");
        discard_in(fixture.base(), fixture.root(), &info).unwrap();
    }

    /// Sets extra env vars for git children spawned on this test thread,
    /// restoring the previous set on drop.
    struct TestEnv(Vec<(String, String)>);

    impl TestEnv {
        fn set(vars: &[(&str, &str)]) -> Self {
            let new = vars
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            let prev = TEST_GIT_ENV.with(|env| std::mem::replace(&mut *env.borrow_mut(), new));
            TestEnv(prev)
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            let prev = std::mem::take(&mut self.0);
            TEST_GIT_ENV.with(|env| *env.borrow_mut() = prev);
        }
    }

    #[test]
    fn merge_of_missing_branch_is_merge_failed() {
        let fixture = Fixture::new();
        let mut info = fixture.create("t");
        info.branch = "mdium/01234567-missing".to_string();
        let before = fixture.run(&["rev-parse", "HEAD"]);
        let err = merge_into_base_in(fixture.base(), fixture.root(), &info).unwrap_err();
        assert_eq!(err.code(), "GIT_MERGE_FAILED", "{err:?}");
        assert_eq!(fixture.run(&["rev-parse", "HEAD"]), before);
        assert_eq!(fixture.run(&["status", "--porcelain"]), "");
    }

    #[test]
    fn invalid_worktree_info_is_rejected_by_every_op() {
        let fixture = Fixture::new();
        let good = fixture.create("t");
        let mut bad_commit = good.clone();
        bad_commit.base_commit = "--output=x".to_string();
        let mut upper_commit = good.clone();
        upper_commit.base_commit = good.base_commit.to_uppercase();
        let mut bad_branch = good.clone();
        bad_branch.branch = "main".to_string();
        let mut relative = good.clone();
        relative.path = "relative/wt".to_string();

        for info in [&bad_commit, &upper_commit, &bad_branch, &relative] {
            let codes = [
                diff_against_base_in(fixture.base(), info)
                    .unwrap_err()
                    .code(),
                commits_since_base_in(fixture.base(), info)
                    .unwrap_err()
                    .code(),
                commit_paths_in(fixture.base(), info, &["a.txt"], "m")
                    .unwrap_err()
                    .code(),
                merge_into_base_in(fixture.base(), fixture.root(), info)
                    .unwrap_err()
                    .code(),
                discard_in(fixture.base(), fixture.root(), info)
                    .unwrap_err()
                    .code(),
            ];
            for code in codes {
                assert_eq!(code, "GIT_INVALID_WORKTREE_INFO", "{info:?}");
            }
        }
        assert!(!Path::new(&good.path).join("x").exists());
        assert!(!fixture.root().join("x").exists());
        // The good info still works and the worktree was left alone.
        assert!(Path::new(&good.path).is_dir());
        diff_against_base_in(fixture.base(), &good).unwrap();
    }

    #[test]
    fn commit_paths_uses_literal_pathspecs() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let wt = Path::new(&info.path);
        write_file(wt, "[a].txt", "bracket\n");
        write_file(wt, "a.txt", "changed\n");
        commit_paths_in(fixture.base(), &info, &["[a].txt"], "literal")
            .unwrap()
            .unwrap();
        let files = wt_git(&info, &["show", "--name-only", "--format=", "HEAD"]);
        assert_eq!(files.trim(), "[a].txt");
    }

    #[test]
    fn commit_paths_falls_back_to_mdium_identity() {
        let fixture = Fixture::new();
        let global = fixture.worktrees.path().join("empty-global.gitconfig");
        fs::write(&global, "").unwrap();
        let _env = TestEnv::set(&[
            ("GIT_CONFIG_GLOBAL", global.to_str().unwrap()),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ]);
        fixture.run(&["config", "--unset", "user.name"]);
        fixture.run(&["config", "--unset", "user.email"]);
        let info = fixture.create("t");

        write_file(Path::new(&info.path), "b.txt", "b\n");
        commit_paths_in(fixture.base(), &info, &["b.txt"], "no identity")
            .unwrap()
            .unwrap();
        let author = wt_git(&info, &["log", "-1", "--format=%an <%ae>"]);
        assert_eq!(author.trim(), "MDium <mdium@localhost>");

        // Only the missing field is filled in.
        fixture.run(&["config", "user.name", "Alice"]);
        write_file(Path::new(&info.path), "c.txt", "c\n");
        commit_paths_in(fixture.base(), &info, &["c.txt"], "name only")
            .unwrap()
            .unwrap();
        let author = wt_git(&info, &["log", "-1", "--format=%an <%ae>"]);
        assert_eq!(author.trim(), "Alice <mdium@localhost>");
    }

    #[test]
    fn discard_removes_unregistered_dir_only_under_worktree_base() {
        let fixture = Fixture::new();
        let registered = fixture.create("t");

        // An orphan directory under the MDium worktree base is removed.
        let orphan_path = Path::new(&registered.path).with_file_name("fedcba9876543210");
        write_file(&orphan_path, "left.txt", "x\n");
        let mut orphan = registered.clone();
        orphan.path = orphan_path.to_string_lossy().into_owned();
        orphan.branch = "mdium/fedcba98-t".to_string();
        discard_in(fixture.base(), fixture.root(), &orphan).unwrap();
        assert!(!orphan_path.exists());

        // An unregistered directory elsewhere is never deleted.
        let outside = TempDir::new().unwrap();
        write_file(outside.path(), "keep.txt", "x\n");
        let mut foreign = registered.clone();
        foreign.path = outside.path().to_string_lossy().into_owned();
        let err = discard_in(fixture.base(), fixture.root(), &foreign).unwrap_err();
        assert_eq!(err.code(), "GIT_INVALID_WORKTREE_INFO");
        assert!(outside.path().join("keep.txt").is_file());
    }

    #[test]
    fn worktree_path_normalizes_repo_root() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root().join("sub")).unwrap();
        assert_eq!(
            worktree_path_in(Path::new("/base"), &fixture.root().join("sub"), TASK_ID),
            worktree_path_in(Path::new("/base"), fixture.root(), TASK_ID)
        );
    }

    #[test]
    fn worktree_paths_outside_the_managed_location_are_rejected() {
        let fixture = Fixture::new();
        let good = fixture.create("t");
        let outside = TempDir::new().unwrap();
        let other_repo = Fixture::new();
        let other_wt = worktree_path_in(fixture.base(), other_repo.root(), TASK_ID);

        let candidates = [
            // The user's own repository.
            fixture.root().to_string_lossy().into_owned(),
            // Some other directory outside the base.
            outside.path().to_string_lossy().into_owned(),
            // The managed worktrees dir itself, and a hash dir.
            fixture
                .base()
                .join("mdium")
                .join("worktrees")
                .to_string_lossy()
                .into_owned(),
            Path::new(&good.path)
                .parent()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            // Right depth, but not 16-hex names.
            Path::new(&good.path)
                .with_file_name("not-an-id")
                .to_string_lossy()
                .into_owned(),
            // `..` escaping back out of the base.
            Path::new(&good.path)
                .join("..")
                .join("..")
                .join("..")
                .to_string_lossy()
                .into_owned(),
        ];
        for path in candidates {
            let mut info = good.clone();
            info.path = path;
            let codes = [
                commit_paths_in(fixture.base(), &info, &["a.txt"], "m")
                    .unwrap_err()
                    .code(),
                diff_against_base_in(fixture.base(), &info)
                    .unwrap_err()
                    .code(),
                commits_since_base_in(fixture.base(), &info)
                    .unwrap_err()
                    .code(),
                merge_into_base_in(fixture.base(), fixture.root(), &info)
                    .unwrap_err()
                    .code(),
                discard_in(fixture.base(), fixture.root(), &info)
                    .unwrap_err()
                    .code(),
            ];
            for code in codes {
                assert_eq!(code, "GIT_INVALID_WORKTREE_INFO", "{info:?}");
            }
        }

        // A managed path of a different repo is rejected by repo-bound ops.
        let mut foreign = good.clone();
        foreign.path = other_wt.to_string_lossy().into_owned();
        assert_eq!(
            merge_into_base_in(fixture.base(), fixture.root(), &foreign)
                .unwrap_err()
                .code(),
            "GIT_INVALID_WORKTREE_INFO"
        );
        assert_eq!(
            discard_in(fixture.base(), fixture.root(), &foreign)
                .unwrap_err()
                .code(),
            "GIT_INVALID_WORKTREE_INFO"
        );

        // Nothing was touched.
        assert!(fixture.root().join("a.txt").is_file());
        assert!(Path::new(&good.path).join("a.txt").is_file());
    }

    /// Error codes of every MDium git op that runs inside the worktree.
    fn worktree_op_codes(fixture: &Fixture, info: &WorktreeInfo) -> Vec<String> {
        vec![
            diff_against_base_in(fixture.base(), info)
                .map(|_| String::new())
                .unwrap_or_else(|err| err.code().to_string()),
            commits_since_base_in(fixture.base(), info)
                .map(|_| String::new())
                .unwrap_or_else(|err| err.code().to_string()),
            commit_paths_in(fixture.base(), info, &["a.txt"], "m")
                .map(|_| String::new())
                .unwrap_or_else(|err| err.code().to_string()),
        ]
    }

    /// The admin dir `<common>/worktrees/<name>` the worktree links to.
    fn admin_dir(info: &WorktreeInfo) -> PathBuf {
        let out = wt_git(info, &["rev-parse", "--absolute-git-dir"]);
        PathBuf::from(out.trim())
    }

    #[test]
    fn untampered_worktree_link_is_accepted() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        verify_worktree_link(&info).unwrap();
        assert_eq!(worktree_op_codes(&fixture, &info), ["", "", ""]);
    }

    #[test]
    fn worktree_git_file_pointing_elsewhere_is_rejected() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        // A look-alike worktree admin dir of another repository.
        let other = Fixture::new();
        let other_info = other.create("t");
        let foreign_admin = admin_dir(&other_info);
        let dot_git = Path::new(&info.path).join(".git");
        fs::write(
            &dot_git,
            format!("gitdir: {}\n", foreign_admin.to_string_lossy()),
        )
        .unwrap();
        assert_eq!(
            verify_worktree_link(&info).unwrap_err().code(),
            "GIT_WORKTREE_LINK_TAMPERED"
        );
        for code in worktree_op_codes(&fixture, &info) {
            assert_eq!(code, "GIT_WORKTREE_LINK_TAMPERED");
        }
    }

    #[test]
    fn worktree_git_dir_or_missing_link_is_rejected() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let dot_git = Path::new(&info.path).join(".git");
        fs::remove_file(&dot_git).unwrap();
        assert_eq!(
            verify_worktree_link(&info).unwrap_err().code(),
            "GIT_WORKTREE_LINK_TAMPERED"
        );
        // A full repository in place of the link file.
        git(Path::new(&info.path), &["init", "-b", "main"]).unwrap();
        assert!(dot_git.is_dir());
        for code in worktree_op_codes(&fixture, &info) {
            assert_eq!(code, "GIT_WORKTREE_LINK_TAMPERED");
        }
    }

    #[test]
    fn worktree_admin_commondir_or_backlink_change_is_rejected() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let admin = admin_dir(&info);
        let other = Fixture::new();
        let other_common = other.root().join(".git");

        let commondir = fs::read_to_string(admin.join("commondir")).unwrap();
        fs::write(
            admin.join("commondir"),
            format!("{}\n", other_common.to_string_lossy()),
        )
        .unwrap();
        assert_eq!(
            verify_worktree_link(&info).unwrap_err().code(),
            "GIT_WORKTREE_LINK_TAMPERED"
        );
        fs::write(admin.join("commondir"), commondir).unwrap();
        verify_worktree_link(&info).unwrap();

        let outside = TempDir::new().unwrap();
        fs::write(
            admin.join("gitdir"),
            format!("{}\n", outside.path().join(".git").to_string_lossy()),
        )
        .unwrap();
        assert_eq!(
            verify_worktree_link(&info).unwrap_err().code(),
            "GIT_WORKTREE_LINK_TAMPERED"
        );
    }

    #[test]
    fn read_only_worktree_git_calls_disable_fsmonitor() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let marker = fixture.worktrees.path().join("fsmonitor-ran");
        let marker_str = marker.to_string_lossy().replace('\\', "/");
        fixture.run(&[
            "config",
            "core.fsmonitor",
            &format!("echo ran > '{marker_str}'; exit 1"),
        ]);
        write_file(Path::new(&info.path), "a.txt", "changed\n");
        diff_against_base_in(fixture.base(), &info).unwrap();
        commits_since_base_in(fixture.base(), &info).unwrap();
        assert!(!marker.exists(), "fsmonitor hook must not run");
    }

    #[test]
    fn merge_git_calls_in_the_user_checkout_disable_fsmonitor() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        commit_in_worktree(&info, "b.txt", "b\n", "feature");
        let marker = fixture.worktrees.path().join("fsmonitor-ran");
        let marker_str = marker.to_string_lossy().replace('\\', "/");
        fixture.run(&[
            "config",
            "core.fsmonitor",
            &format!("echo ran > '{marker_str}'; exit 1"),
        ]);
        merge_into_base_in(fixture.base(), fixture.root(), &info).unwrap();
        assert!(!marker.exists(), "fsmonitor hook must not run");
    }

    /// Runs a whole workflow cycle (create, commit, diff, log, merge,
    /// discard) with `checkout` as the user's project folder.
    fn full_cycle(base: &Path, checkout: &Path) {
        let info = create_worktree_in(base, checkout, TASK_ID, "t").unwrap();
        verify_worktree_link(&info).unwrap();
        let wt = Path::new(&info.path);
        write_file(wt, "b.txt", "b-line\n");
        commit_paths_in(base, &info, &["b.txt"], "add b")
            .unwrap()
            .expect("a commit");
        write_file(wt, "a.txt", "uncommitted\n");
        let diff = diff_against_base_in(base, &info).unwrap();
        assert!(diff.contains("+b-line"), "{diff}");
        assert!(diff.contains("+uncommitted"), "{diff}");
        let commits = commits_since_base_in(base, &info).unwrap();
        assert_eq!(commits.len(), 1);
        git(wt, &["checkout", "--", "a.txt"]).unwrap();
        merge_into_base_in(base, checkout, &info).unwrap();
        assert!(checkout.join("b.txt").is_file());
        discard_in(base, checkout, &info).unwrap();
        assert!(!wt.exists());
    }

    #[test]
    fn run_from_a_linked_worktree_checkout_works() {
        let fixture = Fixture::new();
        let holder = TempDir::new().unwrap();
        let linked = holder.path().join("linked");
        let linked_str = linked.to_string_lossy().into_owned();
        fixture.run(&["worktree", "add", "-b", "feature", &linked_str]);
        // Both checkouts of one repository share one worktree location.
        assert_eq!(
            worktree_path_in(fixture.base(), &linked, TASK_ID),
            worktree_path_in(fixture.base(), fixture.root(), TASK_ID)
        );
        full_cycle(fixture.base(), &linked);
        assert_eq!(
            git(&linked, &["rev-parse", "--abbrev-ref", "HEAD"])
                .unwrap()
                .trim(),
            "feature"
        );
    }

    #[test]
    fn run_from_a_separate_git_dir_repo_works() {
        let repo = TempDir::new().unwrap();
        let git_dirs = TempDir::new().unwrap();
        let base = TempDir::new().unwrap();
        let git_dir = git_dirs.path().join("store");
        let git_dir_str = git_dir.to_string_lossy().into_owned();
        let root = repo.path();
        for args in [
            &["init", "-b", "main", "--separate-git-dir", &git_dir_str][..],
            &["config", "user.name", "Test"][..],
            &["config", "user.email", "test@example.com"][..],
            &["config", "commit.gpgsign", "false"][..],
        ] {
            git(root, args).unwrap();
        }
        write_file(root, "a.txt", "one\n");
        git(root, &["add", "."]).unwrap();
        git(root, &["commit", "-m", "initial"]).unwrap();
        full_cycle(base.path(), root);
    }

    #[test]
    fn discard_accepts_an_already_removed_worktree_path() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        discard_in(fixture.base(), fixture.root(), &info).unwrap();
        // Remove the hash dir too, so no part of the managed path exists.
        fs::remove_dir_all(Path::new(&info.path).parent().unwrap()).unwrap();
        discard_in(fixture.base(), fixture.root(), &info).unwrap();
    }
}

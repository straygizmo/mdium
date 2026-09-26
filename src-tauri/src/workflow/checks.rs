//! Post-attempt checks (guard layer 4).
//!
//! Right before a session starts MDium takes an integrity [`baseline`] of
//! the user's repository; after the attempt ends (however it ends)
//! [`post_attempt`] compares a fresh snapshot against it and, only if that
//! passes, looks for agent-config files the agent changed in its worktree
//! that the user has not acknowledged. The first failing check produces the
//! attention reason; later checks are skipped.

use crate::workflow::errors::to_attention;
use crate::workflow::gitops::GIT_INVALID_WORKTREE_INFO;
use crate::workflow::integrity::{
    changed_paths_matching_in, compare, snapshot_with_worktree, IntegrityChange, IntegrityError,
    IntegritySnapshot, AGENT_CONFIG_PATTERNS,
};
use crate::workflow::model::{AttentionReason, FileFingerprint, WorkflowRun, WorktreeInfo};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Most entries in an attention reason's `items` list.
const ITEMS_MAX: usize = 20;
/// Longest string in an attention reason's `items` list, in chars.
const ITEM_MAX_CHARS: usize = 160;
/// Most entries hashed for one changed path that is a directory.
const DIR_ENTRIES_MAX: usize = 10_000;
/// Most file bytes read to fingerprint one changed path (a file, or all
/// files of a directory together).
const FINGERPRINT_BYTES_MAX: u64 = 64 * 1024 * 1024;
/// Code of the check failure when a changed path exceeds
/// [`FINGERPRINT_BYTES_MAX`].
const CHECKS_FILE_TOO_LARGE: &str = "CHECKS_FILE_TOO_LARGE";

/// Outcome of the post-attempt checks.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckResult {
    /// The snapshot taken after the attempt, whenever it succeeded (the new
    /// baseline for later comparisons).
    pub after: Option<IntegritySnapshot>,
    /// Why the task needs attention, or `None` when every check passed.
    pub reason: Option<AttentionReason>,
}

/// Snapshot of the user's repository (plus the run's worktree admin state)
/// taken right before a session starts. A run without a worktree or a
/// failed snapshot yields `ATTENTION_INTEGRITY_CHECK_FAILED`.
///
/// Unlike [`post_attempt`] this needs no worktree base: the snapshot finds
/// the worktree's admin dir from the user's common git dir and never
/// validates the worktree location.
pub fn baseline(repo_root: &Path, run: &WorkflowRun) -> Result<IntegritySnapshot, AttentionReason> {
    let info = run.worktree.as_ref().ok_or_else(missing_worktree)?;
    take_snapshot(repo_root, info)
}

/// Runs the post-attempt checks against the `before` snapshot (see the
/// module docs for the order). `worktree_base` is the base dir the run's
/// worktree was created under (`gitops::create_worktree_in`).
pub fn post_attempt(
    worktree_base: &Path,
    repo_root: &Path,
    run: &WorkflowRun,
    before: &IntegritySnapshot,
) -> CheckResult {
    let Some(info) = run.worktree.as_ref() else {
        return CheckResult {
            after: None,
            reason: Some(missing_worktree()),
        };
    };
    let after = match take_snapshot(repo_root, info) {
        Ok(after) => after,
        Err(reason) => {
            return CheckResult {
                after: None,
                reason: Some(reason),
            }
        }
    };
    let changes = compare(before, &after);
    if !changes.is_empty() {
        let items: Vec<IntegrityChange> = changes
            .into_iter()
            .map(|change| IntegrityChange {
                code: change.code,
                detail: excerpt(&change.detail),
            })
            .collect();
        return CheckResult {
            after: Some(after),
            reason: Some(to_attention(
                "ATTENTION_INTEGRITY_CHANGED",
                [("items", items_json(&items))],
            )),
        };
    }
    let reason = match agent_config_fingerprints(worktree_base, info) {
        Err(reason) => Some(reason),
        Ok(current) => {
            let paths: Vec<String> = unacknowledged(&current, &run.acknowledged_agent_config)
                .iter()
                .map(|path| excerpt(path))
                .collect();
            (!paths.is_empty()).then(|| {
                to_attention(
                    "ATTENTION_AGENT_CONFIG_CHANGED",
                    [("items", items_json(&paths))],
                )
            })
        }
    };
    CheckResult {
        after: Some(after),
        reason,
    }
}

/// Fingerprints of the worktree's changed agent-config paths (see
/// [`AGENT_CONFIG_PATTERNS`]), sorted by path; `worktree_base` as in
/// [`post_attempt`]. `sha256` is `None` for a deleted file. Symlinks are
/// never followed: a symlink (or a path below a symlinked directory) is
/// fingerprinted by its link target, and a directory by its entries.
pub fn agent_config_fingerprints(
    worktree_base: &Path,
    info: &WorktreeInfo,
) -> Result<Vec<FileFingerprint>, AttentionReason> {
    let paths = changed_paths_matching_in(worktree_base, info, AGENT_CONFIG_PATTERNS)
        .map_err(|err| check_failed(err.code()))?;
    let root = Path::new(&info.path);
    let mut fingerprints = paths
        .iter()
        .map(|path| {
            let path = path.trim_end_matches('/');
            Ok(FileFingerprint {
                path: path.to_string(),
                sha256: hash_worktree_path(root, path, FINGERPRINT_BYTES_MAX)
                    .map_err(|err| check_failed(err.code()))?,
            })
        })
        .collect::<Result<Vec<_>, AttentionReason>>()?;
    fingerprints.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(fingerprints)
}

/// Paths in `current` whose exact (path, sha256) pair is not in
/// `acknowledged`, in `current` order.
pub fn unacknowledged(
    current: &[FileFingerprint],
    acknowledged: &[FileFingerprint],
) -> Vec<String> {
    current
        .iter()
        .filter(|fingerprint| !acknowledged.contains(fingerprint))
        .map(|fingerprint| fingerprint.path.clone())
        .collect()
}

fn take_snapshot(
    repo_root: &Path,
    info: &WorktreeInfo,
) -> Result<IntegritySnapshot, AttentionReason> {
    snapshot_with_worktree(repo_root, Some(&info.base_branch), Some(info))
        .map_err(|err| check_failed(err.code()))
}

fn check_failed(code: &str) -> AttentionReason {
    to_attention("ATTENTION_INTEGRITY_CHECK_FAILED", [("code", code)])
}

/// A run without a worktree cannot be checked; fail closed.
fn missing_worktree() -> AttentionReason {
    check_failed(GIT_INVALID_WORKTREE_INFO)
}

/// Why fingerprinting a worktree path failed.
#[derive(Debug)]
enum HashError {
    Integrity(IntegrityError),
    /// More than the byte budget would have to be read.
    TooLarge(String),
}

impl HashError {
    fn code(&self) -> &'static str {
        match self {
            HashError::Integrity(err) => err.code(),
            HashError::TooLarge(_) => CHECKS_FILE_TOO_LARGE,
        }
    }
}

impl From<IntegrityError> for HashError {
    fn from(err: IntegrityError) -> Self {
        HashError::Integrity(err)
    }
}

fn io_error(path: &Path, err: std::io::Error) -> HashError {
    HashError::Integrity(IntegrityError::Io(format!("{}: {err}", path.display())))
}

/// Hex sha256 fingerprint of the worktree-relative `rel` (a `/`-separated
/// path as git prints it), or `None` if nothing exists there. A regular file
/// hashes as its content; a symlink (or junction), including one on the way
/// to `rel`, as its link target; a directory as its entries. Nothing outside
/// `root` is ever read, and at most `max_bytes` of file content are read.
fn hash_worktree_path(root: &Path, rel: &str, max_bytes: u64) -> Result<Option<String>, HashError> {
    let invalid = || IntegrityError::Io(format!("invalid worktree path {rel:?}"));
    let segments: Vec<&str> = rel.split('/').collect();
    let valid = !rel.is_empty()
        && segments.iter().all(|segment| {
            let mut components = Path::new(segment).components();
            matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
        });
    if !valid {
        return Err(invalid().into());
    }
    let mut budget = max_bytes;
    let mut path = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        path.push(segment);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(io_error(&path, err)),
        };
        if meta.file_type().is_symlink() {
            // Never follow a link: fingerprint the link itself, together
            // with how far below it `rel` lies.
            let depth = segments.len() - index - 1;
            return hash_link(&path, depth).map(Some);
        }
        if index + 1 == segments.len() {
            return if meta.is_file() {
                hash_file(&path, &mut budget).map(Some)
            } else if meta.is_dir() {
                hash_dir(&path, &mut budget).map(Some)
            } else {
                Ok(Some(hex(Sha256::digest(b"special\0"))))
            };
        }
        if !meta.is_dir() {
            return Ok(None);
        }
    }
    Err(invalid().into())
}

fn hex(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Fingerprint of a symlink's target string; `depth` is how many path
/// segments below the link the fingerprinted path lies.
fn hash_link(path: &Path, depth: usize) -> Result<String, HashError> {
    let target = std::fs::read_link(path).map_err(|err| io_error(path, err))?;
    let mut hasher = Sha256::new();
    hasher.update(b"symlink\0");
    hasher.update((depth as u64).to_le_bytes());
    hasher.update(target.as_os_str().as_encoded_bytes());
    Ok(hex(hasher.finalize()))
}

/// `open(2)` flags that keep the final path component from being followed
/// if it is a symlink, and keep a FIFO from blocking the open. Values are
/// per platform, since the crate has no `libc` dependency; on other Unix
/// targets only the post-open regular-file check applies.
#[cfg(unix)]
mod open_flags {
    #[cfg(all(
        any(target_os = "linux", target_os = "android"),
        any(target_arch = "x86", target_arch = "x86_64", target_arch = "riscv64")
    ))]
    pub const FLAGS: i32 = 0o400000 | 0o4000;
    #[cfg(all(
        any(target_os = "linux", target_os = "android"),
        any(target_arch = "arm", target_arch = "aarch64")
    ))]
    pub const FLAGS: i32 = 0o100000 | 0o4000;
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    pub const FLAGS: i32 = 0x0100 | 0x0004;
    #[cfg(not(any(
        all(
            any(target_os = "linux", target_os = "android"),
            any(
                target_arch = "x86",
                target_arch = "x86_64",
                target_arch = "riscv64",
                target_arch = "arm",
                target_arch = "aarch64"
            )
        ),
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd"
    )))]
    pub const FLAGS: i32 = 0;
}

/// Opens `path` for reading without following a final symlink (or reparse
/// point) and verifies through the opened handle that it is a regular file,
/// so a path swapped after the `symlink_metadata` check fails closed.
fn open_regular_file(path: &Path) -> Result<File, HashError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(open_flags::FLAGS);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        /// Open a reparse point itself instead of its target.
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|err| io_error(path, err))?;
    let meta = file.metadata().map_err(|err| io_error(path, err))?;
    let regular = meta.is_file();
    #[cfg(windows)]
    let regular = {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        regular && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
    };
    if !regular {
        return Err(IntegrityError::Io(format!("{}: not a regular file", path.display())).into());
    }
    Ok(file)
}

/// sha256 of a regular file's content, charging the bytes read to `budget`.
fn hash_file(path: &Path, budget: &mut u64) -> Result<String, HashError> {
    let too_large = || HashError::TooLarge(path.display().to_string());
    let mut file = open_regular_file(path)?;
    let len = file.metadata().map_err(|err| io_error(path, err))?.len();
    if len > *budget {
        return Err(too_large());
    }
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buf).map_err(|err| io_error(path, err))?;
        if read == 0 {
            break;
        }
        // The file may grow while it is read.
        *budget = budget.checked_sub(read as u64).ok_or_else(too_large)?;
        hasher.update(&buf[..read]);
    }
    Ok(hex(hasher.finalize()))
}

/// Hashes the sorted (relative path, kind, fingerprint) entries under `dir`
/// without following symlinks; more than [`DIR_ENTRIES_MAX`] entries fail
/// closed, and file contents are charged to `budget`.
fn hash_dir(dir: &Path, budget: &mut u64) -> Result<String, HashError> {
    let mut entries: Vec<(Vec<u8>, u8, String)> = Vec::new();
    let mut pending: Vec<(PathBuf, Vec<u8>)> = vec![(dir.to_path_buf(), Vec::new())];
    while let Some((current, prefix)) = pending.pop() {
        let reader = std::fs::read_dir(&current).map_err(|err| io_error(&current, err))?;
        for entry in reader {
            let entry = entry.map_err(|err| io_error(&current, err))?;
            if entries.len() >= DIR_ENTRIES_MAX {
                return Err(IntegrityError::Io(format!(
                    "{}: more than {DIR_ENTRIES_MAX} entries",
                    dir.display()
                ))
                .into());
            }
            let path = entry.path();
            let rel = [prefix.as_slice(), entry.file_name().as_encoded_bytes()].concat();
            let file_type = entry.file_type().map_err(|err| io_error(&path, err))?;
            if file_type.is_symlink() {
                entries.push((rel, b'l', hash_link(&path, 0)?));
            } else if file_type.is_dir() {
                pending.push((path, [rel.as_slice(), b"/"].concat()));
                entries.push((rel, b'd', String::new()));
            } else if file_type.is_file() {
                entries.push((rel, b'f', hash_file(&path, budget)?));
            } else {
                entries.push((rel, b's', String::new()));
            }
        }
    }
    entries.sort();
    let mut hasher = Sha256::new();
    hasher.update(b"dir\0");
    for (rel, kind, content) in &entries {
        hasher.update([*kind]);
        hasher.update((rel.len() as u64).to_le_bytes());
        hasher.update(rel);
        hasher.update((content.len() as u64).to_le_bytes());
        hasher.update(content.as_bytes());
    }
    Ok(hex(hasher.finalize()))
}

/// Cuts `text` to at most [`ITEM_MAX_CHARS`] chars (never inside a char).
fn excerpt(text: &str) -> String {
    match text.char_indices().nth(ITEM_MAX_CHARS) {
        Some((end, _)) => text[..end].to_string(),
        None => text.to_string(),
    }
}

/// JSON array of at most [`ITEMS_MAX`] of `items`.
fn items_json<T: Serialize>(items: &[T]) -> String {
    let capped = &items[..items.len().min(ITEMS_MAX)];
    serde_json::to_string(capped).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::gitops::test_support::{write_file, Fixture};
    use crate::workflow::model::RunStatus;
    use crate::workflow::template::standard_workflow;

    fn run_for(info: &WorktreeInfo) -> WorkflowRun {
        WorkflowRun {
            schema_version: 1,
            root_task_id: crate::workflow::gitops::test_support::TASK_ID.to_string(),
            workflow: standard_workflow("Standard", crate::workflow::model::Provider::Codex),
            status: RunStatus::Active,
            current_task_id: crate::workflow::gitops::test_support::TASK_ID.to_string(),
            reentry_count: 0,
            worktree: Some(info.clone()),
            attempts: Vec::new(),
            pending_transition: None,
            integrity_baseline: None,
            created_at: "2026-09-26T00:00:00Z".to_string(),
            updated_at: "2026-09-26T00:00:00Z".to_string(),
            acknowledged_agent_config: Vec::new(),
        }
    }

    /// A fixture with an agent worktree, its run, and a baseline snapshot.
    fn setup() -> (Fixture, WorkflowRun, IntegritySnapshot) {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let run = run_for(&info);
        let before = baseline(fixture.root(), &run).unwrap();
        (fixture, run, before)
    }

    fn check(fixture: &Fixture, run: &WorkflowRun, before: &IntegritySnapshot) -> CheckResult {
        post_attempt(fixture.base(), fixture.root(), run, before)
    }

    fn items(reason: &AttentionReason) -> Vec<serde_json::Value> {
        serde_json::from_str(reason.params.get("items").expect("items")).unwrap()
    }

    fn wt(run: &WorkflowRun) -> &Path {
        Path::new(&run.worktree.as_ref().unwrap().path)
    }

    #[test]
    fn clean_attempt_has_no_reason() {
        let (fixture, run, before) = setup();
        // Ordinary work in the worktree is not a guard concern.
        write_file(wt(&run), "src/a.ts", "a\n");
        let result = check(&fixture, &run, &before);
        assert!(result.reason.is_none(), "{:?}", result.reason);
        assert_eq!(result.after.as_ref(), Some(&before));
    }

    #[test]
    fn user_git_config_change_is_an_integrity_change() {
        let (fixture, run, before) = setup();
        fixture.run(&["config", "core.pager", "x"]);
        let result = check(&fixture, &run, &before);
        let reason = result.reason.expect("reason");
        assert_eq!(reason.code, "ATTENTION_INTEGRITY_CHANGED");
        let found = items(&reason);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0]["code"], "INTEGRITY_GIT_CONFIG_CHANGED");
        assert!(found[0].get("detail").is_some(), "{found:?}");
        assert!(result.after.is_some());
    }

    #[test]
    fn commit_on_base_branch_is_reported() {
        let (fixture, run, before) = setup();
        fixture.write("b.txt", "b\n");
        fixture.run(&["add", "b.txt"]);
        fixture.run(&["commit", "-m", "user commit"]);
        let reason = check(&fixture, &run, &before).reason.expect("reason");
        assert_eq!(reason.code, "ATTENTION_INTEGRITY_CHANGED");
        let codes: Vec<_> = items(&reason)
            .iter()
            .map(|item| item["code"].as_str().unwrap().to_string())
            .collect();
        assert!(
            codes.contains(&"INTEGRITY_BASE_BRANCH_MOVED".to_string()),
            "{codes:?}"
        );
    }

    #[test]
    fn agent_config_change_needs_acknowledgement() {
        let (fixture, mut run, before) = setup();
        write_file(wt(&run), ".claude/settings.json", "{}\n");
        let result = check(&fixture, &run, &before);
        let reason = result.reason.expect("reason");
        assert_eq!(reason.code, "ATTENTION_AGENT_CONFIG_CHANGED");
        assert_eq!(items(&reason), [serde_json::json!(".claude/settings.json")]);
        assert!(result.after.is_some());

        // The user accepts the current state of those files.
        run.acknowledged_agent_config =
            agent_config_fingerprints(fixture.base(), run.worktree.as_ref().unwrap()).unwrap();
        assert_eq!(run.acknowledged_agent_config.len(), 1);
        assert_eq!(
            run.acknowledged_agent_config[0].path,
            ".claude/settings.json"
        );
        let result = check(&fixture, &run, &before);
        assert!(result.reason.is_none(), "{:?}", result.reason);

        // A later edit of an acknowledged file is reported again.
        write_file(wt(&run), ".claude/settings.json", "{\"x\":1}\n");
        let reason = check(&fixture, &run, &before).reason.expect("reason");
        assert_eq!(reason.code, "ATTENTION_AGENT_CONFIG_CHANGED");
        assert_eq!(items(&reason), [serde_json::json!(".claude/settings.json")]);
    }

    #[test]
    fn integrity_failure_suppresses_agent_config_check() {
        let (fixture, run, before) = setup();
        write_file(wt(&run), ".claude/settings.json", "{}\n");
        fixture.run(&["config", "core.pager", "x"]);
        let reason = check(&fixture, &run, &before).reason.expect("reason");
        assert_eq!(reason.code, "ATTENTION_INTEGRITY_CHANGED");
        let codes: Vec<_> = items(&reason)
            .iter()
            .map(|item| item["code"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(codes, ["INTEGRITY_GIT_CONFIG_CHANGED"]);
    }

    #[test]
    fn failed_snapshot_is_a_check_failure() {
        let (fixture, run, before) = setup();
        let not_a_repo = tempfile::TempDir::new().unwrap();
        write_file(wt(&run), ".claude/settings.json", "{}\n");
        let result = post_attempt(fixture.base(), not_a_repo.path(), &run, &before);
        assert!(result.after.is_none());
        let reason = result.reason.expect("reason");
        assert_eq!(reason.code, "ATTENTION_INTEGRITY_CHECK_FAILED");
        assert_eq!(
            reason.params.get("code").map(String::as_str),
            Some("GIT_FAILED")
        );
    }

    #[test]
    fn baseline_failure_is_a_check_failure() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let not_a_repo = tempfile::TempDir::new().unwrap();
        let reason = baseline(not_a_repo.path(), &run_for(&info)).unwrap_err();
        assert_eq!(reason.code, "ATTENTION_INTEGRITY_CHECK_FAILED");
        assert!(reason.params.contains_key("code"), "{reason:?}");
    }

    #[test]
    fn run_without_worktree_fails_closed() {
        let (fixture, mut run, before) = setup();
        run.worktree = None;
        let reason = baseline(fixture.root(), &run).unwrap_err();
        assert_eq!(reason.code, "ATTENTION_INTEGRITY_CHECK_FAILED");
        let result = check(&fixture, &run, &before);
        assert_eq!(
            result.reason.map(|reason| reason.code).as_deref(),
            Some("ATTENTION_INTEGRITY_CHECK_FAILED")
        );
    }

    #[test]
    fn tampered_worktree_fails_the_agent_config_check() {
        let (fixture, mut run, before) = setup();
        run.worktree.as_mut().unwrap().base_commit = "--output=x".to_string();
        let reason = check(&fixture, &run, &before).reason.expect("reason");
        assert_eq!(reason.code, "ATTENTION_INTEGRITY_CHECK_FAILED");
        assert_eq!(
            reason.params.get("code").map(String::as_str),
            Some("GIT_INVALID_WORKTREE_INFO")
        );
    }

    #[test]
    fn agent_config_items_are_capped_at_20() {
        let (fixture, run, before) = setup();
        for i in 0..25 {
            write_file(wt(&run), &format!(".claude/commands/c{i:02}.md"), "x\n");
        }
        let reason = check(&fixture, &run, &before).reason.expect("reason");
        assert_eq!(reason.code, "ATTENTION_AGENT_CONFIG_CHANGED");
        let found = items(&reason);
        assert_eq!(found.len(), 20);
        assert_eq!(found[0], ".claude/commands/c00.md");
    }

    #[test]
    fn items_json_caps_entries_and_excerpt_length() {
        let values: Vec<String> = (0..30).map(|i| i.to_string()).collect();
        let parsed: Vec<String> = serde_json::from_str(&items_json(&values)).unwrap();
        assert_eq!(parsed.len(), 20);
        assert_eq!(parsed[0], "0");
        assert_eq!(excerpt(&"\u{e9}".repeat(300)).chars().count(), 160);
        assert_eq!(excerpt("short"), "short");
    }

    #[test]
    fn deleted_agent_config_file_has_no_hash() {
        let fixture = Fixture::new();
        fixture.write(".mcp.json", "{}\n");
        fixture.run(&["add", ".mcp.json"]);
        fixture.run(&["commit", "-m", "mcp"]);
        let info = fixture.create("t");
        std::fs::remove_file(Path::new(&info.path).join(".mcp.json")).unwrap();
        let found = agent_config_fingerprints(fixture.base(), &info).unwrap();
        assert_eq!(
            found,
            [FileFingerprint {
                path: ".mcp.json".to_string(),
                sha256: None,
            }]
        );
    }

    #[test]
    fn fingerprints_are_sorted_and_hash_file_content() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let root = Path::new(&info.path);
        write_file(root, "opencode.json", "{}\n");
        write_file(root, ".claude/settings.json", "{}\n");
        let found = agent_config_fingerprints(fixture.base(), &info).unwrap();
        let paths: Vec<_> = found.iter().map(|fp| fp.path.as_str()).collect();
        assert_eq!(paths, [".claude/settings.json", "opencode.json"]);
        // sha256("{}\n")
        let expected = "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356";
        assert!(
            found
                .iter()
                .all(|fp| fp.sha256.as_deref() == Some(expected)),
            "{found:?}"
        );
    }

    #[test]
    fn unacknowledged_compares_path_and_hash() {
        let fp = |path: &str, sha: Option<&str>| FileFingerprint {
            path: path.to_string(),
            sha256: sha.map(str::to_string),
        };
        let acknowledged = [fp("a", Some("1")), fp("gone", None)];
        let current = [
            fp("a", Some("1")),
            fp("b", Some("2")),
            fp("gone", None),
            fp("a2", Some("1")),
        ];
        assert_eq!(unacknowledged(&current, &acknowledged), ["b", "a2"]);
        assert_eq!(unacknowledged(&[fp("a", Some("9"))], &acknowledged), ["a"]);
        assert_eq!(
            unacknowledged(&[fp("gone", Some("1"))], &acknowledged),
            ["gone"]
        );
        assert!(unacknowledged(&[], &acknowledged).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed_out_of_the_worktree() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let root = Path::new(&info.path);
        let outside = tempfile::TempDir::new().unwrap();
        write_file(outside.path(), "secret.json", "one\n");
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.json"),
            root.join(".claude").join("settings.json"),
        )
        .unwrap();
        let before = agent_config_fingerprints(fixture.base(), &info).unwrap();
        assert_eq!(before.len(), 1);
        assert!(before[0].sha256.is_some());
        // Changing the target outside the worktree does not change the
        // fingerprint: only the link itself is hashed.
        write_file(outside.path(), "secret.json", "two\n");
        assert_eq!(
            agent_config_fingerprints(fixture.base(), &info).unwrap(),
            before
        );
    }

    #[test]
    fn worktree_paths_must_stay_inside() {
        let dir = tempfile::TempDir::new().unwrap();
        for bad in ["../x", "/etc/passwd", "a/../../x", "C:/x", ""] {
            assert!(
                hash_worktree_path(dir.path(), bad, FINGERPRINT_BYTES_MAX).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn config_directory_replaced_by_a_file_is_reported() {
        let (fixture, run, before) = setup();
        write_file(wt(&run), ".claude", "not a directory\n");
        let reason = check(&fixture, &run, &before).reason.expect("reason");
        assert_eq!(reason.code, "ATTENTION_AGENT_CONFIG_CHANGED");
        assert_eq!(items(&reason), [serde_json::json!(".claude")]);
    }

    /// Makes `link` a directory symlink (or, on Windows, a junction) to
    /// `target`; false if the platform does not permit it.
    fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(target, link).is_ok() {
                return true;
            }
            std::process::Command::new("cmd")
                .arg("/c")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .output()
                .is_ok_and(|out| out.status.success())
                && link.exists()
        }
    }

    #[test]
    fn config_directory_replaced_by_a_link_is_reported() {
        let (fixture, run, before) = setup();
        let root = wt(&run);
        write_file(root, "elsewhere/settings.json", "{}\n");
        if !link_dir(&root.join("elsewhere"), &root.join(".claude")) {
            eprintln!("skipped: cannot create a directory link here");
            return;
        }
        let reason = check(&fixture, &run, &before).reason.expect("reason");
        assert_eq!(reason.code, "ATTENTION_AGENT_CONFIG_CHANGED");
        let found = items(&reason);
        assert!(!found.is_empty());
        assert!(
            found
                .iter()
                .all(|item| item.as_str().unwrap().starts_with(".claude")),
            "{found:?}"
        );
        // The link is fingerprinted, not what it points at.
        let info = run.worktree.as_ref().unwrap();
        let first = agent_config_fingerprints(fixture.base(), info).unwrap();
        write_file(root, "elsewhere/settings.json", "{\"x\":1}\n");
        assert_eq!(
            agent_config_fingerprints(fixture.base(), info).unwrap(),
            first
        );
    }

    #[test]
    fn oversized_files_fail_closed() {
        let dir = tempfile::TempDir::new().unwrap();
        write_file(dir.path(), "big.json", "0123456789");
        write_file(dir.path(), "cfg/a.json", "01234");
        write_file(dir.path(), "cfg/b.json", "56789");
        assert!(hash_worktree_path(dir.path(), "big.json", 10)
            .unwrap()
            .is_some());
        let err = hash_worktree_path(dir.path(), "big.json", 9).unwrap_err();
        assert_eq!(err.code(), "CHECKS_FILE_TOO_LARGE");
        // A directory's files share one budget.
        assert!(hash_worktree_path(dir.path(), "cfg", 10).unwrap().is_some());
        let err = hash_worktree_path(dir.path(), "cfg", 9).unwrap_err();
        assert_eq!(err.code(), "CHECKS_FILE_TOO_LARGE");
        assert_eq!(
            check_failed(err.code())
                .params
                .get("code")
                .map(String::as_str),
            Some("CHECKS_FILE_TOO_LARGE")
        );
    }

    #[test]
    fn only_regular_files_are_opened_for_hashing() {
        let dir = tempfile::TempDir::new().unwrap();
        write_file(dir.path(), "a.json", "{}\n");
        assert!(open_regular_file(&dir.path().join("a.json")).is_ok());
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        assert!(open_regular_file(&dir.path().join("sub")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn opening_a_symlink_fails_instead_of_following_it() {
        let dir = tempfile::TempDir::new().unwrap();
        write_file(dir.path(), "real.json", "{}\n");
        std::os::unix::fs::symlink(dir.path().join("real.json"), dir.path().join("link.json"))
            .unwrap();
        assert!(open_regular_file(&dir.path().join("link.json")).is_err());
    }
}

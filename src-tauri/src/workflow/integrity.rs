//! Repository integrity checks (guard layer 4).
//!
//! Before and after agent work MDium snapshots the parts of the user's
//! repository an agent must never touch behind MDium's back: where HEAD
//! points, the base branch tip, the shared git config, and the hooks. The
//! user's working-tree file contents are deliberately NOT part of the
//! snapshot, since the user may keep editing while a workflow runs.
//!
//! It also finds changed paths in a worktree that match agent-config (or
//! merge-review) patterns, so such changes can be surfaced to the user.

use crate::workflow::gitops::{default_worktree_base, git, run_git_raw, validate_info, GitError};
use crate::workflow::model::WorktreeInfo;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// State of the user's repository that must only change through MDium.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegritySnapshot {
    /// Full symbolic ref of HEAD (e.g. `refs/heads/main`), or
    /// `detached:<commit>` on a detached HEAD.
    pub head_ref: String,
    /// Commit HEAD resolves to (empty in a repo without commits).
    pub head_commit: String,
    /// Tip of the base branch, if one was given and it exists.
    pub base_branch_commit: Option<String>,
    /// sha256 of `<common-dir>/config`.
    pub git_config_hash: String,
    /// sha256 over the sorted (relative path, content) pairs under
    /// `<common-dir>/hooks`.
    pub hooks_hash: String,
    /// `core.hooksPath`, if configured.
    pub hooks_path: Option<String>,
}

/// One detected difference between two snapshots: a stable machine `code`
/// plus a detail string for logs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityChange {
    pub code: String,
    pub detail: String,
}

/// Paths that configure coding agents (or git submodules / agent hooks).
/// A `dir/**` pattern matches everything inside `dir`; any other pattern
/// matches that exact trailing path. Both match at any depth.
pub const AGENT_CONFIG_PATTERNS: &[&str] = &[
    ".claude/**",
    ".opencode/**",
    "opencode.json",
    "opencode.jsonc",
    ".mcp.json",
    ".codex/**",
    ".copilot/**",
    ".vscode/settings.json",
    ".vscode/tasks.json",
    ".vscode/mcp.json",
    ".gitmodules",
    ".github/hooks/**",
];

/// Paths whose changes warrant extra review before merging: the agent
/// config paths plus CI, agent instructions, git hooks and dev containers.
pub const MERGE_REVIEW_PATTERNS: &[&str] = &[
    ".claude/**",
    ".opencode/**",
    "opencode.json",
    "opencode.jsonc",
    ".mcp.json",
    ".codex/**",
    ".copilot/**",
    ".vscode/settings.json",
    ".vscode/tasks.json",
    ".vscode/mcp.json",
    ".gitmodules",
    ".github/hooks/**",
    ".github/**",
    "AGENTS.md",
    "CLAUDE.md",
    ".husky/**",
    ".githooks/**",
    ".devcontainer/**",
];

/// Error code for a filesystem read that failed while hashing.
const IO_FAILED: &str = "IO_FAILED";

/// Prefix of `head_ref` on a detached HEAD.
const DETACHED_PREFIX: &str = "detached:";

/// Snapshots the repository containing `repo_root` (the user's checkout or
/// any of its worktrees; config and hooks live in the shared common dir).
/// `base_branch` is resolved as the exact branch `refs/heads/<name>`; a
/// missing branch yields `None`.
pub fn snapshot(
    repo_root: &Path,
    base_branch: Option<&str>,
) -> Result<IntegritySnapshot, GitError> {
    let common = common_dir(repo_root)?;
    let head_commit = resolve_head(repo_root)?;
    let symbolic = run_git_raw(repo_root, &["symbolic-ref", "--quiet", "HEAD"])?;
    let head_ref = if symbolic.success && !symbolic.stdout.trim().is_empty() {
        symbolic.stdout.trim().to_string()
    } else {
        format!("{DETACHED_PREFIX}{head_commit}")
    };
    let base_branch_commit = match base_branch {
        Some(name) => branch_commit(repo_root, name)?,
        None => None,
    };
    let hooks_path = git(
        repo_root,
        &["config", "--default", "", "--get", "core.hooksPath"],
    )?
    .trim()
    .to_string();
    Ok(IntegritySnapshot {
        head_ref,
        head_commit,
        base_branch_commit,
        git_config_hash: hash_file(&common.join("config"))?,
        hooks_hash: hash_tree(&common.join("hooks"))?,
        hooks_path: (!hooks_path.is_empty()).then_some(hooks_path),
    })
}

/// Absolute `<common-dir>` of the repository containing `dir`.
fn common_dir(dir: &Path) -> Result<PathBuf, GitError> {
    let out = git(dir, &["rev-parse", "--git-common-dir"])?;
    let path = PathBuf::from(out.trim());
    Ok(if path.is_absolute() {
        path
    } else {
        dir.join(path)
    })
}

/// The commit HEAD resolves to, or empty when HEAD is unborn.
fn resolve_head(repo: &Path) -> Result<String, GitError> {
    let out = run_git_raw(repo, &["rev-parse", "--quiet", "--verify", "HEAD^{commit}"])?;
    Ok(if out.success {
        out.stdout.trim().to_string()
    } else {
        String::new()
    })
}

/// Tip of the exact branch `refs/heads/<name>`, or `None` if it does not
/// exist. `show-ref --verify` accepts no revision syntax, and the fixed
/// `refs/heads/` prefix keeps the name from being parsed as an option.
fn branch_commit(repo: &Path, name: &str) -> Result<Option<String>, GitError> {
    let reference = format!("refs/heads/{name}");
    let out = run_git_raw(repo, &["show-ref", "--verify", "--hash", &reference])?;
    let hash = out.stdout.trim();
    Ok((out.success && !hash.is_empty()).then(|| hash.to_string()))
}

fn io_error(path: &Path, err: std::io::Error) -> GitError {
    GitError::new(IO_FAILED, format!("{}: {err}", path.display()))
}

/// Hex sha256 of a file's content; a missing file hashes as empty content.
fn hash_file(path: &Path) -> Result<String, GitError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(format!("{:x}", Sha256::digest(&bytes))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(format!("{:x}", Sha256::digest(b"")))
        }
        Err(err) => Err(io_error(path, err)),
    }
}

/// One entry under a hashed directory: `/`-separated relative path, kind
/// (`d`ir, `f`ile, sym`l`ink) and content (a symlink's target).
type TreeEntry = (String, u8, Vec<u8>);

/// Hex sha256 over every entry under `root`, sorted by relative path. Each
/// entry contributes its kind, path and content, the latter two
/// length-prefixed so entry boundaries are unambiguous. Symlinks are not
/// followed. A missing `root` hashes as empty.
fn hash_tree(root: &Path) -> Result<String, GitError> {
    let mut entries: Vec<TreeEntry> = Vec::new();
    collect_entries(root, "", &mut entries)?;
    entries.sort();
    let mut hasher = Sha256::new();
    for (rel, kind, content) in &entries {
        hasher.update([*kind]);
        hasher.update((rel.len() as u64).to_le_bytes());
        hasher.update(rel.as_bytes());
        hasher.update((content.len() as u64).to_le_bytes());
        hasher.update(content);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_entries(dir: &Path, prefix: &str, out: &mut Vec<TreeEntry>) -> Result<(), GitError> {
    let reader = match std::fs::read_dir(dir) {
        Ok(reader) => reader,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound && prefix.is_empty() => {
            return Ok(());
        }
        Err(err) => return Err(io_error(dir, err)),
    };
    for entry in reader {
        let entry = entry.map_err(|err| io_error(dir, err))?;
        let path = entry.path();
        let rel = format!("{prefix}{}", entry.file_name().to_string_lossy());
        let file_type = entry.file_type().map_err(|err| io_error(&path, err))?;
        if file_type.is_symlink() {
            let target = std::fs::read_link(&path).map_err(|err| io_error(&path, err))?;
            let target = target.to_string_lossy().into_owned().into_bytes();
            out.push((rel, b'l', target));
        } else if file_type.is_dir() {
            let child_prefix = format!("{rel}/");
            out.push((rel, b'd', Vec::new()));
            collect_entries(&path, &child_prefix, out)?;
        } else {
            let content = std::fs::read(&path).map_err(|err| io_error(&path, err))?;
            out.push((rel, b'f', content));
        }
    }
    Ok(())
}

/// Differences from `before` to `after`, in a fixed order. Callers pass the
/// latest snapshot taken after MDium's own changes (e.g. its merges) as
/// `before`, so every reported change was made by someone else.
pub fn compare(before: &IntegritySnapshot, after: &IntegritySnapshot) -> Vec<IntegrityChange> {
    let mut changes = Vec::new();
    let mut push = |code: &str, detail: String| {
        changes.push(IntegrityChange {
            code: code.to_string(),
            detail,
        })
    };
    let arrow = |a: Option<&str>, b: Option<&str>| {
        format!("{} -> {}", a.unwrap_or_default(), b.unwrap_or_default())
    };
    let both_detached =
        before.head_ref.starts_with(DETACHED_PREFIX) && after.head_ref.starts_with(DETACHED_PREFIX);
    if before.head_ref != after.head_ref && !both_detached {
        push(
            "BRANCH_SWITCHED",
            arrow(Some(&before.head_ref), Some(&after.head_ref)),
        );
    } else if before.head_commit != after.head_commit {
        push(
            "HEAD_MOVED",
            arrow(Some(&before.head_commit), Some(&after.head_commit)),
        );
    }
    if before.base_branch_commit != after.base_branch_commit {
        push(
            "BASE_BRANCH_MOVED",
            arrow(
                before.base_branch_commit.as_deref(),
                after.base_branch_commit.as_deref(),
            ),
        );
    }
    if before.git_config_hash != after.git_config_hash {
        push("GIT_CONFIG_CHANGED", String::new());
    }
    if before.hooks_hash != after.hooks_hash {
        push("HOOKS_CHANGED", String::new());
    }
    if before.hooks_path != after.hooks_path {
        push(
            "HOOKS_PATH_CHANGED",
            arrow(before.hooks_path.as_deref(), after.hooks_path.as_deref()),
        );
    }
    changes
}

/// Changed paths in the worktree matching `patterns`, sorted and unique:
/// commits since the base commit, staged and unstaged changes, and
/// untracked files, including ignored ones. Paths are repo-relative with
/// `/`; a wholly ignored directory appears once as `dir/`.
pub fn changed_paths_matching(
    info: &WorktreeInfo,
    patterns: &[&str],
) -> Result<Vec<String>, GitError> {
    changed_paths_matching_in(&default_worktree_base(), info, patterns)
}

fn changed_paths_matching_in(
    base_dir: &Path,
    info: &WorktreeInfo,
    patterns: &[&str],
) -> Result<Vec<String>, GitError> {
    validate_info(base_dir, None, info)?;
    let wt = Path::new(&info.path);
    let diff = |extra: &[&str]| -> Result<String, GitError> {
        let mut args = vec!["diff", "--name-only", "--no-renames", "-z"];
        args.extend_from_slice(extra);
        git(wt, &args)
    };
    let outputs = [
        // Committed since base.
        diff(&["--end-of-options", &info.base_commit, "HEAD", "--"])?,
        // Staged.
        diff(&["--cached", "--end-of-options", "HEAD", "--"])?,
        // Unstaged (working tree against HEAD).
        diff(&["--end-of-options", "HEAD", "--"])?,
        // Untracked, not ignored.
        git(wt, &["ls-files", "-z", "--others", "--exclude-standard"])?,
        // Untracked and ignored: agent settings such as
        // `.claude/settings.local.json` are commonly gitignored (often
        // globally) yet still take effect in the worktree. Wholly ignored
        // directories are listed once as `dir/` instead of being walked.
        git(
            wt,
            &[
                "ls-files",
                "-z",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
            ],
        )?,
    ];
    let paths: BTreeSet<&str> = outputs
        .iter()
        .flat_map(|out| out.split('\0'))
        .filter(|path| !path.is_empty())
        .filter(|path| patterns.iter().any(|pattern| path_matches(path, pattern)))
        .collect();
    // git may list a directory whose contents are all ignored both as `dir/`
    // and file by file; keep only the more precise file entries.
    Ok(paths
        .iter()
        .filter(|path| {
            !path.ends_with('/')
                || !paths
                    .iter()
                    .any(|other| other.len() > path.len() && other.starts_with(**path))
        })
        .map(|path| path.to_string())
        .collect())
}

/// True if `path` matches `pattern` (see [`AGENT_CONFIG_PATTERNS`]). A
/// `path` ending in `/` is a whole directory: it matches a `dir/**`
/// pattern when it is that directory or lies inside it. Separators are
/// normalized to `/`; on Windows, where the filesystem is case-insensitive,
/// ASCII case is ignored too.
fn path_matches(path: &str, pattern: &str) -> bool {
    let normalize = |s: &str| {
        let s = s.replace('\\', "/");
        if cfg!(windows) {
            s.to_ascii_lowercase()
        } else {
            s
        }
    };
    let path = normalize(path);
    let pattern = normalize(pattern);
    let is_dir = path.ends_with('/');
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if let Some(dir) = pattern.strip_suffix("/**") {
        // `dir` must appear as whole segments with something inside it (a
        // directory entry may be `dir` itself).
        let dir: Vec<&str> = dir.split('/').collect();
        let inner = usize::from(!is_dir);
        segments.len() >= dir.len() + inner
            && (0..=segments.len() - dir.len() - inner)
                .any(|i| segments[i..i + dir.len()] == dir[..])
    } else {
        // What a plain pattern names is never known to be inside a
        // collapsed directory.
        let tail: Vec<&str> = pattern.split('/').collect();
        !is_dir && segments.ends_with(&tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::gitops::test_support::{write_file, Fixture};

    fn codes(changes: &[IntegrityChange]) -> Vec<&str> {
        changes.iter().map(|c| c.code.as_str()).collect()
    }

    fn snap(fixture: &Fixture) -> IntegritySnapshot {
        snapshot(fixture.root(), Some("main")).unwrap()
    }

    /// Absolute `<common-dir>` as seen from `dir`.
    fn git_common_dir(dir: &Path) -> PathBuf {
        let out = git(dir, &["rev-parse", "--git-common-dir"]).unwrap();
        let path = PathBuf::from(out.trim());
        if path.is_absolute() {
            path
        } else {
            dir.join(path)
        }
    }

    fn commit_file(dir: &Path, rel: &str, content: &str, message: &str) {
        write_file(dir, rel, content);
        git(dir, &["add", "--", rel]).unwrap();
        git(dir, &["commit", "-m", message]).unwrap();
    }

    #[test]
    fn snapshot_is_stable_and_populated() {
        let fixture = Fixture::new();
        let before = snap(&fixture);
        let head = fixture.run(&["rev-parse", "HEAD"]).trim().to_string();
        assert_eq!(before.head_ref, "refs/heads/main");
        assert_eq!(before.head_commit, head);
        assert_eq!(before.base_branch_commit.as_deref(), Some(head.as_str()));
        assert_eq!(before.git_config_hash.len(), 64);
        assert_eq!(before.hooks_hash.len(), 64);
        assert_eq!(before.hooks_path, None);
        // Working-tree edits by the user are not integrity changes.
        fixture.write("a.txt", "user edit\n");
        let after = snap(&fixture);
        assert_eq!(before, after);
        assert!(compare(&before, &after).is_empty());
    }

    #[test]
    fn snapshot_round_trips_as_camel_case_json() {
        let fixture = Fixture::new();
        let before = snap(&fixture);
        let json = serde_json::to_string(&before).unwrap();
        assert!(json.contains("\"headRef\""), "{json}");
        assert!(json.contains("\"gitConfigHash\""), "{json}");
        let back: IntegritySnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back, before);
    }

    #[test]
    fn git_config_change_is_detected() {
        let fixture = Fixture::new();
        let before = snap(&fixture);
        fixture.run(&["config", "core.pager", "x"]);
        let changes = compare(&before, &snap(&fixture));
        assert_eq!(codes(&changes), ["GIT_CONFIG_CHANGED"]);
    }

    #[test]
    fn new_hook_is_detected() {
        let fixture = Fixture::new();
        let before = snap(&fixture);
        write_file(
            &git_common_dir(fixture.root()).join("hooks"),
            "pre-commit",
            "#!/bin/sh\nexit 0\n",
        );
        let changes = compare(&before, &snap(&fixture));
        assert_eq!(codes(&changes), ["HOOKS_CHANGED"]);
    }

    #[test]
    fn hook_content_change_in_subdirectory_is_detected() {
        let fixture = Fixture::new();
        let hooks = git_common_dir(fixture.root()).join("hooks");
        write_file(&hooks, "lib/helper.sh", "one\n");
        let before = snap(&fixture);
        write_file(&hooks, "lib/helper.sh", "two\n");
        let changes = compare(&before, &snap(&fixture));
        assert_eq!(codes(&changes), ["HOOKS_CHANGED"]);
    }

    #[test]
    fn hooks_path_change_is_detected() {
        let fixture = Fixture::new();
        let before = snap(&fixture);
        fixture.run(&["config", "core.hooksPath", "my-hooks"]);
        let after = snap(&fixture);
        assert_eq!(after.hooks_path.as_deref(), Some("my-hooks"));
        let changes = compare(&before, &after);
        let found = codes(&changes);
        assert!(found.contains(&"HOOKS_PATH_CHANGED"), "{found:?}");
        assert!(found.contains(&"GIT_CONFIG_CHANGED"), "{found:?}");
        assert_eq!(found.len(), 2, "{found:?}");
    }

    #[test]
    fn branch_switch_is_detected() {
        let fixture = Fixture::new();
        let before = snap(&fixture);
        fixture.run(&["checkout", "-b", "other"]);
        let changes = compare(&before, &snap(&fixture));
        assert_eq!(codes(&changes), ["BRANCH_SWITCHED"]);
        assert!(
            changes[0].detail.contains("refs/heads/other"),
            "{changes:?}"
        );
    }

    #[test]
    fn detaching_head_is_a_branch_switch() {
        let fixture = Fixture::new();
        let before = snap(&fixture);
        fixture.run(&["checkout", "--detach"]);
        let after = snap(&fixture);
        assert!(after.head_ref.starts_with("detached:"), "{after:?}");
        assert_eq!(codes(&compare(&before, &after)), ["BRANCH_SWITCHED"]);
    }

    #[test]
    fn commit_on_current_branch_moves_head() {
        let fixture = Fixture::new();
        fixture.run(&["checkout", "-b", "work"]);
        let before = snap(&fixture);
        commit_file(fixture.root(), "b.txt", "b\n", "user commit");
        let changes = compare(&before, &snap(&fixture));
        assert_eq!(codes(&changes), ["HEAD_MOVED"]);
    }

    #[test]
    fn new_commit_on_base_is_detected() {
        let fixture = Fixture::new();
        fixture.run(&["checkout", "-b", "work"]);
        let before = snap(&fixture);
        // Advance `main` without touching HEAD.
        let main = fixture.run(&["rev-parse", "main"]).trim().to_string();
        let tree = fixture
            .run(&["rev-parse", "main^{tree}"])
            .trim()
            .to_string();
        let commit = fixture
            .run(&["commit-tree", &tree, "-p", &main, "-m", "base"])
            .trim()
            .to_string();
        fixture.run(&["update-ref", "refs/heads/main", &commit]);
        let changes = compare(&before, &snap(&fixture));
        assert_eq!(codes(&changes), ["BASE_BRANCH_MOVED"]);
    }

    #[test]
    fn missing_or_absent_base_branch_is_none() {
        let fixture = Fixture::new();
        assert_eq!(
            snapshot(fixture.root(), None).unwrap().base_branch_commit,
            None
        );
        assert_eq!(
            snapshot(fixture.root(), Some("nope"))
                .unwrap()
                .base_branch_commit,
            None
        );
        // Revision syntax is not resolved: only an exact branch counts.
        assert_eq!(
            snapshot(fixture.root(), Some("main~0"))
                .unwrap()
                .base_branch_commit,
            None
        );
    }

    #[test]
    fn worktree_shares_the_common_dir() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let wt = Path::new(&info.path);
        let main_before = snap(&fixture);
        let wt_before = snapshot(wt, Some("main")).unwrap();
        assert_eq!(wt_before.git_config_hash, main_before.git_config_hash);
        assert_eq!(wt_before.hooks_hash, main_before.hooks_hash);
        assert_eq!(wt_before.head_ref, format!("refs/heads/{}", info.branch));

        // A hook written via the worktree's common dir lands in the shared
        // hooks and is visible from the user's checkout.
        write_file(&git_common_dir(wt).join("hooks"), "post-checkout", "evil\n");
        let changes = compare(&main_before, &snap(&fixture));
        assert_eq!(codes(&changes), ["HOOKS_CHANGED"]);
    }

    #[test]
    fn changed_paths_match_agent_config_patterns() {
        let fixture = Fixture::new();
        let info = fixture.create("t");
        let wt = Path::new(&info.path);
        commit_file(wt, "sub/.mcp.json", "{}\n", "committed mcp");
        commit_file(wt, "src/a.ts", "a\n", "code");
        write_file(wt, ".claude/settings.local.json", "{}\n");
        write_file(wt, ".github/workflows/ci.yml", "on: push\n");
        write_file(wt, "AGENTS.md", "rules\n");
        write_file(wt, "src/b.ts", "b\n");

        let found =
            changed_paths_matching_in(fixture.base(), &info, AGENT_CONFIG_PATTERNS).unwrap();
        assert_eq!(found, [".claude/settings.local.json", "sub/.mcp.json"]);

        let found =
            changed_paths_matching_in(fixture.base(), &info, MERGE_REVIEW_PATTERNS).unwrap();
        assert_eq!(
            found,
            [
                ".claude/settings.local.json",
                ".github/workflows/ci.yml",
                "AGENTS.md",
                "sub/.mcp.json",
            ]
        );
    }

    #[test]
    fn changed_paths_include_modified_and_staged_files() {
        let fixture = Fixture::new();
        fixture.write(".vscode/settings.json", "{}\n");
        fixture.write("opencode.json", "{}\n");
        fixture.run(&["add", "."]);
        fixture.run(&["commit", "-m", "configs"]);
        let info = fixture.create("t");
        let wt = Path::new(&info.path);
        assert!(
            changed_paths_matching_in(fixture.base(), &info, AGENT_CONFIG_PATTERNS)
                .unwrap()
                .is_empty()
        );

        write_file(wt, ".vscode/settings.json", "{\"x\":1}\n");
        write_file(wt, "opencode.json", "{\"y\":1}\n");
        git(wt, &["add", "--", "opencode.json"]).unwrap();
        let found =
            changed_paths_matching_in(fixture.base(), &info, AGENT_CONFIG_PATTERNS).unwrap();
        assert_eq!(found, [".vscode/settings.json", "opencode.json"]);
    }

    #[test]
    fn changed_paths_reject_invalid_worktree_info() {
        let fixture = Fixture::new();
        let mut info = fixture.create("t");
        info.base_commit = "--output=x".to_string();
        let err =
            changed_paths_matching_in(fixture.base(), &info, AGENT_CONFIG_PATTERNS).unwrap_err();
        assert_eq!(err.code, "INVALID_WORKTREE_INFO");
    }

    #[test]
    fn pattern_matching_rules() {
        let yes = |path: &str, pattern: &str| path_matches(path, pattern);
        // `/**` patterns match the directory's contents at any depth.
        assert!(yes(".claude/settings.json", ".claude/**"));
        assert!(yes("pkg/.claude/commands/x.md", ".claude/**"));
        assert!(!yes(".claude", ".claude/**"));
        assert!(!yes("my.claude/x", ".claude/**"));
        assert!(yes("a/.github/hooks/h.json", ".github/hooks/**"));
        assert!(!yes(".github/workflows/ci.yml", ".github/hooks/**"));
        // Plain patterns match a whole trailing path at any depth.
        assert!(yes("opencode.json", "opencode.json"));
        assert!(yes("deep/sub/opencode.json", "opencode.json"));
        assert!(!yes("myopencode.json", "opencode.json"));
        assert!(!yes("opencode.json/x", "opencode.json"));
        assert!(yes("x/.vscode/settings.json", ".vscode/settings.json"));
        assert!(!yes(".vscode/launch.json", ".vscode/settings.json"));
        // Backslash separators are normalized.
        assert!(yes("sub\\.mcp.json", ".mcp.json"));
        // Collapsed directory entries (trailing `/`).
        assert!(yes(".claude/", ".claude/**"));
        assert!(yes("a/.github/hooks/", ".github/hooks/**"));
        assert!(yes(".github/workflows/", ".github/**"));
        assert!(!yes(".github/", ".github/hooks/**"));
        assert!(!yes("node_modules/", ".claude/**"));
        assert!(!yes(".vscode/", ".vscode/settings.json"));
    }

    #[test]
    fn changed_paths_include_ignored_files() {
        let fixture = Fixture::new();
        fixture.write(
            ".gitignore",
            "settings.local.json\n.codex/\nnode_modules/\n",
        );
        fixture.run(&["add", ".gitignore"]);
        fixture.run(&["commit", "-m", "ignore"]);
        let info = fixture.create("t");
        let wt = Path::new(&info.path);
        write_file(wt, ".claude/settings.local.json", "{}\n");
        write_file(wt, ".codex/config.toml", "x\n");
        write_file(wt, "node_modules/pkg/.github/FUNDING.yml", "x\n");
        write_file(wt, "node_modules/pkg/.claude/settings.json", "x\n");

        let found =
            changed_paths_matching_in(fixture.base(), &info, MERGE_REVIEW_PATTERNS).unwrap();
        assert_eq!(found, [".claude/settings.local.json", ".codex/"]);
    }

    #[cfg(windows)]
    #[test]
    fn pattern_matching_ignores_case_on_windows() {
        assert!(path_matches(".Claude/Settings.json", ".claude/**"));
        assert!(path_matches("agents.md", "AGENTS.md"));
    }

    #[test]
    fn pattern_lists_are_complete() {
        for p in [
            ".claude/**",
            ".opencode/**",
            "opencode.json",
            "opencode.jsonc",
            ".mcp.json",
            ".codex/**",
            ".copilot/**",
            ".vscode/settings.json",
            ".vscode/tasks.json",
            ".vscode/mcp.json",
            ".gitmodules",
            ".github/hooks/**",
        ] {
            assert!(AGENT_CONFIG_PATTERNS.contains(&p), "{p}");
            assert!(MERGE_REVIEW_PATTERNS.contains(&p), "{p}");
        }
        for p in [
            ".github/**",
            "AGENTS.md",
            "CLAUDE.md",
            ".husky/**",
            ".githooks/**",
            ".devcontainer/**",
        ] {
            assert!(MERGE_REVIEW_PATTERNS.contains(&p), "{p}");
        }
        assert_eq!(AGENT_CONFIG_PATTERNS.len(), 12);
        assert_eq!(MERGE_REVIEW_PATTERNS.len(), 18);
    }
}

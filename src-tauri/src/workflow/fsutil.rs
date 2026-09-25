//! File utilities for the workflow foundation: atomic writes, id and
//! timestamp generation, and `.mdium/` path helpers.
//!
//! Every write under `.mdium/` goes through [`atomic_write`] so a crash or a
//! concurrent writer never leaves a partially written file on disk (Global
//! Constraints). Ids used to build paths are validated before use so a
//! malformed id can never escape `.mdium/` (no path traversal).

use rand::Rng;
use std::io;
use std::path::{Path, PathBuf};

/// Write `bytes` to `path` atomically: write to a uniquely named temp file
/// in the same directory, then rename over the target. Creates the parent
/// directory tree if it does not exist yet.
///
/// On Windows, `rename` over an existing file can occasionally fail with a
/// transient "access denied" or "already exists" error (e.g. a virus
/// scanner or another process briefly holding the target open). In that
/// case, remove the target explicitly and retry the rename once.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };
    std::fs::create_dir_all(&parent)?;

    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy()
        .into_owned();

    let temp_path = parent.join(format!(".{file_name}.{}.tmp", random_hex(8)));

    if let Err(err) = std::fs::write(&temp_path, bytes) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(err);
    }

    let result = match std::fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(err) if is_retryable_rename_error(&err) => {
            let _ = std::fs::remove_file(path);
            std::fs::rename(&temp_path, path)
        }
        Err(err) => Err(err),
    };

    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

/// Whether a `rename` failure is worth retrying once after removing the
/// target (Windows-specific transient failures).
fn is_retryable_rename_error(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::AlreadyExists
    )
}

/// A run of `len` lowercase hex characters from a cryptographically
/// irrelevant, but process-unique, RNG.
fn random_hex(len: usize) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| HEX[rng.gen_range(0..HEX.len())] as char)
        .collect()
}

/// A new random id: 16 lowercase hex characters, matching `^[0-9a-f]{16}$`.
pub fn new_id() -> String {
    random_hex(16)
}

/// The current UTC time as RFC 3339 with millisecond precision, e.g.
/// `2026-09-25T12:34:56.789Z`.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// An id failed the `^[0-9a-f]{16}$` shape check used before building any
/// `.mdium/` path from user- or agent-influenced input. Carries the
/// rejected id for error reporting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidId(pub String);

impl std::fmt::Display for InvalidId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid id: {:?}", self.0)
    }
}

/// True if `id` is exactly 16 lowercase hex characters.
fn is_valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn validate_id(id: &str) -> Result<(), InvalidId> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(InvalidId(id.to_string()))
    }
}

/// Resolves the fixed layout of `<project>/.mdium/` described in Global
/// Constraints. Every method that takes an id validates it first, so a
/// crafted id like `../../etc/passwd` can never produce a path outside
/// `.mdium/`.
#[derive(Debug, Clone)]
pub struct MdiumPaths {
    root: PathBuf,
}

impl MdiumPaths {
    /// `project_root` is the root of the user's project; `.mdium/` lives
    /// directly under it.
    pub fn new(project_root: impl Into<PathBuf>) -> Self {
        Self {
            root: project_root.into().join(".mdium"),
        }
    }

    /// The `.mdium/` directory itself.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `.mdium/workflows.json`.
    pub fn workflows_file(&self) -> PathBuf {
        self.root.join("workflows.json")
    }

    /// `.mdium/tasks/`.
    pub fn tasks_dir(&self) -> PathBuf {
        self.root.join("tasks")
    }

    /// `.mdium/tasks/<id>.md`.
    pub fn task_file(&self, id: &str) -> Result<PathBuf, InvalidId> {
        validate_id(id)?;
        Ok(self.tasks_dir().join(format!("{id}.md")))
    }

    /// `.mdium/runs/`.
    pub fn runs_dir(&self) -> PathBuf {
        self.root.join("runs")
    }

    /// `.mdium/runs/<rootId>.json`.
    pub fn run_file(&self, root_id: &str) -> Result<PathBuf, InvalidId> {
        validate_id(root_id)?;
        Ok(self.runs_dir().join(format!("{root_id}.json")))
    }

    /// `.mdium/runs/<rootId>/<taskId>/<attemptId>.md` (attempt output).
    pub fn attempt_output(
        &self,
        root_id: &str,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<PathBuf, InvalidId> {
        validate_id(attempt_id)?;
        Ok(self
            .attempt_dir(root_id, task_id)?
            .join(format!("{attempt_id}.md")))
    }

    /// `.mdium/runs/<rootId>/<taskId>/<attemptId>.log` (attempt log).
    pub fn attempt_log(
        &self,
        root_id: &str,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<PathBuf, InvalidId> {
        validate_id(attempt_id)?;
        Ok(self
            .attempt_dir(root_id, task_id)?
            .join(format!("{attempt_id}.log")))
    }

    /// `.mdium/runs/<rootId>/<taskId>/`, validating all three ids that will
    /// ultimately be used (root, task, and — via the caller — attempt).
    fn attempt_dir(&self, root_id: &str, task_id: &str) -> Result<PathBuf, InvalidId> {
        validate_id(root_id)?;
        validate_id(task_id)?;
        Ok(self.runs_dir().join(root_id).join(task_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target.txt");

        atomic_write(&path, b"first").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

        atomic_write(&path, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");

        let leftover: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name() != "target.txt")
            .collect();
        assert!(leftover.is_empty(), "leftover files: {leftover:?}");
    }

    #[test]
    fn atomic_write_creates_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("deep").join("target.txt");

        atomic_write(&path, b"hello").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
    }

    #[test]
    fn concurrent_writers_never_produce_a_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = std::sync::Arc::new(dir.path().join("shared.json"));
        let per_thread = 200usize;

        let content_for = |label: &str, seq: usize| -> String {
            format!(
                "{{\"writer\":\"{label}\",\"seq\":{seq},\"padding\":\"{}\"}}",
                "x".repeat(500)
            )
        };

        let mut possible_contents: HashSet<String> = HashSet::new();
        for label in ["a", "b"] {
            for seq in 0..per_thread {
                possible_contents.insert(content_for(label, seq));
            }
        }

        let handles: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|label| {
                let path = std::sync::Arc::clone(&path);
                std::thread::spawn(move || {
                    for seq in 0..per_thread {
                        let content = content_for(label, seq);
                        atomic_write(&path, content.as_bytes()).unwrap();
                    }
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap();
        }

        let final_content = std::fs::read_to_string(&*path).unwrap();
        assert!(
            possible_contents.contains(&final_content),
            "final content did not match any single write"
        );

        // The content must parse cleanly (no truncation or interleaving of
        // two writers' bytes).
        let _: serde_json::Value = serde_json::from_str(&final_content).unwrap();

        let leftover: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name() != "shared.json")
            .collect();
        assert!(leftover.is_empty(), "leftover files: {leftover:?}");
    }

    #[test]
    fn new_id_is_sixteen_lowercase_hex_chars() {
        let id = new_id();
        assert_eq!(id.len(), 16);
        assert!(id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    }

    #[test]
    fn now_is_rfc3339_with_millis_and_zulu_suffix() {
        let ts = now();
        assert!(ts.ends_with('Z'), "expected Zulu suffix: {ts}");
        assert!(chrono::DateTime::parse_from_rfc3339(&ts).is_ok(), "not RFC 3339: {ts}");
    }

    #[test]
    fn mdium_paths_rejects_path_traversal_ids() {
        let paths = MdiumPaths::new(PathBuf::from("project"));
        let valid = "0123456789abcdef";

        assert!(paths.task_file("../x").is_err());
        assert!(paths.run_file("../x").is_err());
        assert!(paths.attempt_output("../x", valid, valid).is_err());
        assert!(paths.attempt_output(valid, "../x", valid).is_err());
        assert!(paths.attempt_output(valid, valid, "../x").is_err());
        assert!(paths.attempt_log("../x", valid, valid).is_err());
        assert!(paths.task_file("0123456789ABCDEF").is_err(), "uppercase must be rejected");
        assert!(paths.task_file("short").is_err());
    }

    #[test]
    fn mdium_paths_builds_expected_layout_for_valid_ids() {
        let paths = MdiumPaths::new(PathBuf::from("project"));
        let root_id = "aaaaaaaaaaaaaaaa";
        let task_id = "bbbbbbbbbbbbbbbb";
        let attempt_id = "cccccccccccccccc";

        assert_eq!(paths.root(), Path::new("project/.mdium"));
        assert_eq!(paths.workflows_file(), Path::new("project/.mdium/workflows.json"));
        assert_eq!(paths.tasks_dir(), Path::new("project/.mdium/tasks"));
        assert_eq!(
            paths.task_file(task_id).unwrap(),
            Path::new("project/.mdium/tasks/bbbbbbbbbbbbbbbb.md")
        );
        assert_eq!(paths.runs_dir(), Path::new("project/.mdium/runs"));
        assert_eq!(
            paths.run_file(root_id).unwrap(),
            Path::new("project/.mdium/runs/aaaaaaaaaaaaaaaa.json")
        );
        assert_eq!(
            paths.attempt_output(root_id, task_id, attempt_id).unwrap(),
            Path::new("project/.mdium/runs/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb/cccccccccccccccc.md")
        );
        assert_eq!(
            paths.attempt_log(root_id, task_id, attempt_id).unwrap(),
            Path::new("project/.mdium/runs/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb/cccccccccccccccc.log")
        );
    }
}

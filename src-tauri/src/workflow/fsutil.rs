//! File utilities for the workflow foundation: atomic writes, id and
//! timestamp generation, and `.mdium/` path helpers.
//!
//! Every write under `.mdium/` goes through [`atomic_write`] so a crash or a
//! concurrent writer never leaves a partially written file on disk (Global
//! Constraints). Ids used to build paths are validated before use so a
//! malformed id can never escape `.mdium/` (no path traversal).

pub use flow_core::fsutil::{atomic_write, is_valid_id, new_id, now};

use std::path::{Path, PathBuf};

/// An id failed the `^[0-9a-f]{16}$` shape check used before building any
/// `.mdium/` path from user- or agent-influenced input. Carries the
/// rejected id for error reporting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidId(pub String);

impl InvalidId {
    /// Stable machine code: the same `STORE_INVALID_ID` the store reports
    /// for this failure.
    pub fn code(&self) -> &'static str {
        "STORE_INVALID_ID"
    }
}

impl std::fmt::Display for InvalidId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {:?}", self.code(), self.0)
    }
}

crate::workflow::errors::impl_workflow_error!(InvalidId);

pub(crate) fn validate_id(id: &str) -> Result<(), InvalidId> {
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

    /// `.mdium/task-attachments/`: committed attachments and drafts.
    pub fn attachments_root(&self) -> PathBuf {
        self.root.join("task-attachments")
    }

    /// `.mdium/task-attachments/<rootTaskId>/`: all committed attachments
    /// of one root task.
    pub fn task_attachments_dir(&self, root_id: &str) -> Result<PathBuf, InvalidId> {
        validate_id(root_id)?;
        Ok(self.attachments_root().join(root_id))
    }

    /// `.mdium/task-attachments/<rootTaskId>/<attachmentId>/`.
    pub fn attachment_dir(&self, root_id: &str, attachment_id: &str) -> Result<PathBuf, InvalidId> {
        validate_id(attachment_id)?;
        Ok(self.task_attachments_dir(root_id)?.join(attachment_id))
    }

    /// `.mdium/task-attachments/_drafts/<intakeId>/`: the drafts of one
    /// intake session. `_drafts` can never collide with a root task id,
    /// which is always 16 hex characters.
    pub fn drafts_dir(&self, intake_id: &str) -> Result<PathBuf, InvalidId> {
        validate_id(intake_id)?;
        Ok(self.attachments_root().join("_drafts").join(intake_id))
    }

    /// `.mdium/task-attachments/_drafts/<intakeId>/<draftId>/`.
    pub fn draft_dir(&self, intake_id: &str, draft_id: &str) -> Result<PathBuf, InvalidId> {
        validate_id(draft_id)?;
        Ok(self.drafts_dir(intake_id)?.join(draft_id))
    }

    /// `.mdium/intakes/`.
    pub fn intakes_dir(&self) -> PathBuf {
        self.root.join("intakes")
    }

    /// `.mdium/intakes/<intakeId>.json`.
    pub fn intake_file(&self, intake_id: &str) -> Result<PathBuf, InvalidId> {
        validate_id(intake_id)?;
        Ok(self.intakes_dir().join(format!("{intake_id}.json")))
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
    fn new_id_is_sixteen_lowercase_hex_chars() {
        let id = new_id();
        assert_eq!(id.len(), 16);
        assert!(id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    }

    #[test]
    fn now_is_rfc3339_with_millis_and_zulu_suffix() {
        let ts = now();
        assert!(ts.ends_with('Z'), "expected Zulu suffix: {ts}");
        assert!(
            chrono::DateTime::parse_from_rfc3339(&ts).is_ok(),
            "not RFC 3339: {ts}"
        );
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
        assert!(
            paths.task_file("0123456789ABCDEF").is_err(),
            "uppercase must be rejected"
        );
        assert!(paths.task_file("short").is_err());
    }

    #[test]
    fn mdium_paths_builds_expected_layout_for_valid_ids() {
        let paths = MdiumPaths::new(PathBuf::from("project"));
        let root_id = "aaaaaaaaaaaaaaaa";
        let task_id = "bbbbbbbbbbbbbbbb";
        let attempt_id = "cccccccccccccccc";

        assert_eq!(paths.root(), Path::new("project/.mdium"));
        assert_eq!(
            paths.workflows_file(),
            Path::new("project/.mdium/workflows.json")
        );
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

    #[test]
    fn mdium_paths_builds_attachment_and_intake_layout() {
        let paths = MdiumPaths::new(PathBuf::from("project"));
        let a = "aaaaaaaaaaaaaaaa";
        let b = "bbbbbbbbbbbbbbbb";

        assert_eq!(
            paths.attachments_root(),
            Path::new("project/.mdium/task-attachments")
        );
        assert_eq!(
            paths.task_attachments_dir(a).unwrap(),
            Path::new("project/.mdium/task-attachments/aaaaaaaaaaaaaaaa")
        );
        assert_eq!(
            paths.attachment_dir(a, b).unwrap(),
            Path::new("project/.mdium/task-attachments/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb")
        );
        assert_eq!(
            paths.drafts_dir(a).unwrap(),
            Path::new("project/.mdium/task-attachments/_drafts/aaaaaaaaaaaaaaaa")
        );
        assert_eq!(
            paths.draft_dir(a, b).unwrap(),
            Path::new("project/.mdium/task-attachments/_drafts/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb")
        );
        assert_eq!(paths.intakes_dir(), Path::new("project/.mdium/intakes"));
        assert_eq!(
            paths.intake_file(a).unwrap(),
            Path::new("project/.mdium/intakes/aaaaaaaaaaaaaaaa.json")
        );

        assert!(paths.task_attachments_dir("../x").is_err());
        assert!(paths.attachment_dir("../x", b).is_err());
        assert!(paths.attachment_dir(a, "..").is_err());
        assert!(paths.drafts_dir("_drafts").is_err());
        assert!(paths.draft_dir(a, "../../x").is_err());
        assert!(paths.draft_dir("../x", b).is_err());
        assert!(paths.intake_file("../x").is_err());
    }
}

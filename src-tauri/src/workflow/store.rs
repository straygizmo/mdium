//! Persistence layer for `.mdium/`.
//!
//! This task (2) covers `workflows.json`. Tasks 3 and 4 extend this same
//! file with task documents (YAML-frontmatter Markdown) and workflow runs /
//! attempt artifacts, reusing [`StoreError`] and [`WorkflowStore`].

use crate::workflow::fsutil::{self, InvalidId, MdiumPaths};
use crate::workflow::model::{ValidationError, WorkflowsFile};
use std::path::PathBuf;

/// The only schema version this store currently reads or writes. A file
/// with any other `schemaVersion` is reported via
/// [`StoreError::UnsupportedSchema`] rather than guessed at.
const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Errors from the `.mdium/` file store. New variants needed by Tasks 3-4
/// (task documents, runs, attempt artifacts) are additive to this enum.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreError {
    /// An I/O failure not otherwise classified below.
    Io(String),
    /// The requested record does not exist on disk.
    NotFound,
    /// The file exists but could not be parsed as its expected shape.
    Corrupt(String),
    /// A value that passed validation could not be serialized to its
    /// on-disk encoding (JSON/YAML). Distinct from `Corrupt`, which is
    /// about *reading* an existing file.
    Encode(String),
    /// The file's `schemaVersion` is not one this store understands.
    UnsupportedSchema(u32),
    /// A workflow failed `Workflow::validate()`.
    Invalid(Vec<ValidationError>),
    /// An id used to address a record does not match the required shape.
    InvalidId(String),
}

impl StoreError {
    /// Stable machine code for this failure, for callers/UI to key off.
    pub fn code(&self) -> &'static str {
        match self {
            StoreError::Io(_) => "STORE_IO",
            StoreError::NotFound => "STORE_NOT_FOUND",
            StoreError::Corrupt(_) => "STORE_CORRUPT",
            StoreError::Encode(_) => "ENCODE_ERROR",
            StoreError::UnsupportedSchema(_) => "STORE_UNSUPPORTED_SCHEMA",
            StoreError::Invalid(_) => "STORE_INVALID",
            StoreError::InvalidId(_) => "STORE_INVALID_ID",
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(err: std::io::Error) -> Self {
        StoreError::Io(err.to_string())
    }
}

impl From<InvalidId> for StoreError {
    fn from(err: InvalidId) -> Self {
        StoreError::InvalidId(err.0)
    }
}

/// Reads and writes `.mdium/` for one project. Cheap to construct; holds no
/// open handles or caches.
pub struct WorkflowStore {
    paths: MdiumPaths,
}

impl WorkflowStore {
    pub fn new(project_root: PathBuf) -> Self {
        Self {
            paths: MdiumPaths::new(project_root),
        }
    }

    /// Loads `.mdium/workflows.json`. A missing file is not an error: it is
    /// treated as an empty file at the current schema version.
    pub fn load_workflows(&self) -> Result<WorkflowsFile, StoreError> {
        let path = self.paths.workflows_file();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WorkflowsFile {
                    schema_version: CURRENT_SCHEMA_VERSION,
                    workflows: Vec::new(),
                });
            }
            Err(err) => return Err(StoreError::Io(err.to_string())),
        };

        let file: WorkflowsFile =
            serde_json::from_slice(&bytes).map_err(|err| StoreError::Corrupt(err.to_string()))?;

        if file.schema_version != CURRENT_SCHEMA_VERSION {
            return Err(StoreError::UnsupportedSchema(file.schema_version));
        }

        Ok(file)
    }

    /// Validates every workflow, then atomically writes
    /// `.mdium/workflows.json`. Nothing is written if any workflow fails
    /// validation.
    pub fn save_workflows(&self, file: &WorkflowsFile) -> Result<(), StoreError> {
        let mut errors = Vec::new();
        for workflow in &file.workflows {
            if let Err(mut workflow_errors) = workflow.validate() {
                errors.append(&mut workflow_errors);
            }
        }
        if !errors.is_empty() {
            return Err(StoreError::Invalid(errors));
        }

        let bytes = serde_json::to_vec_pretty(file)
            .map_err(|err| StoreError::Encode(err.to_string()))?;
        fsutil::atomic_write(&self.paths.workflows_file(), &bytes)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::model::{IssueTracking, Provider, Role, Stage, Workflow};

    fn sample_stage(id: &str, role: Role) -> Stage {
        Stage {
            id: id.to_string(),
            role,
            name: format!("{id} stage"),
            prompt: format!("{id} prompt"),
            completion_criteria: format!("{id} done"),
            provider: Provider::Claude,
            model: None,
            requires_approval: false,
            timeout_minutes: 60,
        }
    }

    fn sample_workflow() -> Workflow {
        Workflow {
            id: "wf-1".to_string(),
            name: "Sample Workflow".to_string(),
            enabled: true,
            archived: false,
            stages: vec![
                sample_stage("design", Role::Design),
                sample_stage("implement", Role::Implement),
                sample_stage("review", Role::Review),
            ],
            review_return_to: Role::Design,
            max_reentry_count: 5,
            max_concurrent_runs: 1,
            design_doc_path: None,
            issue_tracking: IssueTracking::Auto,
        }
    }

    #[test]
    fn load_missing_workflows_file_returns_empty_schema_v1() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let file = store.load_workflows().unwrap();
        assert_eq!(file.schema_version, 1);
        assert!(file.workflows.is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let file = WorkflowsFile {
            schema_version: 1,
            workflows: vec![sample_workflow()],
        };
        store.save_workflows(&file).unwrap();

        let loaded = store.load_workflows().unwrap();
        assert_eq!(loaded, file);
    }

    #[test]
    fn save_rejects_invalid_workflow_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let mut workflow = sample_workflow();
        workflow.max_reentry_count = 0;
        let file = WorkflowsFile {
            schema_version: 1,
            workflows: vec![workflow],
        };

        let err = store.save_workflows(&file).unwrap_err();
        assert_eq!(err, StoreError::Invalid(vec![ValidationError::MaxReentry]));
        assert_eq!(err.code(), "STORE_INVALID");

        // The invalid save must not have created workflows.json.
        let loaded = store.load_workflows().unwrap();
        assert!(loaded.workflows.is_empty());
    }

    #[test]
    fn load_unsupported_schema_version_errors() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let mdium_dir = dir.path().join(".mdium");
        std::fs::create_dir_all(&mdium_dir).unwrap();
        let raw = serde_json::json!({ "schemaVersion": 2, "workflows": [] });
        std::fs::write(
            mdium_dir.join("workflows.json"),
            serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap();

        let err = store.load_workflows().unwrap_err();
        assert_eq!(err, StoreError::UnsupportedSchema(2));
        assert_eq!(err.code(), "STORE_UNSUPPORTED_SCHEMA");
    }

    #[test]
    fn load_corrupt_json_errors() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let mdium_dir = dir.path().join(".mdium");
        std::fs::create_dir_all(&mdium_dir).unwrap();
        std::fs::write(mdium_dir.join("workflows.json"), b"not json").unwrap();

        let err = store.load_workflows().unwrap_err();
        assert_eq!(err.code(), "STORE_CORRUPT");
    }
}

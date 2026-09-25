//! Persistence layer for `.mdium/`.
//!
//! Covers `workflows.json` and task documents (YAML-frontmatter Markdown).
//! Task 4 extends this same file with workflow runs / attempt artifacts,
//! reusing [`StoreError`] and [`WorkflowStore`].

use crate::workflow::fsutil::{self, InvalidId, MdiumPaths};
use crate::workflow::model::{Task, TaskMeta, ValidationError, WorkflowsFile};
use std::path::{Path, PathBuf};

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
    /// A create operation found the record already present on disk.
    AlreadyExists,
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
            StoreError::AlreadyExists => "STORE_ALREADY_EXISTS",
        }
    }

    /// `code()` plus any detail, for warnings and logs. Not user-facing
    /// text: the UI localizes by code.
    fn describe(&self) -> String {
        match self {
            StoreError::Io(detail)
            | StoreError::Corrupt(detail)
            | StoreError::Encode(detail)
            | StoreError::InvalidId(detail) => format!("{}: {detail}", self.code()),
            StoreError::UnsupportedSchema(version) => format!("{}: {version}", self.code()),
            StoreError::Invalid(errors) => format!("{}: {errors:?}", self.code()),
            StoreError::NotFound | StoreError::AlreadyExists => self.code().to_string(),
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

/// A task file that could not be loaded during [`WorkflowStore::list_tasks`].
/// Listing never fails because of one bad file; it reports it here instead.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreWarning {
    /// Path of the offending file.
    pub file: String,
    /// Machine-oriented description (`STORE_*` code plus detail).
    pub message: String,
}

/// Result of [`WorkflowStore::list_tasks`]: every task that loaded, sorted
/// by `created_at` then id, plus one warning per file that did not.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TaskList {
    pub tasks: Vec<Task>,
    pub warnings: Vec<StoreWarning>,
}

/// Fails with [`StoreError::UnsupportedSchema`] unless `version` is
/// [`CURRENT_SCHEMA_VERSION`]. Used on both read and write, so the store
/// never writes a file it would refuse to read back.
fn check_schema_version(version: u32) -> Result<(), StoreError> {
    if version == CURRENT_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(StoreError::UnsupportedSchema(version))
    }
}

/// Frontmatter delimiter line of a task document.
const FRONTMATTER_DELIMITER: &str = "---";

/// UTF-8 byte order mark that some Windows editors prepend.
const BOM: char = '\u{feff}';

/// Serializes a task document as `---\n<YAML>---\n\n<body>`. The body is
/// written verbatim.
fn encode_task(task: &Task) -> Result<String, StoreError> {
    let yaml =
        serde_yaml_ng::to_string(&task.meta).map_err(|err| StoreError::Encode(err.to_string()))?;
    Ok(format!(
        "{FRONTMATTER_DELIMITER}\n{yaml}{FRONTMATTER_DELIMITER}\n\n{}",
        task.body
    ))
}

/// Splits the first line off `text`, returning `(line, rest)`. The line
/// excludes its terminator, and a trailing `\r` is dropped so CRLF files
/// are handled like LF files.
fn split_line(text: &str) -> (&str, &str) {
    let (line, rest) = match text.find('\n') {
        Some(pos) => (&text[..pos], &text[pos + 1..]),
        None => (text, ""),
    };
    (line.strip_suffix('\r').unwrap_or(line), rest)
}

/// Parses a task document. Only the FIRST frontmatter block is metadata:
/// everything after its closing delimiter (minus the single blank separator
/// line) is the body, verbatim, even if it starts with `---` itself.
fn decode_task(text: &str) -> Result<Task, StoreError> {
    let text = text.strip_prefix(BOM).unwrap_or(text);

    let (first, mut rest) = split_line(text);
    if first != FRONTMATTER_DELIMITER {
        return Err(StoreError::Corrupt(
            "missing opening frontmatter delimiter".to_string(),
        ));
    }

    let mut yaml = String::new();
    let body = loop {
        if rest.is_empty() {
            return Err(StoreError::Corrupt(
                "missing closing frontmatter delimiter".to_string(),
            ));
        }
        let (line, next) = split_line(rest);
        rest = next;
        if line == FRONTMATTER_DELIMITER {
            // Drop the one blank separator line written by `encode_task`.
            break match rest.strip_prefix("\r\n") {
                Some(body) => body,
                None => rest.strip_prefix('\n').unwrap_or(rest),
            };
        }
        yaml.push_str(line);
        yaml.push('\n');
    };

    let meta: TaskMeta =
        serde_yaml_ng::from_str(&yaml).map_err(|err| StoreError::Corrupt(err.to_string()))?;
    check_schema_version(meta.schema_version)?;

    Ok(Task {
        meta,
        body: body.to_string(),
    })
}

/// Reads and parses one task file, requiring its frontmatter `id` to match
/// `expected_id` (the file name), so a copied or renamed file can never be
/// mistaken for a different task.
fn read_task_file(path: &Path, expected_id: &str) -> Result<Task, StoreError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(StoreError::NotFound),
        Err(err) => return Err(StoreError::Io(err.to_string())),
    };
    let text = String::from_utf8(bytes).map_err(|err| StoreError::Corrupt(err.to_string()))?;
    let task = decode_task(&text)?;
    if task.meta.id != expected_id {
        return Err(StoreError::Corrupt(format!(
            "frontmatter id {:?} does not match file name {expected_id:?}",
            task.meta.id
        )));
    }
    Ok(task)
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
    /// validation or the file's `schemaVersion` is not the current one.
    pub fn save_workflows(&self, file: &WorkflowsFile) -> Result<(), StoreError> {
        check_schema_version(file.schema_version)?;
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

    /// Writes a new task document at `.mdium/tasks/<meta.id>.md`. Fails
    /// with [`StoreError::AlreadyExists`] if that file is already present.
    /// The existence check and the write are not one atomic step; callers
    /// serialize task mutations per project. Rejects a `schemaVersion` this
    /// store cannot read back.
    pub fn create_task(&self, meta: TaskMeta, body: &str) -> Result<Task, StoreError> {
        let path = self.paths.task_file(&meta.id)?;
        check_schema_version(meta.schema_version)?;
        if path.try_exists()? {
            return Err(StoreError::AlreadyExists);
        }
        let task = Task {
            meta,
            body: body.to_string(),
        };
        fsutil::atomic_write(&path, encode_task(&task)?.as_bytes())?;
        Ok(task)
    }

    /// Loads the task document for `id`.
    pub fn get_task(&self, id: &str) -> Result<Task, StoreError> {
        let path = self.paths.task_file(id)?;
        read_task_file(&path, id)
    }

    /// Atomically overwrites an existing task document, stamping
    /// `updated_at` with the current time. Fails with
    /// [`StoreError::NotFound`] if the task file does not exist, so a
    /// deleted task is never resurrected (use [`Self::create_task`] for new
    /// tasks). Rejects a `schemaVersion` this store cannot read back.
    pub fn put_task(&self, task: &Task) -> Result<(), StoreError> {
        let path = self.paths.task_file(&task.meta.id)?;
        check_schema_version(task.meta.schema_version)?;
        if !path.try_exists()? {
            return Err(StoreError::NotFound);
        }
        let mut task = task.clone();
        task.meta.updated_at = fsutil::now();
        fsutil::atomic_write(&path, encode_task(&task)?.as_bytes())?;
        Ok(())
    }

    /// Loads every `<id>.md` file in `.mdium/tasks/`. Files that cannot be
    /// read or parsed are reported in [`TaskList::warnings`] instead of
    /// failing the whole listing. A missing tasks directory is an empty
    /// list.
    pub fn list_tasks(&self) -> Result<TaskList, StoreError> {
        let tasks_dir = self.paths.tasks_dir();
        let entries = match std::fs::read_dir(&tasks_dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(TaskList::default());
            }
            Err(err) => return Err(StoreError::Io(err.to_string())),
        };

        let mut list = TaskList::default();
        for entry in entries {
            let path = match entry {
                Ok(entry) => entry.path(),
                Err(err) => {
                    list.warnings.push(StoreWarning {
                        file: tasks_dir.display().to_string(),
                        message: StoreError::from(err).describe(),
                    });
                    continue;
                }
            };
            // Only visible `.md` files are task documents; this also skips
            // the hidden temp/backup files of in-flight or interrupted
            // atomic writes.
            let file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let Some(stem) = file_name.strip_suffix(".md") else {
                continue;
            };
            if file_name.starts_with('.') || !path.is_file() {
                continue;
            }

            // The stem must be a valid task id; anything else is reported
            // rather than loaded, since it could never be addressed by id.
            let loaded = match self.paths.task_file(stem) {
                Ok(_) => read_task_file(&path, stem),
                Err(err) => Err(StoreError::from(err)),
            };
            match loaded {
                Ok(task) => list.tasks.push(task),
                Err(err) => list.warnings.push(StoreWarning {
                    file: path.display().to_string(),
                    message: err.describe(),
                }),
            }
        }

        list.tasks.sort_by(|a, b| {
            a.meta
                .created_at
                .cmp(&b.meta.created_at)
                .then_with(|| a.meta.id.cmp(&b.meta.id))
        });
        Ok(list)
    }

    /// Deletes the task document for `id`.
    pub fn delete_task(&self, id: &str) -> Result<(), StoreError> {
        let path = self.paths.task_file(id)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(StoreError::NotFound),
            Err(err) => Err(StoreError::Io(err.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::model::{IssueTracking, Provider, Role, Stage, TaskStatus, Workflow};

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

    // ---- Task documents ----

    const TASK_A: &str = "0000000000000001";
    const TASK_B: &str = "0000000000000002";
    const TASK_C: &str = "0000000000000003";

    fn sample_task_meta(id: &str, created_at: &str) -> TaskMeta {
        TaskMeta {
            schema_version: 1,
            id: id.to_string(),
            title: format!("Task {id}"),
            status: TaskStatus::Inbox,
            root_id: id.to_string(),
            parent_id: None,
            workflow_id: Some("wf-1".to_string()),
            stage_id: None,
            role: Some(Role::Design),
            auto_generated: false,
            archived: false,
            created_at: created_at.to_string(),
            updated_at: created_at.to_string(),
            attention: None,
            history: Vec::new(),
        }
    }

    fn task_path(dir: &std::path::Path, id: &str) -> PathBuf {
        dir.join(".mdium").join("tasks").join(format!("{id}.md"))
    }

    fn write_raw_task_file(dir: &std::path::Path, file_name: &str, content: &[u8]) {
        let tasks_dir = dir.join(".mdium").join("tasks");
        std::fs::create_dir_all(&tasks_dir).unwrap();
        std::fs::write(tasks_dir.join(file_name), content).unwrap();
    }

    #[test]
    fn task_round_trips_multiline_japanese_body() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let mut meta = sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z");
        meta.title = "ログイン画面を実装する".to_string();
        let body = "# 概要\n\nログイン画面を作る。\n\n- 項目1\n- 項目2\n";

        let created = store.create_task(meta.clone(), body).unwrap();
        assert_eq!(created.meta, meta);
        assert_eq!(created.body, body);

        let loaded = store.get_task(TASK_A).unwrap();
        assert_eq!(loaded, created);

        // The on-disk file uses the documented frontmatter layout.
        let raw = std::fs::read_to_string(task_path(dir.path(), TASK_A)).unwrap();
        assert!(raw.starts_with("---\n"));
        assert!(raw.contains("schemaVersion: 1\n"));
        assert!(raw.contains("\n---\n\n# 概要\n"));
    }

    #[test]
    fn task_empty_body_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_task(sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z"), "")
            .unwrap();
        assert_eq!(store.get_task(TASK_A).unwrap().body, "");
    }

    #[test]
    fn task_body_starting_with_frontmatter_delimiter_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let meta = sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z");
        let body = "---\nnot: metadata\n---\n\nStill body.\n";
        store.create_task(meta.clone(), body).unwrap();

        let loaded = store.get_task(TASK_A).unwrap();
        assert_eq!(loaded.meta, meta);
        assert_eq!(loaded.body, body);
    }

    #[test]
    fn create_task_twice_errors_and_keeps_original() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let meta = sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z");
        store.create_task(meta.clone(), "first").unwrap();

        let err = store.create_task(meta, "second").unwrap_err();
        assert_eq!(err, StoreError::AlreadyExists);
        assert_eq!(err.code(), "STORE_ALREADY_EXISTS");
        assert_eq!(store.get_task(TASK_A).unwrap().body, "first");
    }

    #[test]
    fn create_task_rejects_invalid_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let meta = sample_task_meta("../../evil", "2026-01-01T00:00:00.000Z");
        let err = store.create_task(meta, "body").unwrap_err();
        assert_eq!(err.code(), "STORE_INVALID_ID");
    }

    #[test]
    fn get_missing_task_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        assert_eq!(store.get_task(TASK_A).unwrap_err(), StoreError::NotFound);
    }

    #[test]
    fn put_task_overwrites_and_bumps_updated_at() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let created = store
            .create_task(sample_task_meta(TASK_A, "2000-01-01T00:00:00.000Z"), "old")
            .unwrap();

        let mut task = created.clone();
        task.meta.status = TaskStatus::Running;
        task.body = "new body\n".to_string();
        store.put_task(&task).unwrap();

        let loaded = store.get_task(TASK_A).unwrap();
        assert_eq!(loaded.meta.status, TaskStatus::Running);
        assert_eq!(loaded.body, "new body\n");
        assert_eq!(loaded.meta.created_at, "2000-01-01T00:00:00.000Z");
        assert_ne!(loaded.meta.updated_at, "2000-01-01T00:00:00.000Z");
        assert!(loaded.meta.updated_at.as_str() > "2000-01-01T00:00:00.000Z");
    }

    #[test]
    fn delete_task_removes_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_task(sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z"), "x")
            .unwrap();
        store.delete_task(TASK_A).unwrap();

        assert_eq!(store.get_task(TASK_A).unwrap_err(), StoreError::NotFound);
        assert_eq!(store.delete_task(TASK_A).unwrap_err(), StoreError::NotFound);
    }

    #[test]
    fn list_tasks_without_tasks_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let list = store.list_tasks().unwrap();
        assert!(list.tasks.is_empty());
        assert!(list.warnings.is_empty());
    }

    #[test]
    fn list_tasks_sorts_by_created_at_then_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_task(sample_task_meta(TASK_C, "2026-01-01T00:00:00.000Z"), "")
            .unwrap();
        store
            .create_task(sample_task_meta(TASK_B, "2026-01-02T00:00:00.000Z"), "")
            .unwrap();
        store
            .create_task(sample_task_meta(TASK_A, "2026-01-02T00:00:00.000Z"), "")
            .unwrap();

        let list = store.list_tasks().unwrap();
        let ids: Vec<&str> = list.tasks.iter().map(|t| t.meta.id.as_str()).collect();
        assert_eq!(ids, vec![TASK_C, TASK_A, TASK_B]);
        assert!(list.warnings.is_empty());
    }

    #[test]
    fn list_tasks_reports_corrupt_yaml_as_warning() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_task(sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z"), "ok")
            .unwrap();
        write_raw_task_file(
            dir.path(),
            &format!("{TASK_B}.md"),
            b"---\nschemaVersion: [unclosed\n---\n\nbody\n",
        );

        let list = store.list_tasks().unwrap();
        assert_eq!(list.tasks.len(), 1);
        assert_eq!(list.tasks[0].meta.id, TASK_A);
        assert_eq!(list.warnings.len(), 1);
        assert!(list.warnings[0].file.ends_with(&format!("{TASK_B}.md")));
        assert!(list.warnings[0].message.starts_with("STORE_CORRUPT"));

        assert_eq!(store.get_task(TASK_B).unwrap_err().code(), "STORE_CORRUPT");
    }

    #[test]
    fn list_tasks_reports_missing_closing_delimiter_as_warning() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_task(sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z"), "ok")
            .unwrap();
        write_raw_task_file(
            dir.path(),
            &format!("{TASK_B}.md"),
            format!("---\nschemaVersion: 1\nid: {TASK_B}\ntitle: t\n\nbody without closing\n")
                .as_bytes(),
        );

        let list = store.list_tasks().unwrap();
        assert_eq!(list.tasks.len(), 1);
        assert_eq!(list.warnings.len(), 1);
        assert!(list.warnings[0].file.ends_with(&format!("{TASK_B}.md")));
        assert_eq!(store.get_task(TASK_B).unwrap_err().code(), "STORE_CORRUPT");
    }

    #[test]
    fn list_tasks_ignores_non_markdown_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_task(sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z"), "ok")
            .unwrap();
        // Leftover temp file from an interrupted atomic write.
        write_raw_task_file(dir.path(), &format!(".{TASK_B}.md.0123abcd.tmp"), b"junk");

        let list = store.list_tasks().unwrap();
        assert_eq!(list.tasks.len(), 1);
        assert!(list.warnings.is_empty());
    }

    #[test]
    fn task_file_with_mismatched_id_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_task(sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z"), "ok")
            .unwrap();
        let src = task_path(dir.path(), TASK_A);
        let dst = task_path(dir.path(), TASK_B);
        std::fs::copy(src, dst).unwrap();

        assert_eq!(store.get_task(TASK_B).unwrap_err().code(), "STORE_CORRUPT");
        let list = store.list_tasks().unwrap();
        assert_eq!(list.tasks.len(), 1);
        assert_eq!(list.warnings.len(), 1);
    }

    #[test]
    fn task_file_with_unsupported_schema_version_errors() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_task(sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z"), "ok")
            .unwrap();
        let path = task_path(dir.path(), TASK_A);
        let raw = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, raw.replace("schemaVersion: 1", "schemaVersion: 2")).unwrap();

        assert_eq!(
            store.get_task(TASK_A).unwrap_err(),
            StoreError::UnsupportedSchema(2)
        );
        let list = store.list_tasks().unwrap();
        assert!(list.tasks.is_empty());
        assert_eq!(list.warnings.len(), 1);
    }

    #[test]
    fn task_file_written_with_crlf_parses() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let meta = sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z");
        store.create_task(meta.clone(), "").unwrap();

        // Simulate an editor rewriting the whole file with CRLF line endings.
        let path = task_path(dir.path(), TASK_A);
        let raw = std::fs::read_to_string(&path).unwrap();
        let crlf = format!("{raw}Line one\nLine two\n").replace('\n', "\r\n");
        std::fs::write(&path, crlf).unwrap();

        let loaded = store.get_task(TASK_A).unwrap();
        assert_eq!(loaded.meta, meta);
        assert_eq!(loaded.body, "Line one\r\nLine two\r\n");
        assert_eq!(store.list_tasks().unwrap().tasks.len(), 1);
    }

    #[test]
    fn save_workflows_rejects_unsupported_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let file = WorkflowsFile {
            schema_version: 2,
            workflows: vec![sample_workflow()],
        };
        assert_eq!(
            store.save_workflows(&file).unwrap_err(),
            StoreError::UnsupportedSchema(2)
        );
        assert!(!dir.path().join(".mdium").join("workflows.json").exists());
    }

    #[test]
    fn create_task_rejects_unsupported_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let mut meta = sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z");
        meta.schema_version = 2;
        assert_eq!(
            store.create_task(meta, "x").unwrap_err(),
            StoreError::UnsupportedSchema(2)
        );
        assert!(!task_path(dir.path(), TASK_A).exists());
    }

    #[test]
    fn put_task_rejects_unsupported_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let mut task = store
            .create_task(sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z"), "x")
            .unwrap();
        task.meta.schema_version = 2;
        assert_eq!(
            store.put_task(&task).unwrap_err(),
            StoreError::UnsupportedSchema(2)
        );
        assert_eq!(store.get_task(TASK_A).unwrap().meta.schema_version, 1);
    }

    #[test]
    fn put_task_after_delete_is_not_found_and_does_not_resurrect() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let task = store
            .create_task(sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z"), "x")
            .unwrap();
        store.delete_task(TASK_A).unwrap();

        assert_eq!(store.put_task(&task).unwrap_err(), StoreError::NotFound);
        assert!(!task_path(dir.path(), TASK_A).exists());
    }

    #[test]
    fn list_tasks_reports_invalid_file_name_as_warning() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_task(sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z"), "ok")
            .unwrap();
        // A well-formed document whose file name is not a valid id.
        let raw = std::fs::read(task_path(dir.path(), TASK_A)).unwrap();
        write_raw_task_file(dir.path(), "notes.md", &raw);

        let list = store.list_tasks().unwrap();
        assert_eq!(list.tasks.len(), 1);
        assert_eq!(list.tasks[0].meta.id, TASK_A);
        assert_eq!(list.warnings.len(), 1);
        assert!(list.warnings[0].file.ends_with("notes.md"));
        assert!(list.warnings[0].message.starts_with("STORE_INVALID_ID"));
    }

    #[test]
    fn task_file_with_utf8_bom_parses() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let meta = sample_task_meta(TASK_A, "2026-01-01T00:00:00.000Z");
        store.create_task(meta.clone(), "body\n").unwrap();

        let path = task_path(dir.path(), TASK_A);
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend(std::fs::read(&path).unwrap());
        std::fs::write(&path, bytes).unwrap();

        let loaded = store.get_task(TASK_A).unwrap();
        assert_eq!(loaded.meta, meta);
        assert_eq!(loaded.body, "body\n");
    }
}

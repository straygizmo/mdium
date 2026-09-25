//! Persistence layer for `.mdium/`.
//!
//! Covers `workflows.json` and task documents (YAML-frontmatter Markdown).
//! Task 4 extends this same file with workflow runs / attempt artifacts,
//! reusing [`StoreError`] and [`WorkflowStore`].

use crate::workflow::fsutil::{self, InvalidId, MdiumPaths};
use crate::workflow::model::{Task, TaskMeta, ValidationError, WorkflowRun, WorkflowsFile};
use serde::Deserialize;
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

/// Just the `schemaVersion` of an on-disk record. Readers decode this
/// first so a file from a newer schema (whose shape may differ entirely)
/// is reported as [`StoreError::UnsupportedSchema`] rather than as a
/// confusing `Corrupt` from the full struct's decoder.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaProbe {
    schema_version: u32,
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

    let probe: SchemaProbe =
        serde_yaml_ng::from_str(&yaml).map_err(|err| StoreError::Corrupt(err.to_string()))?;
    check_schema_version(probe.schema_version)?;
    let meta: TaskMeta =
        serde_yaml_ng::from_str(&yaml).map_err(|err| StoreError::Corrupt(err.to_string()))?;

    Ok(Task {
        meta,
        body: body.to_string(),
    })
}

/// Reads and parses one task file, requiring its frontmatter `id` to match
/// `expected_id` (the file name), so a copied or renamed file can never be
/// mistaken for a different task.
fn read_task_file(path: &Path, expected_id: &str) -> Result<Task, StoreError> {
    let text = read_text_file(path)?;
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
    project_root: PathBuf,
    paths: MdiumPaths,
}

impl WorkflowStore {
    pub fn new(project_root: PathBuf) -> Self {
        Self {
            paths: MdiumPaths::new(project_root.clone()),
            project_root,
        }
    }

    /// The project root this store reads and writes `.mdium/` under.
    pub fn project_root(&self) -> &Path {
        &self.project_root
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

        let bytes =
            serde_json::to_vec_pretty(file).map_err(|err| StoreError::Encode(err.to_string()))?;
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
    /// Returns the task exactly as stored, including the new `updated_at`.
    pub fn put_task(&self, task: &Task) -> Result<Task, StoreError> {
        let path = self.paths.task_file(&task.meta.id)?;
        check_schema_version(task.meta.schema_version)?;
        if !path.try_exists()? {
            return Err(StoreError::NotFound);
        }
        let mut task = task.clone();
        task.meta.updated_at = fsutil::now();
        fsutil::atomic_write(&path, encode_task(&task)?.as_bytes())?;
        Ok(task)
    }

    /// Loads every `<id>.md` file in `.mdium/tasks/`. Files that cannot be
    /// read or parsed are reported in [`TaskList::warnings`] instead of
    /// failing the whole listing. A missing tasks directory is an empty
    /// list.
    pub fn list_tasks(&self) -> Result<TaskList, StoreError> {
        let (mut tasks, warnings) = scan_records(&self.paths.tasks_dir(), ".md", |path, stem| {
            // The stem must be a valid task id; anything else is reported
            // rather than loaded, since it could never be addressed by id.
            self.paths.task_file(stem)?;
            read_task_file(path, stem)
        })?;
        tasks.sort_by(|a: &Task, b: &Task| {
            a.meta
                .created_at
                .cmp(&b.meta.created_at)
                .then_with(|| a.meta.id.cmp(&b.meta.id))
        });
        Ok(TaskList { tasks, warnings })
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

    /// Writes a new `.mdium/runs/<rootTaskId>.json`. Fails with
    /// [`StoreError::AlreadyExists`] if that file is already present, and
    /// rejects a `schemaVersion` this store cannot read back. Like
    /// [`Self::create_task`], the existence check and the write are not one
    /// atomic step; callers serialize run mutations per project.
    pub fn create_run(&self, run: &WorkflowRun) -> Result<(), StoreError> {
        let path = self.paths.run_file(&run.root_task_id)?;
        check_schema_version(run.schema_version)?;
        if path.try_exists()? {
            return Err(StoreError::AlreadyExists);
        }
        write_run_file(&path, run)
    }

    /// Loads the run whose root task is `root_id`.
    pub fn get_run(&self, root_id: &str) -> Result<WorkflowRun, StoreError> {
        let path = self.paths.run_file(root_id)?;
        read_run_file(&path, root_id)
    }

    /// Atomically overwrites an existing run, stamping `updated_at` with
    /// the current time. Fails with [`StoreError::NotFound`] if the run
    /// file does not exist (use [`Self::create_run`] for new runs), and
    /// rejects a `schemaVersion` this store cannot read back. Returns the
    /// run exactly as stored, including the new `updated_at`.
    pub fn put_run(&self, run: &WorkflowRun) -> Result<WorkflowRun, StoreError> {
        let path = self.paths.run_file(&run.root_task_id)?;
        check_schema_version(run.schema_version)?;
        if !path.try_exists()? {
            return Err(StoreError::NotFound);
        }
        let mut run = run.clone();
        run.updated_at = fsutil::now();
        write_run_file(&path, &run)?;
        Ok(run)
    }

    /// Loads every `<rootTaskId>.json` in `.mdium/runs/`, sorted by
    /// `created_at` then root task id. Files that cannot be read or parsed
    /// become warnings instead of failing the listing; the per-run attempt
    /// artifact directories are ignored. A missing runs directory is an
    /// empty list.
    pub fn list_runs(&self) -> Result<(Vec<WorkflowRun>, Vec<StoreWarning>), StoreError> {
        let (mut runs, warnings) = scan_records(&self.paths.runs_dir(), ".json", |path, stem| {
            self.paths.run_file(stem)?;
            read_run_file(path, stem)
        })?;
        runs.sort_by(|a: &WorkflowRun, b: &WorkflowRun| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.root_task_id.cmp(&b.root_task_id))
        });
        Ok((runs, warnings))
    }

    /// Atomically writes (or replaces) an attempt's output document.
    pub fn write_attempt_output(
        &self,
        root_id: &str,
        task_id: &str,
        attempt_id: &str,
        text: &str,
    ) -> Result<(), StoreError> {
        let path = self.paths.attempt_output(root_id, task_id, attempt_id)?;
        fsutil::atomic_write(&path, text.as_bytes())?;
        Ok(())
    }

    /// Reads an attempt's output document.
    pub fn read_attempt_output(
        &self,
        root_id: &str,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<String, StoreError> {
        let path = self.paths.attempt_output(root_id, task_id, attempt_id)?;
        read_text_file(&path)
    }

    /// Appends `line` plus a newline to an attempt's log, creating the file
    /// (and its directories) on first use. Unlike every other write in this
    /// store this is an in-place append, not an atomic replace, so a log
    /// can grow cheaply while an attempt is running. The line is written
    /// with a single `write_all` call so appends do not interleave
    /// mid-line.
    ///
    /// One call always produces exactly one log line: any `\r` or `\n`
    /// inside `line` is replaced by the two-character escape `\r` / `\n`
    /// (a literal backslash followed by `r` / `n`).
    pub fn append_attempt_log(
        &self,
        root_id: &str,
        task_id: &str,
        attempt_id: &str,
        line: &str,
    ) -> Result<(), StoreError> {
        use std::io::Write;

        let path = self.paths.attempt_log(root_id, task_id, attempt_id)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        let escaped = line.replace('\r', "\\r").replace('\n', "\\n");
        file.write_all(format!("{escaped}\n").as_bytes())?;
        Ok(())
    }

    /// Reads an attempt's whole log. The log is diagnostic data, so invalid
    /// UTF-8 (e.g. a multibyte character cut short by a crash mid-append)
    /// is decoded lossily with U+FFFD instead of failing the read.
    pub fn read_attempt_log(
        &self,
        root_id: &str,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<String, StoreError> {
        let path = self.paths.attempt_log(root_id, task_id, attempt_id)?;
        Ok(String::from_utf8_lossy(&read_file_bytes(&path)?).into_owned())
    }
}

/// Reads a whole file, mapping a missing file to [`StoreError::NotFound`].
fn read_file_bytes(path: &Path) -> Result<Vec<u8>, StoreError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(StoreError::NotFound),
        Err(err) => Err(StoreError::Io(err.to_string())),
    }
}

/// Reads a whole UTF-8 file, mapping a missing file to
/// [`StoreError::NotFound`] and invalid UTF-8 to [`StoreError::Corrupt`].
fn read_text_file(path: &Path) -> Result<String, StoreError> {
    String::from_utf8(read_file_bytes(path)?).map_err(|err| StoreError::Corrupt(err.to_string()))
}

/// Loads every visible regular file in `dir` whose name ends in `suffix`,
/// calling `load(path, stem)` for each. Hidden files (the temp/backup files
/// of in-flight or interrupted atomic writes), other extensions, and
/// subdirectories are skipped silently; every `load` failure becomes a
/// [`StoreWarning`]. A missing `dir` yields no records and no warnings.
fn scan_records<T>(
    dir: &Path,
    suffix: &str,
    load: impl Fn(&Path, &str) -> Result<T, StoreError>,
) -> Result<(Vec<T>, Vec<StoreWarning>), StoreError> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), Vec::new()));
        }
        Err(err) => return Err(StoreError::Io(err.to_string())),
    };

    let mut records = Vec::new();
    let mut warnings = Vec::new();
    for entry in entries {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(err) => {
                warnings.push(StoreWarning {
                    file: dir.display().to_string(),
                    message: StoreError::from(err).describe(),
                });
                continue;
            }
        };
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Some(stem) = file_name.strip_suffix(suffix) else {
            continue;
        };
        if file_name.starts_with('.') || !path.is_file() {
            continue;
        }

        match load(&path, stem) {
            Ok(record) => records.push(record),
            Err(err) => warnings.push(StoreWarning {
                file: path.display().to_string(),
                message: err.describe(),
            }),
        }
    }
    Ok((records, warnings))
}

/// Serializes `run` as pretty JSON and writes it atomically to `path`.
fn write_run_file(path: &Path, run: &WorkflowRun) -> Result<(), StoreError> {
    let bytes =
        serde_json::to_vec_pretty(run).map_err(|err| StoreError::Encode(err.to_string()))?;
    fsutil::atomic_write(path, &bytes)?;
    Ok(())
}

/// Reads and parses one run file, requiring its `rootTaskId` to match
/// `expected_root_id` (the file name), so a copied or renamed file can
/// never be mistaken for a different run.
fn read_run_file(path: &Path, expected_root_id: &str) -> Result<WorkflowRun, StoreError> {
    let text = read_text_file(path)?;
    let probe: SchemaProbe =
        serde_json::from_str(&text).map_err(|err| StoreError::Corrupt(err.to_string()))?;
    check_schema_version(probe.schema_version)?;
    let run: WorkflowRun =
        serde_json::from_str(&text).map_err(|err| StoreError::Corrupt(err.to_string()))?;
    if run.root_task_id != expected_root_id {
        return Err(StoreError::Corrupt(format!(
            "rootTaskId {:?} does not match file name {expected_root_id:?}",
            run.root_task_id
        )));
    }
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::integrity::IntegritySnapshot;
    use crate::workflow::model::{
        AttemptRecord, IssueTracking, PendingTransition, Provider, Role, RunStatus, Stage,
        TaskStatus, Workflow, WorktreeInfo,
    };

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
        let stored = store.put_task(&task).unwrap();

        let loaded = store.get_task(TASK_A).unwrap();
        assert_eq!(stored, loaded);
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

    // ---- Workflow runs and attempt artifacts ----

    const ATTEMPT_1: &str = "00000000000000a1";

    fn sample_run(root_id: &str, created_at: &str) -> WorkflowRun {
        WorkflowRun {
            schema_version: 1,
            root_task_id: root_id.to_string(),
            workflow: sample_workflow(),
            status: RunStatus::Active,
            current_task_id: TASK_B.to_string(),
            reentry_count: 2,
            worktree: Some(WorktreeInfo {
                path: "C:/data/mdium/worktrees/abc/root".to_string(),
                branch: "mdium/00000000-task".to_string(),
                base_branch: "main".to_string(),
                base_commit: "0123456789abcdef".to_string(),
            }),
            attempts: vec![AttemptRecord {
                attempt_id: ATTEMPT_1.to_string(),
                task_id: TASK_B.to_string(),
                stage_id: "design".to_string(),
                session_id: "session-1".to_string(),
                runner_pid: Some(4242),
                started_at: created_at.to_string(),
                finished_at: None,
                outcome: None,
            }],
            pending_transition: Some(PendingTransition {
                from_task_id: TASK_B.to_string(),
                to_stage_id: "implement".to_string(),
                child_task_id: TASK_C.to_string(),
            }),
            integrity_baseline: Some(IntegritySnapshot::default()),
            created_at: created_at.to_string(),
            updated_at: created_at.to_string(),
        }
    }

    fn run_path(dir: &std::path::Path, root_id: &str) -> PathBuf {
        dir.join(".mdium")
            .join("runs")
            .join(format!("{root_id}.json"))
    }

    #[test]
    fn run_round_trips_with_workflow_snapshot_and_pending_transition() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let run = sample_run(TASK_A, "2026-01-01T00:00:00.000Z");
        store.create_run(&run).unwrap();

        assert_eq!(store.get_run(TASK_A).unwrap(), run);
        let raw = std::fs::read_to_string(run_path(dir.path(), TASK_A)).unwrap();
        assert!(raw.contains("\"schemaVersion\": 1"));
        assert!(raw.contains("\"pendingTransition\""));
    }

    #[test]
    fn create_run_twice_errors_and_keeps_original() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let run = sample_run(TASK_A, "2026-01-01T00:00:00.000Z");
        store.create_run(&run).unwrap();

        let mut second = run.clone();
        second.reentry_count = 9;
        assert_eq!(
            store.create_run(&second).unwrap_err(),
            StoreError::AlreadyExists
        );
        assert_eq!(store.get_run(TASK_A).unwrap().reentry_count, 2);
    }

    #[test]
    fn create_run_rejects_invalid_root_id_and_unsupported_schema() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let bad_id = sample_run("../escape", "2026-01-01T00:00:00.000Z");
        assert_eq!(
            store.create_run(&bad_id).unwrap_err().code(),
            "STORE_INVALID_ID"
        );

        let mut bad_schema = sample_run(TASK_A, "2026-01-01T00:00:00.000Z");
        bad_schema.schema_version = 2;
        assert_eq!(
            store.create_run(&bad_schema).unwrap_err(),
            StoreError::UnsupportedSchema(2)
        );
        assert!(!run_path(dir.path(), TASK_A).exists());
    }

    #[test]
    fn get_missing_run_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        assert_eq!(store.get_run(TASK_A).unwrap_err(), StoreError::NotFound);
    }

    #[test]
    fn put_run_overwrites_and_bumps_updated_at() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let mut run = sample_run(TASK_A, "2000-01-01T00:00:00.000Z");
        store.create_run(&run).unwrap();

        run.status = RunStatus::AwaitingMerge;
        run.pending_transition = None;
        let stored = store.put_run(&run).unwrap();

        let loaded = store.get_run(TASK_A).unwrap();
        assert_eq!(stored, loaded);
        assert_eq!(loaded.status, RunStatus::AwaitingMerge);
        assert_eq!(loaded.pending_transition, None);
        assert_eq!(loaded.created_at, "2000-01-01T00:00:00.000Z");
        assert!(loaded.updated_at.as_str() > "2000-01-01T00:00:00.000Z");
    }

    #[test]
    fn put_run_missing_is_not_found_and_rejects_unsupported_schema() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let mut run = sample_run(TASK_A, "2026-01-01T00:00:00.000Z");
        assert_eq!(store.put_run(&run).unwrap_err(), StoreError::NotFound);
        assert!(!run_path(dir.path(), TASK_A).exists());

        store.create_run(&run).unwrap();
        run.schema_version = 2;
        assert_eq!(
            store.put_run(&run).unwrap_err(),
            StoreError::UnsupportedSchema(2)
        );
        assert_eq!(store.get_run(TASK_A).unwrap().schema_version, 1);
    }

    #[test]
    fn list_runs_without_runs_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let (runs, warnings) = store.list_runs().unwrap();
        assert!(runs.is_empty());
        assert!(warnings.is_empty());
    }

    #[test]
    fn list_runs_sorts_and_reports_bad_files_as_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_run(&sample_run(TASK_B, "2026-01-02T00:00:00.000Z"))
            .unwrap();
        store
            .create_run(&sample_run(TASK_A, "2026-01-03T00:00:00.000Z"))
            .unwrap();
        // Attempt artifacts live in a sibling directory and must be ignored.
        store
            .write_attempt_output(TASK_A, TASK_B, ATTEMPT_1, "output")
            .unwrap();

        let runs_dir = dir.path().join(".mdium").join("runs");
        std::fs::write(runs_dir.join(format!("{TASK_C}.json")), b"{ not json").unwrap();
        std::fs::write(runs_dir.join("notes.json"), b"{}").unwrap();
        std::fs::write(
            runs_dir.join(format!(".{TASK_C}.json.0123abcd.tmp")),
            b"junk",
        )
        .unwrap();

        let (runs, warnings) = store.list_runs().unwrap();
        let ids: Vec<&str> = runs.iter().map(|r| r.root_task_id.as_str()).collect();
        assert_eq!(ids, vec![TASK_B, TASK_A]);

        assert_eq!(warnings.len(), 2);
        let corrupt = warnings
            .iter()
            .find(|w| w.file.ends_with(&format!("{TASK_C}.json")))
            .unwrap();
        assert!(corrupt.message.starts_with("STORE_CORRUPT"));
        let invalid = warnings
            .iter()
            .find(|w| w.file.ends_with("notes.json"))
            .unwrap();
        assert!(invalid.message.starts_with("STORE_INVALID_ID"));
    }

    #[test]
    fn run_file_with_mismatched_root_id_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .create_run(&sample_run(TASK_A, "2026-01-01T00:00:00.000Z"))
            .unwrap();
        std::fs::copy(run_path(dir.path(), TASK_A), run_path(dir.path(), TASK_B)).unwrap();

        assert_eq!(store.get_run(TASK_B).unwrap_err().code(), "STORE_CORRUPT");
    }

    #[test]
    fn attempt_output_write_then_read() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let text = "---\noutcome: done\n---\n\n設計完了。\n";
        store
            .write_attempt_output(TASK_A, TASK_B, ATTEMPT_1, text)
            .unwrap();
        assert_eq!(
            store
                .read_attempt_output(TASK_A, TASK_B, ATTEMPT_1)
                .unwrap(),
            text
        );

        store
            .write_attempt_output(TASK_A, TASK_B, ATTEMPT_1, "replaced")
            .unwrap();
        assert_eq!(
            store
                .read_attempt_output(TASK_A, TASK_B, ATTEMPT_1)
                .unwrap(),
            "replaced"
        );
        assert!(dir
            .path()
            .join(".mdium")
            .join("runs")
            .join(TASK_A)
            .join(TASK_B)
            .join(format!("{ATTEMPT_1}.md"))
            .is_file());
    }

    #[test]
    fn attempt_artifacts_missing_are_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        assert_eq!(
            store
                .read_attempt_output(TASK_A, TASK_B, ATTEMPT_1)
                .unwrap_err(),
            StoreError::NotFound
        );
        assert_eq!(
            store
                .read_attempt_log(TASK_A, TASK_B, ATTEMPT_1)
                .unwrap_err(),
            StoreError::NotFound
        );
    }

    #[test]
    fn attempt_artifacts_reject_invalid_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        for (root, task, attempt) in [
            ("..", TASK_B, ATTEMPT_1),
            (TASK_A, "../x", ATTEMPT_1),
            (TASK_A, TASK_B, "a/b"),
        ] {
            assert_eq!(
                store
                    .write_attempt_output(root, task, attempt, "x")
                    .unwrap_err()
                    .code(),
                "STORE_INVALID_ID"
            );
            assert_eq!(
                store
                    .append_attempt_log(root, task, attempt, "x")
                    .unwrap_err()
                    .code(),
                "STORE_INVALID_ID"
            );
        }
        assert!(!dir.path().join(".mdium").exists());
    }

    #[test]
    fn attempt_log_append_keeps_order_across_100_appends() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        for i in 0..100 {
            store
                .append_attempt_log(TASK_A, TASK_B, ATTEMPT_1, &format!("line {i}"))
                .unwrap();
        }

        let log = store.read_attempt_log(TASK_A, TASK_B, ATTEMPT_1).unwrap();
        let expected: String = (0..100).map(|i| format!("line {i}\n")).collect();
        assert_eq!(log, expected);
    }

    #[test]
    fn attempt_log_append_escapes_embedded_line_breaks() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .append_attempt_log(TASK_A, TASK_B, ATTEMPT_1, "a\nb\r\nc")
            .unwrap();
        store
            .append_attempt_log(TASK_A, TASK_B, ATTEMPT_1, "next")
            .unwrap();

        let log = store.read_attempt_log(TASK_A, TASK_B, ATTEMPT_1).unwrap();
        assert_eq!(log, "a\\nb\\r\\nc\nnext\n");
        assert_eq!(log.lines().count(), 2);
    }

    #[test]
    fn attempt_log_with_invalid_utf8_is_read_lossily() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        store
            .append_attempt_log(TASK_A, TASK_B, ATTEMPT_1, "ok")
            .unwrap();
        // Simulate a crash mid-write: a multibyte character cut after its
        // first two bytes ("あ" is E3 81 82).
        let log_path = dir
            .path()
            .join(".mdium")
            .join("runs")
            .join(TASK_A)
            .join(TASK_B)
            .join(format!("{ATTEMPT_1}.log"));
        let mut bytes = std::fs::read(&log_path).unwrap();
        bytes.extend_from_slice(&[0xE3, 0x81]);
        std::fs::write(&log_path, bytes).unwrap();

        let log = store.read_attempt_log(TASK_A, TASK_B, ATTEMPT_1).unwrap();
        assert!(log.starts_with("ok\n"));
        assert!(log.ends_with('\u{fffd}'));
    }

    #[test]
    fn task_file_with_future_schema_and_different_shape_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        write_raw_task_file(
            dir.path(),
            &format!("{TASK_A}.md"),
            b"---\nschemaVersion: 2\nidentity:\n  key: 1\n---\n\nbody\n",
        );

        assert_eq!(
            store.get_task(TASK_A).unwrap_err(),
            StoreError::UnsupportedSchema(2)
        );
        let list = store.list_tasks().unwrap();
        assert!(list.tasks.is_empty());
        assert_eq!(list.warnings.len(), 1);
        assert!(list.warnings[0]
            .message
            .starts_with("STORE_UNSUPPORTED_SCHEMA"));
    }

    #[test]
    fn run_file_with_future_schema_and_different_shape_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());

        let runs_dir = dir.path().join(".mdium").join("runs");
        std::fs::create_dir_all(&runs_dir).unwrap();
        std::fs::write(
            runs_dir.join(format!("{TASK_A}.json")),
            br#"{ "schemaVersion": 2, "root": { "id": 1 } }"#,
        )
        .unwrap();

        assert_eq!(
            store.get_run(TASK_A).unwrap_err(),
            StoreError::UnsupportedSchema(2)
        );
        let (runs, warnings) = store.list_runs().unwrap();
        assert!(runs.is_empty());
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].message.starts_with("STORE_UNSUPPORTED_SCHEMA"));
    }
}

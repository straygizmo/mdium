//! The service facade of the flow engine: every operation the desktop app
//! exposes as a Tauri command and the flow server exposes over HTTP, as
//! plain methods on one object (spec 2026-10-10, 10.1 "FlowService").

use crate::issues::FLOW_FILE_TOO_LARGE;
use crate::load::{self, flow_kind_of, FlowKind, FlowReport, FlowSummary, PathProblem};
use crate::parse::FlowFormat;
use crate::project::{load_project_bytes, ProjectReport, PROJECT_FILE};
use crate::run::worker::{
    describe_runtime, worker_spec, Manifest, PipedWorkerLauncher, FLOW_RUNTIME_START_FAILED,
};
use crate::run::engine::{
    sha256_hex, ArtifactLocation, CommandReview, EngineError, FlowEngine, RunSnapshot, RunSummary,
    FLOW_FILE_CHANGED,
};
use crate::run::model::Reason;
use crate::setup::{run_setup, SetupProgress, SetupResult};
use crate::templates::{self, TemplateInfo};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The project has no manifest, or its manifest has errors.
pub const FLOW_PROJECT_REQUIRED: &str = "FLOW_PROJECT_REQUIRED";
/// A setup is already running for this project.
pub const FLOW_SETUP_BUSY: &str = "FLOW_SETUP_BUSY";
/// Setup could not be started (reserved for the frontend's error table).
pub const FLOW_SETUP_FAILED: &str = "FLOW_SETUP_FAILED";
/// The project root is empty, not absolute, or not an existing directory.
pub const FLOW_PROJECT_INVALID: &str = "FLOW_PROJECT_INVALID";
/// The flow path is not a `*.flow.{yaml,yml,json}` file inside the project
/// (or goes through a link).
pub const FLOW_FILE_PATH_INVALID: &str = "FLOW_FILE_PATH_INVALID";
/// The flow file does not exist.
pub const FLOW_FILE_NOT_FOUND: &str = "FLOW_FILE_NOT_FOUND";
/// Listing the flows directory failed.
pub const FLOW_LIST_FAILED: &str = "FLOW_LIST_FAILED";
/// The blocking task could not be joined (used by the Tauri wrappers).
pub const FLOW_COMMAND_FAILED: &str = "FLOW_COMMAND_FAILED";
/// `save` without an expected hash found a file already there.
pub const FLOW_FILE_EXISTS: &str = "FLOW_FILE_EXISTS";
/// The command is not one of [`COMMAND_NAMES`].
pub const FLOW_UNKNOWN_COMMAND: &str = "FLOW_UNKNOWN_COMMAND";
/// The JSON arguments do not match the command's parameters.
pub const FLOW_BAD_ARGS: &str = "FLOW_BAD_ARGS";
/// The result could not be serialized to JSON.
pub const FLOW_SERIALIZE_FAILED: &str = "FLOW_SERIALIZE_FAILED";

/// A command failure as the UI receives it: `{ code, message, details? }`.
/// `message` is a log detail; the UI localizes by `code`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FlowCommandError {
    pub code: String,
    pub message: String,
    /// Machine-readable details (validation problems, nodes needing action, ...).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<Reason>,
}

impl FlowCommandError {
    pub fn new(code: &str, detail: impl std::fmt::Display) -> Self {
        Self {
            code: code.to_string(),
            message: format!("{code}: {detail}"),
            details: Vec::new(),
        }
    }
}

impl From<EngineError> for FlowCommandError {
    fn from(err: EngineError) -> Self {
        Self {
            message: format!("{}: {}", err.code, err.message),
            code: err.code,
            details: err.details,
        }
    }
}

/// A checked flow file as returned to the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowLoadResult {
    /// Project-relative path with `/` separators.
    pub path: String,
    pub format: FlowFormat,
    pub kind: FlowKind,
    /// The text that was checked (the file for `load`, the given text otherwise).
    /// Empty when the file could not be read (the report then carries the error).
    pub content: String,
    /// Hex sha256 of `content`; `save` requires it to overwrite.
    pub sha256: String,
    #[serde(flatten)]
    pub report: FlowReport,
}

/// Checks a project root argument: absolute path of an existing directory.
pub fn project_root(project_root: &str) -> Result<PathBuf, FlowCommandError> {
    let root = PathBuf::from(project_root);
    if project_root.trim().is_empty() || !root.is_absolute() || !root.is_dir() {
        return Err(FlowCommandError::new(FLOW_PROJECT_INVALID, project_root));
    }
    Ok(root)
}

fn flow_file(root: &Path, path: &str, must_exist: bool) -> Result<PathBuf, FlowCommandError> {
    load::resolve_flow_path(root, path, must_exist).map_err(|problem| match problem {
        PathProblem::NotFound => FlowCommandError::new(FLOW_FILE_NOT_FOUND, path),
        PathProblem::Outside(reason) => {
            FlowCommandError::new(FLOW_FILE_PATH_INVALID, format!("{path} ({reason})"))
        }
    })
}

fn format_of(file: &Path) -> FlowFormat {
    file.file_name()
        .and_then(|n| n.to_str())
        .and_then(FlowFormat::from_file_name)
        .unwrap_or(FlowFormat::Yaml)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreStatus {
    /// `.mdium/flow-runs/` is ignored by git (or the folder is not a git repository).
    pub ignored: bool,
}

/// Whether git ignores both `.mdium/flow-runs/` and `.mdium/setup-runs/` in
/// `root` (the UI suggests adding them otherwise; nothing is written automatically).
fn flow_runs_ignored(root: &Path) -> bool {
    [".mdium/flow-runs/probe", ".mdium/setup-runs/probe"]
        .iter()
        .all(|probe| path_ignored(root, probe))
}

/// `git check-ignore` of one probe path; `true` without git.
fn path_ignored(root: &Path, probe: &str) -> bool {
    let mut command = std::process::Command::new("git");
    command
        .args(["check-ignore", "-q", probe])
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match command.status() {
        Ok(status) => status.code() != Some(1),
        // No git: nothing to suggest.
        Err(_) => true,
    }
}

/// Removes a project root from the running-setup set when dropped.
struct SetupGuard<'a> {
    setups: &'a Mutex<HashSet<PathBuf>>,
    root: PathBuf,
}

impl Drop for SetupGuard<'_> {
    fn drop(&mut self) {
        self.setups
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.root);
    }
}

/// Every operation of the flow engine as plain methods. One per process;
/// transports (Tauri commands, HTTP handlers) are thin wrappers over it.
pub struct FlowService {
    engine: Arc<FlowEngine>,
    /// Project roots whose setup is running (one at a time per project).
    pub(crate) setups: Mutex<HashSet<PathBuf>>,
}

/// How long `flow_runtime_describe` waits for a worker to report its manifest.
pub const DESCRIBE_TIMEOUT: Duration = Duration::from_secs(30);

/// `flow_project_load` result: the manifest, or `exists: false`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLoadResult {
    pub exists: bool,
    pub path: String,
    /// Hex sha256 of the manifest bytes the report was built from, when it exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(flatten)]
    pub report: ProjectReport,
}

impl FlowService {
    pub fn new(engine: Arc<FlowEngine>) -> Self {
        Self {
            engine,
            setups: Mutex::new(HashSet::new()),
        }
    }

    /// Starts the runtime's worker only to read its manifest (spec 3.4).
    /// This runs project code, so — like setup — `sha256` must be the hash
    /// of the manifest content the user was shown (`project_load`).
    pub fn runtime_describe(
        &self,
        project_root_arg: &str,
        runtime: &str,
        sha256: &str,
    ) -> Result<Manifest, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let (bytes, report) = load_project_bytes(&root).ok_or_else(|| {
            FlowCommandError::new(FLOW_PROJECT_REQUIRED, "no .mdium/project.yaml")
        })?;
        if !report.errors.is_empty() {
            // The same per-issue details as a run start.
            let mut err = FlowCommandError::new(
                FLOW_PROJECT_INVALID,
                ".mdium/project.yaml has validation errors",
            );
            err.details = report
                .errors
                .iter()
                .map(|i| {
                    Reason {
                        code: i.code.clone(),
                        params: i.params.clone(),
                    }
                    .with("path", i.path.clone())
                })
                .collect();
            return Err(err);
        }
        if sha256_hex(&bytes) != sha256 {
            return Err(FlowCommandError::new(
                FLOW_FILE_CHANGED,
                "project.yaml changed since it was reviewed",
            ));
        }
        let project = report.project.ok_or_else(|| {
            FlowCommandError::new(FLOW_PROJECT_REQUIRED, "no valid .mdium/project.yaml")
        })?;
        let def = project
            .runtimes
            .get(runtime)
            .ok_or_else(|| FlowCommandError::new(crate::issues::FLOW_RUNTIME_UNKNOWN, runtime))?;
        let scratch = root
            .join(".mdium/flow-runs/.describe")
            .join(crate::fsutil::new_id());
        let start_failed = |r: Reason| {
            let detail = r
                .params
                .get("message")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| r.code.clone());
            FlowCommandError::new(FLOW_RUNTIME_START_FAILED, detail)
        };
        let result = worker_spec(&root, runtime, def, &scratch, &[])
            .map_err(start_failed)
            .and_then(|spec| {
                describe_runtime(&PipedWorkerLauncher, &spec, DESCRIBE_TIMEOUT)
                    .map_err(start_failed)
            });
        let _ = std::fs::remove_dir_all(&scratch);
        result
    }

    /// Runs the manifest's `setup` steps (spec 2.2); progress goes to `progress`.
    /// `sha256` is the hash of the manifest content the user reviewed.
    pub fn project_setup(
        &self,
        project_root_arg: &str,
        sha256: &str,
        progress: &(dyn Fn(&SetupProgress) + Sync),
    ) -> Result<SetupResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let (bytes, report) = load_project_bytes(&root).ok_or_else(|| {
            FlowCommandError::new(FLOW_PROJECT_REQUIRED, "no valid .mdium/project.yaml")
        })?;
        let project = match report {
            report if report.errors.is_empty() => report.project,
            _ => None,
        }
        .ok_or_else(|| {
            FlowCommandError::new(FLOW_PROJECT_REQUIRED, "no valid .mdium/project.yaml")
        })?;
        if sha256_hex(&bytes) != sha256 {
            return Err(FlowCommandError::new(
                FLOW_FILE_CHANGED,
                "project.yaml changed since it was reviewed",
            ));
        }
        {
            let mut running = self.setups.lock().unwrap_or_else(|p| p.into_inner());
            if !running.insert(root.clone()) {
                return Err(FlowCommandError::new(FLOW_SETUP_BUSY, project_root_arg));
            }
        }
        // Released on every exit path, including a panic in `run_setup` or `progress`.
        let _guard = SetupGuard {
            setups: &self.setups,
            root: root.clone(),
        };
        let result = run_setup(
            &root,
            &project,
            &crate::run::process::AttachedLauncher,
            Duration::from_millis(200),
            progress,
            None,
        );
        Ok(result)
    }

    pub fn engine(&self) -> &Arc<FlowEngine> {
        &self.engine
    }

    /// Lists `<projectRoot>/.mdium/flows/*.flow.{yaml,yml,json}` with a
    /// validation summary of each.
    pub fn list_flows(&self, project_root_arg: &str) -> Result<Vec<FlowSummary>, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        load::list_flows(&root).map_err(|err| FlowCommandError::new(FLOW_LIST_FAILED, err))
    }

    /// Reads and validates one flow file (`path` is project-relative).
    pub fn load_flow(
        &self,
        project_root_arg: &str,
        path: &str,
    ) -> Result<FlowLoadResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let file = flow_file(&root, path, true)?;
        let path = load::relative_display(&root, &file);
        // Read once: the checked text is the text the UI edits and hashes.
        let (content, report) = load::read_and_check(&root, &file);
        Ok(FlowLoadResult {
            kind: flow_kind_of(&path),
            path,
            format: format_of(&file),
            sha256: sha256_hex(content.as_bytes()),
            content,
            report,
        })
    }

    /// Writes `content` to a flow file (the editor's save). `None` creates
    /// (the file must not exist); `Some(hash)` overwrites only when the file
    /// still has that content hash. Invalid content is saved too; the
    /// returned report carries its errors.
    pub fn save_flow(
        &self,
        project_root_arg: &str,
        path: &str,
        content: &str,
        expected_sha256: Option<&str>,
    ) -> Result<FlowLoadResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let file = flow_file(&root, path, false)?;
        // Saves are confined to the flows folder (load/validate are not).
        if !load::relative_display(&root, &file).starts_with(".mdium/flows/") {
            return Err(FlowCommandError::new(
                FLOW_FILE_PATH_INVALID,
                format!("{path} (outside .mdium/flows)"),
            ));
        }
        if content.len() as u64 > load::MAX_FLOW_FILE_BYTES {
            return Err(FlowCommandError::new(FLOW_FILE_TOO_LARGE, path));
        }
        match (expected_sha256, std::fs::read(&file)) {
            (None, Ok(_)) => return Err(FlowCommandError::new(FLOW_FILE_EXISTS, path)),
            (None, Err(_)) => {}
            (Some(_), Err(_)) => return Err(FlowCommandError::new(FLOW_FILE_NOT_FOUND, path)),
            (Some(expected), Ok(bytes)) if sha256_hex(&bytes) != expected => {
                return Err(FlowCommandError::new(
                    FLOW_FILE_CHANGED,
                    "the flow file changed since it was loaded",
                ));
            }
            (Some(_), Ok(_)) => {}
        }
        // `atomic_write` creates missing parent directories.
        crate::fsutil::atomic_write(&file, content.as_bytes())
            .map_err(|e| FlowCommandError::new(FLOW_COMMAND_FAILED, e))?;
        self.load_flow(project_root_arg, path)
    }

    /// Validates unsaved `content` as if it were the file at `path`.
    pub fn validate_flow(
        &self,
        project_root_arg: &str,
        path: &str,
        content: &str,
    ) -> Result<FlowLoadResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let file = flow_file(&root, path, false)?;
        let path = load::relative_display(&root, &file);
        Ok(FlowLoadResult {
            kind: flow_kind_of(&path),
            path,
            format: format_of(&file),
            sha256: sha256_hex(content.as_bytes()),
            content: content.to_string(),
            report: load::check_content(&root, &file, content),
        })
    }

    /// Reads and validates `.mdium/project.yaml` (spec 2.4).
    pub fn project_load(
        &self,
        project_root_arg: &str,
    ) -> Result<ProjectLoadResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let (exists, sha256, report) = match load_project_bytes(&root) {
            Some((bytes, report)) => (true, Some(sha256_hex(&bytes)), report),
            None => (
                false,
                None,
                ProjectReport {
                    project: None,
                    errors: vec![],
                    warnings: vec![],
                },
            ),
        };
        Ok(ProjectLoadResult {
            exists,
            path: PROJECT_FILE.to_string(),
            sha256,
            report,
        })
    }

    /// The commands a flow file runs, for the one-time confirmation (spec 7.2).
    pub fn command_review(
        &self,
        project_root_arg: &str,
        path: &str,
    ) -> Result<CommandReview, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.review_commands(&root, path)?)
    }

    /// Records the user's confirmation of the reviewed content (by hash).
    pub fn confirm_commands(
        &self,
        project_root_arg: &str,
        path: &str,
        sha256: &str,
    ) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.confirm_commands(&root, path, sha256)?)
    }

    pub fn run_start(
        &self,
        project_root_arg: &str,
        path: &str,
        params: &BTreeMap<String, Value>,
        sha256: &str,
    ) -> Result<RunSummary, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.start(&root, path, params, sha256)?)
    }

    pub fn run_list(&self, project_root_arg: &str) -> Result<Vec<RunSummary>, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.list(&root)?)
    }

    pub fn run_get(
        &self,
        project_root_arg: &str,
        run_id: &str,
    ) -> Result<RunSnapshot, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.get(&root, run_id)?)
    }

    pub fn run_stop(&self, project_root_arg: &str, run_id: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.stop(&root, run_id)?)
    }

    pub fn run_resume(&self, project_root_arg: &str, run_id: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.resume(&root, run_id)?)
    }

    pub fn run_cancel(&self, project_root_arg: &str, run_id: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.cancel(&root, run_id)?)
    }

    /// Answers an approval; `node_key` `None` answers the budget approval.
    pub fn run_approve(
        &self,
        project_root_arg: &str,
        run_id: &str,
        node_key: Option<&str>,
        choice: &str,
        comment: Option<String>,
    ) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self
            .engine
            .approve(&root, run_id, node_key, choice, comment)?)
    }

    pub fn run_rerun_node(
        &self,
        project_root_arg: &str,
        run_id: &str,
        node_key: &str,
    ) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.rerun_node(&root, run_id, node_key)?)
    }

    pub fn run_mark_succeeded(
        &self,
        project_root_arg: &str,
        run_id: &str,
        node_key: &str,
    ) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.mark_succeeded(&root, run_id, node_key)?)
    }

    pub fn run_delete(&self, project_root_arg: &str, run_id: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.delete(&root, run_id)?)
    }

    /// Tail of a node attempt's `stdout` / `stderr` log (at most 256 KiB).
    pub fn run_log(
        &self,
        project_root_arg: &str,
        run_id: &str,
        node_key: &str,
        attempt: u32,
        stream: &str,
        max_bytes: u64,
    ) -> Result<String, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self
            .engine
            .log(&root, run_id, node_key, attempt, stream, max_bytes)?)
    }

    /// The absolute path of a recorded artifact (only what `artifacts.json` lists).
    pub fn run_artifact_path(
        &self,
        project_root_arg: &str,
        run_id: &str,
        node_key: &str,
        attempt: u32,
        index: u32,
    ) -> Result<ArtifactLocation, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self
            .engine
            .artifact_path(&root, run_id, node_key, attempt, index)?)
    }

    pub fn gitignore_status(
        &self,
        project_root_arg: &str,
    ) -> Result<GitignoreStatus, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(GitignoreStatus {
            ignored: flow_runs_ignored(&root),
        })
    }

    /// The built-in flow templates (`mdium:<name>`). `projectRoot` is
    /// validated like every command's, though the list does not depend on it.
    pub fn template_list(
        &self,
        project_root_arg: &str,
    ) -> Result<Vec<TemplateInfo>, FlowCommandError> {
        project_root(project_root_arg)?;
        Ok(templates::list())
    }

    /// Sets the language of the built-in templates (the UI language): copies
    /// and `mdium:` references use the template's translation when it has one.
    pub fn template_language(&self, language: &str) -> Result<(), FlowCommandError> {
        templates::set_language(language);
        Ok(())
    }

    /// Copies a template's flow files into the project's flows folder as
    /// `<fileName>.flow.yaml` (and its parts); returns the written paths.
    pub fn template_copy(
        &self,
        project_root_arg: &str,
        template: &str,
        file_name: &str,
    ) -> Result<Vec<String>, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        templates::copy_into(&root, template, file_name).map_err(|issue| {
            let mut err = FlowCommandError::new(&issue.code, format!("{template} -> {file_name}"));
            err.details = vec![Reason {
                code: issue.code,
                params: issue.params,
            }];
            err
        })
    }

    /// Waits for active drivers to record `interrupted` (app exit).
    pub fn shutdown(&self, wait: Duration) {
        self.engine.shutdown(wait);
    }
}

/// Every command the service dispatches by name (the Tauri command names;
/// the HTTP server uses the same names, spec 2026-10-10, 10.2).
pub const COMMAND_NAMES: [&str; 25] = [
    "flow_list",
    "flow_load",
    "flow_validate",
    "flow_save",
    "flow_project_load",
    "flow_project_setup",
    "flow_runtime_describe",
    "flow_command_review",
    "flow_confirm_commands",
    "flow_run_start",
    "flow_run_list",
    "flow_run_get",
    "flow_run_stop",
    "flow_run_resume",
    "flow_run_cancel",
    "flow_run_approve",
    "flow_run_rerun_node",
    "flow_run_mark_succeeded",
    "flow_run_delete",
    "flow_run_log",
    "flow_artifact_path",
    "flow_gitignore_status",
    "flow_template_list",
    "flow_template_copy",
    "flow_template_language",
];

// `call` is deliberately stricter than Tauri's `invoke`: unknown keys are rejected with
// `FLOW_BAD_ARGS` because this is the data-carrying HTTP surface.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootArgs {
    project_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DescribeArgs {
    project_root: String,
    runtime: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathArgs {
    project_root: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidateArgs {
    project_root: String,
    path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveArgs {
    project_root: String,
    path: String,
    content: String,
    expected_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectSetupArgs {
    project_root: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfirmArgs {
    project_root: String,
    path: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartArgs {
    project_root: String,
    path: String,
    params: BTreeMap<String, Value>,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunArgs {
    project_root: String,
    run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApproveArgs {
    project_root: String,
    run_id: String,
    #[serde(default)]
    node_key: Option<String>,
    choice: String,
    #[serde(default)]
    comment: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeArgs {
    project_root: String,
    run_id: String,
    node_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogArgs {
    project_root: String,
    run_id: String,
    node_key: String,
    attempt: u32,
    stream: String,
    max_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactArgs {
    project_root: String,
    run_id: String,
    node_key: String,
    attempt: u32,
    index: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TemplateCopyArgs {
    project_root: String,
    template: String,
    file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TemplateLanguageArgs {
    language: String,
}

fn args<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, FlowCommandError> {
    serde_json::from_value(value).map_err(|err| FlowCommandError::new(FLOW_BAD_ARGS, err))
}

fn reply<T: Serialize>(value: T) -> Result<Value, FlowCommandError> {
    serde_json::to_value(value).map_err(|err| FlowCommandError::new(FLOW_SERIALIZE_FAILED, err))
}

impl FlowService {
    /// Dispatches a command by its Tauri name with its JSON argument object
    /// (camelCase keys, exactly what the frontend sends to `invoke`). Used
    /// by transports that carry commands as data (the HTTP server).
    pub fn call(&self, name: &str, value: Value) -> Result<Value, FlowCommandError> {
        match name {
            "flow_list" => {
                let a: RootArgs = args(value)?;
                reply(self.list_flows(&a.project_root)?)
            }
            "flow_load" => {
                let a: PathArgs = args(value)?;
                reply(self.load_flow(&a.project_root, &a.path)?)
            }
            "flow_validate" => {
                let a: ValidateArgs = args(value)?;
                reply(self.validate_flow(&a.project_root, &a.path, &a.content)?)
            }
            "flow_save" => {
                let a: SaveArgs = args(value)?;
                reply(self.save_flow(
                    &a.project_root,
                    &a.path,
                    &a.content,
                    a.expected_sha256.as_deref(),
                )?)
            }
            "flow_project_load" => {
                let a: RootArgs = args(value)?;
                reply(self.project_load(&a.project_root)?)
            }
            "flow_project_setup" => {
                let a: ProjectSetupArgs = args(value)?;
                reply(self.project_setup(&a.project_root, &a.sha256, &|_| {})?)
            }
            "flow_runtime_describe" => {
                let a: DescribeArgs = args(value)?;
                reply(self.runtime_describe(&a.project_root, &a.runtime, &a.sha256)?)
            }
            "flow_command_review" => {
                let a: PathArgs = args(value)?;
                reply(self.command_review(&a.project_root, &a.path)?)
            }
            "flow_confirm_commands" => {
                let a: ConfirmArgs = args(value)?;
                reply(self.confirm_commands(&a.project_root, &a.path, &a.sha256)?)
            }
            "flow_run_start" => {
                let a: StartArgs = args(value)?;
                reply(self.run_start(&a.project_root, &a.path, &a.params, &a.sha256)?)
            }
            "flow_run_list" => {
                let a: RootArgs = args(value)?;
                reply(self.run_list(&a.project_root)?)
            }
            "flow_run_get" => {
                let a: RunArgs = args(value)?;
                reply(self.run_get(&a.project_root, &a.run_id)?)
            }
            "flow_run_stop" => {
                let a: RunArgs = args(value)?;
                reply(self.run_stop(&a.project_root, &a.run_id)?)
            }
            "flow_run_resume" => {
                let a: RunArgs = args(value)?;
                reply(self.run_resume(&a.project_root, &a.run_id)?)
            }
            "flow_run_cancel" => {
                let a: RunArgs = args(value)?;
                reply(self.run_cancel(&a.project_root, &a.run_id)?)
            }
            "flow_run_approve" => {
                let a: ApproveArgs = args(value)?;
                reply(self.run_approve(
                    &a.project_root,
                    &a.run_id,
                    a.node_key.as_deref(),
                    &a.choice,
                    a.comment,
                )?)
            }
            "flow_run_rerun_node" => {
                let a: NodeArgs = args(value)?;
                reply(self.run_rerun_node(&a.project_root, &a.run_id, &a.node_key)?)
            }
            "flow_run_mark_succeeded" => {
                let a: NodeArgs = args(value)?;
                reply(self.run_mark_succeeded(&a.project_root, &a.run_id, &a.node_key)?)
            }
            "flow_run_delete" => {
                let a: RunArgs = args(value)?;
                reply(self.run_delete(&a.project_root, &a.run_id)?)
            }
            "flow_run_log" => {
                let a: LogArgs = args(value)?;
                reply(self.run_log(
                    &a.project_root,
                    &a.run_id,
                    &a.node_key,
                    a.attempt,
                    &a.stream,
                    a.max_bytes,
                )?)
            }
            "flow_artifact_path" => {
                let a: ArtifactArgs = args(value)?;
                reply(self.run_artifact_path(
                    &a.project_root,
                    &a.run_id,
                    &a.node_key,
                    a.attempt,
                    a.index,
                )?)
            }
            "flow_gitignore_status" => {
                let a: RootArgs = args(value)?;
                reply(self.gitignore_status(&a.project_root)?)
            }
            "flow_template_list" => {
                let a: RootArgs = args(value)?;
                reply(self.template_list(&a.project_root)?)
            }
            "flow_template_copy" => {
                let a: TemplateCopyArgs = args(value)?;
                reply(self.template_copy(&a.project_root, &a.template, &a.file_name)?)
            }
            "flow_template_language" => {
                let a: TemplateLanguageArgs = args(value)?;
                reply(self.template_language(&a.language)?)
            }
            other => Err(FlowCommandError::new(FLOW_UNKNOWN_COMMAND, other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::driver::{ApprovalNotifier, DriverEnv, EventSink};
    use crate::run::engine::{FlowEngine, FLOW_RUN_INVALID_ID};
    use crate::run::model::{ApprovalRequest, NodeState, Progress, RunState};
    use crate::run::process::AttachedLauncher;
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    /// A sink that drops every event (service tests never run a flow).
    struct NoopSink;
    impl EventSink for NoopSink {
        fn run_changed(&self, _: &Path, _: &str, _: &RunState) {}
        fn node_changed(&self, _: &Path, _: &str, _: &str, _: &NodeState, _: u64) {}
        fn progress(&self, _: &Path, _: &str, _: &str, _: &Progress) {}
    }
    struct NoopNotifier;
    impl ApprovalNotifier for NoopNotifier {
        fn approval_requested(&self, _: &Path, _: &str, _: &ApprovalRequest) {}
    }

    #[test]
    fn load_and_validate_return_the_text_and_its_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        let text = "schemaVersion: 1\nid: a\nname: A\nnodes: []\n";
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), text).unwrap();
        let loaded = svc.load_flow(root, ".mdium/flows/a.flow.yaml").unwrap();
        assert_eq!(loaded.content, text);
        assert_eq!(loaded.sha256, sha256_hex(text.as_bytes()));
        let edited = "schemaVersion: 1\nid: a\nname: B\nnodes: []\n";
        let validated = svc.validate_flow(root, ".mdium/flows/a.flow.yaml", edited).unwrap();
        assert_eq!(validated.content, edited);
        assert_eq!(validated.sha256, sha256_hex(edited.as_bytes()));
        assert_eq!(validated.report.flow.unwrap().name, "B");
    }

    #[test]
    fn save_creates_overwrites_and_refuses_stale_or_outside_files() {
        use serde_json::json;
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        let v1 = "schemaVersion: 1\nid: s\nname: S\nnodes: []\n";
        // Create: the file must not exist yet.
        let created = svc.save_flow(root, ".mdium/flows/lib/s.flow.yaml", v1, None).unwrap();
        assert_eq!(created.kind, FlowKind::Part);
        assert_eq!(fs::read_to_string(tmp.path().join(".mdium/flows/lib/s.flow.yaml")).unwrap(), v1);
        assert_eq!(svc.save_flow(root, ".mdium/flows/lib/s.flow.yaml", v1, None).unwrap_err().code, FLOW_FILE_EXISTS);
        // Overwrite with the right hash.
        let v2 = "schemaVersion: 1\nid: s\nname: S2\nnodes: []\n";
        let saved = svc.save_flow(root, ".mdium/flows/lib/s.flow.yaml", v2, Some(&created.sha256)).unwrap();
        assert_eq!(saved.sha256, sha256_hex(v2.as_bytes()));
        assert_eq!(saved.report.flow.unwrap().name, "S2");
        // A stale hash is refused and leaves the file alone.
        let err = svc.save_flow(root, ".mdium/flows/lib/s.flow.yaml", v1, Some(&created.sha256)).unwrap_err();
        assert_eq!(err.code, FLOW_FILE_CHANGED);
        assert_eq!(fs::read_to_string(tmp.path().join(".mdium/flows/lib/s.flow.yaml")).unwrap(), v2);
        // Overwriting a missing file, escaping the project, a bad name, and an oversized body.
        assert_eq!(svc.save_flow(root, ".mdium/flows/missing.flow.yaml", v1, Some("00")).unwrap_err().code, FLOW_FILE_NOT_FOUND);
        assert_eq!(svc.save_flow(root, "../x.flow.yaml", v1, None).unwrap_err().code, FLOW_FILE_PATH_INVALID);
        assert_eq!(svc.save_flow(root, ".mdium/flows/notes.txt", v1, None).unwrap_err().code, FLOW_FILE_PATH_INVALID);
        let big = "#".repeat(crate::load::MAX_FLOW_FILE_BYTES as usize + 1);
        assert_eq!(svc.save_flow(root, ".mdium/flows/big.flow.yaml", &big, None).unwrap_err().code, "FLOW_FILE_TOO_LARGE");
        // Saves stay inside .mdium/flows/.
        assert_eq!(svc.save_flow(root, "src/evil.flow.yaml", v1, None).unwrap_err().code, FLOW_FILE_PATH_INVALID);
        assert_eq!(svc.save_flow(root, ".git/x.flow.json", v1, None).unwrap_err().code, FLOW_FILE_PATH_INVALID);
        assert!(!tmp.path().join("src").exists() && !tmp.path().join(".git").exists());
        // Invalid content is still saved; the report carries the errors.
        let bad = "schemaVersion: 1\nid: s\nname: S\nnodes:\n  - { id: x, kind: nope }\n";
        let saved = svc.save_flow(root, ".mdium/flows/bad.flow.yaml", bad, None).unwrap();
        assert!(!saved.report.errors.is_empty());
        // Dispatch through call().
        let via_call = svc.call("flow_save", json!({ "projectRoot": root, "path": ".mdium/flows/c.flow.yaml", "content": v1, "expectedSha256": null })).unwrap();
        assert_eq!(via_call["sha256"], sha256_hex(v1.as_bytes()));
    }

    #[test]
    fn save_confinement_checks_the_folder_not_a_name_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        let v1 = "schemaVersion: 1\nid: s\nname: S\nnodes: []\n";
        // A sibling folder that merely starts with "flows" is outside.
        assert_eq!(
            svc.save_flow(root, ".mdium/flowsX/a.flow.yaml", v1, None).unwrap_err().code,
            FLOW_FILE_PATH_INVALID
        );
        assert!(!tmp.path().join(".mdium/flowsX").exists());
        // Nested folders under lib/ are inside and are created on save.
        let nested = svc.save_flow(root, ".mdium/flows/lib/sub/x.flow.yaml", v1, None).unwrap();
        assert_eq!(nested.kind, FlowKind::Part);
        assert_eq!(fs::read_to_string(tmp.path().join(".mdium/flows/lib/sub/x.flow.yaml")).unwrap(), v1);
    }

    #[cfg(windows)]
    #[test]
    fn save_accepts_backslash_separators_on_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        let v1 = "schemaVersion: 1\nid: s\nname: S\nnodes: []\n";
        svc.save_flow(root, ".mdium\\flows\\a.flow.yaml", v1, None).unwrap();
        assert_eq!(fs::read_to_string(tmp.path().join(".mdium/flows/a.flow.yaml")).unwrap(), v1);
    }

    fn service(dir: &Path) -> FlowService {
        service_with_env(dir, BTreeMap::new())
    }

    fn service_with_env(dir: &Path, process_env: BTreeMap<String, String>) -> FlowService {
        let env = DriverEnv {
            launcher: Arc::new(AttachedLauncher),
            detached: None,
            sink: Arc::new(NoopSink),
            notifiers: Arc::new(vec![Arc::new(NoopNotifier) as Arc<dyn ApprovalNotifier>]),
            process_env: Arc::new(process_env),
            poll: Duration::from_millis(10),
            worker_launcher: Arc::new(crate::run::worker::PipedWorkerLauncher),
            agent_runner: Arc::new(crate::run::agent::NoAgentRunner),
            forge: Arc::new(crate::forge::FakeForge::new()),
            worktree_base: dir.join("worktrees"),
        };
        FlowService::new(Arc::new(FlowEngine::new(
            env,
            dir.join("confirmations.json"),
        )))
    }

    const OK: &str =
        "schemaVersion: 1\nid: t\nname: T\nnodes:\n  - { id: a, kind: command, run: [x] }\n";

    const MANIFEST: &str = "schemaVersion: 1\nid: p\nname: P\nruntimes:\n  r: { kind: python, python: [.venv/Scripts/python.exe, .venv/bin/python], module: m }\nsetup:\n  - { run: [uv, sync] }\nsecrets: [MDIUM_TEST_SECRET]\n";
    const NO_COMMANDS: &str =
        "schemaVersion: 1\nid: t\nname: T\nnodes:\n  - { id: a, kind: approval, message: hi }\n";

    #[test]
    fn manifest_runtimes_and_setup_require_confirmation_and_change_the_hash() {
        // Review Focus 1 and 3.
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), NO_COMMANDS).unwrap();
        let before = svc
            .command_review(root, ".mdium/flows/a.flow.yaml")
            .unwrap();
        assert!(before.confirmed && before.runtimes.is_empty() && before.project_path.is_none());
        fs::write(tmp.path().join(".mdium/project.yaml"), MANIFEST).unwrap();
        let review = svc
            .command_review(root, ".mdium/flows/a.flow.yaml")
            .unwrap();
        assert_ne!(review.sha256, before.sha256);
        assert!(!review.confirmed);
        assert_eq!(review.project_path.as_deref(), Some(".mdium/project.yaml"));
        assert_eq!(review.runtimes[0].name, "r");
        assert_eq!(
            review.runtimes[0].python,
            vec![".venv/Scripts/python.exe", ".venv/bin/python"]
        );
        assert_eq!(review.runtimes[0].module, "m");
        assert_eq!(review.setup[0].run, vec!["uv", "sync"]);
        // Starting before confirming is refused; after confirming, the secret check runs.
        let err = svc
            .run_start(
                root,
                ".mdium/flows/a.flow.yaml",
                &BTreeMap::new(),
                &review.sha256,
            )
            .unwrap_err();
        assert_eq!(err.code, crate::run::engine::FLOW_COMMANDS_UNCONFIRMED);
        svc.confirm_commands(root, ".mdium/flows/a.flow.yaml", &review.sha256)
            .unwrap();
        let err = svc
            .run_start(
                root,
                ".mdium/flows/a.flow.yaml",
                &BTreeMap::new(),
                &review.sha256,
            )
            .unwrap_err();
        assert_eq!(err.code, crate::run::engine::FLOW_SECRET_MISSING);
        assert_eq!(err.details[0].params["name"], "MDIUM_TEST_SECRET");
        // Editing the manifest invalidates the confirmation.
        fs::write(
            tmp.path().join(".mdium/project.yaml"),
            MANIFEST.replace("uv, sync", "uv, sync, --frozen"),
        )
        .unwrap();
        assert!(
            !svc.command_review(root, ".mdium/flows/a.flow.yaml")
                .unwrap()
                .confirmed
        );
    }

    #[test]
    fn present_secrets_do_not_block_start() {
        let tmp = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([("MDIUM_TEST_SECRET".to_string(), "x".to_string())]);
        let svc = service_with_env(tmp.path(), env);
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), NO_COMMANDS).unwrap();
        fs::write(
            tmp.path().join(".mdium/project.yaml"),
            "schemaVersion: 1\nid: p\nname: P\nsecrets: [MDIUM_TEST_SECRET]\n",
        )
        .unwrap();
        let review = svc
            .command_review(root, ".mdium/flows/a.flow.yaml")
            .unwrap();
        assert!(
            review.confirmed,
            "no commands, runtimes or setup: nothing to confirm"
        );
        let started = svc
            .run_start(
                root,
                ".mdium/flows/a.flow.yaml",
                &BTreeMap::new(),
                &review.sha256,
            )
            .unwrap();
        assert!(!started.run_id.is_empty());
        svc.run_cancel(root, &started.run_id).unwrap();
    }

    #[test]
    fn project_root_must_be_an_existing_absolute_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        assert_eq!(svc.list_flows("").unwrap_err().code, FLOW_PROJECT_INVALID);
        assert_eq!(
            svc.list_flows("relative/dir").unwrap_err().code,
            FLOW_PROJECT_INVALID
        );
        let missing = tmp.path().join("missing");
        assert_eq!(
            svc.list_flows(missing.to_str().unwrap()).unwrap_err().code,
            FLOW_PROJECT_INVALID
        );
    }

    #[test]
    fn load_and_validate_return_reports() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap().to_string();
        let dir = tmp.path().join(".mdium/flows");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.flow.yaml"), OK).unwrap();

        let loaded = svc.load_flow(&root, ".mdium/flows/a.flow.yaml").unwrap();
        assert_eq!(loaded.path, ".mdium/flows/a.flow.yaml");
        assert_eq!(loaded.format, crate::parse::FlowFormat::Yaml);
        assert!(loaded.report.errors.is_empty());
        let json = serde_json::to_value(&loaded).unwrap();
        assert_eq!(json["flow"]["id"], "t");
        assert!(json["errors"].as_array().unwrap().is_empty());

        let checked = svc
            .validate_flow(
                &root,
                ".mdium/flows/new.flow.yaml",
                "schemaVersion: 1\nid: t\nname: T\nnodes: []\n",
            )
            .unwrap();
        assert_eq!(checked.report.errors.len(), 1);
        assert_eq!(svc.list_flows(&root).unwrap().len(), 1);
    }

    #[test]
    fn path_errors_map_to_command_codes() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap().to_string();
        assert_eq!(
            svc.load_flow(&root, ".mdium/flows/none.flow.yaml")
                .unwrap_err()
                .code,
            FLOW_FILE_NOT_FOUND
        );
        assert_eq!(
            svc.load_flow(&root, "../x.flow.yaml").unwrap_err().code,
            FLOW_FILE_PATH_INVALID
        );
        assert_eq!(
            svc.validate_flow(&root, "notes.md", OK).unwrap_err().code,
            FLOW_FILE_PATH_INVALID
        );
    }

    #[test]
    fn engine_errors_keep_code_and_details() {
        let err = FlowCommandError::from(EngineError {
            code: FLOW_RUN_INVALID_ID.into(),
            message: "x".into(),
            details: vec![Reason::new("D")],
        });
        assert_eq!(err.code, FLOW_RUN_INVALID_ID);
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["details"][0]["code"], "D");
        let plain = serde_json::to_value(FlowCommandError::new("C", "m")).unwrap();
        assert!(plain.get("details").is_none());
    }

    #[test]
    fn run_operations_validate_the_project_root_first() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        assert_eq!(svc.run_list("").unwrap_err().code, FLOW_PROJECT_INVALID);
        assert_eq!(svc.run_get("", "r").unwrap_err().code, FLOW_PROJECT_INVALID);
        assert_eq!(
            svc.command_review("", "x.flow.yaml").unwrap_err().code,
            FLOW_PROJECT_INVALID
        );
    }

    #[test]
    fn run_list_of_a_fresh_project_is_empty_and_unknown_ids_fail() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        assert!(svc.run_list(root).unwrap().is_empty());
        assert_eq!(
            svc.run_get(root, "not-an-id").unwrap_err().code,
            FLOW_RUN_INVALID_ID
        );
    }

    #[test]
    fn detects_whether_flow_runs_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        // Not a repository: nothing to suggest.
        assert!(svc.gitignore_status(root).unwrap().ignored);
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(tmp.path())
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        assert!(!svc.gitignore_status(root).unwrap().ignored);
        std::fs::write(tmp.path().join(".gitignore"), ".mdium/flow-runs/\n").unwrap();
        // Both run directories must be ignored.
        assert!(!svc.gitignore_status(root).unwrap().ignored);
        std::fs::write(
            tmp.path().join(".gitignore"),
            ".mdium/flow-runs/\n.mdium/setup-runs/\n",
        )
        .unwrap();
        assert!(svc.gitignore_status(root).unwrap().ignored);
    }

    #[test]
    fn call_dispatches_by_tauri_command_name_with_camel_case_args() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), OK).unwrap();

        let listed = svc
            .call("flow_list", serde_json::json!({ "projectRoot": root }))
            .unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        let loaded = svc
            .call(
                "flow_load",
                serde_json::json!({ "projectRoot": root, "path": ".mdium/flows/a.flow.yaml" }),
            )
            .unwrap();
        assert_eq!(loaded["flow"]["id"], "t");
        let runs = svc
            .call("flow_run_list", serde_json::json!({ "projectRoot": root }))
            .unwrap();
        assert_eq!(runs, serde_json::json!([]));
        let ignored = svc
            .call(
                "flow_gitignore_status",
                serde_json::json!({ "projectRoot": root }),
            )
            .unwrap();
        assert_eq!(ignored["ignored"], true);
    }

    #[test]
    fn call_rejects_unknown_names_and_bad_args() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        assert_eq!(
            svc.call("flow_nope", serde_json::json!({}))
                .unwrap_err()
                .code,
            FLOW_UNKNOWN_COMMAND
        );
        // Missing projectRoot.
        assert_eq!(
            svc.call("flow_list", serde_json::json!({}))
                .unwrap_err()
                .code,
            FLOW_BAD_ARGS
        );
        // attempt must be a number.
        let err = svc
            .call(
                "flow_run_log",
                serde_json::json!({ "projectRoot": root, "runId": "r", "nodeKey": "a", "attempt": "1", "stream": "stdout", "maxBytes": 10 }),
            )
            .unwrap_err();
        assert_eq!(err.code, FLOW_BAD_ARGS);
        // Engine errors pass through unchanged.
        let err = svc
            .call(
                "flow_run_get",
                serde_json::json!({ "projectRoot": root, "runId": "nope" }),
            )
            .unwrap_err();
        assert_eq!(err.code, FLOW_RUN_INVALID_ID);
    }

    #[test]
    fn call_accepts_null_node_key_and_comment_for_approve() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        // Null optionals deserialize and the engine is reached.
        let err = svc
            .call(
                "flow_run_approve",
                serde_json::json!({ "projectRoot": root, "runId": "nope", "nodeKey": null, "choice": "approve", "comment": null }),
            )
            .unwrap_err();
        assert_eq!(err.code, FLOW_RUN_INVALID_ID);
        // Omitting them entirely behaves the same.
        let err = svc
            .call(
                "flow_run_approve",
                serde_json::json!({ "projectRoot": root, "runId": "nope", "choice": "approve" }),
            )
            .unwrap_err();
        assert_eq!(err.code, FLOW_RUN_INVALID_ID);
    }

    #[test]
    fn runtime_describe_rejects_unknown_runtimes_and_missing_manifests() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        assert_eq!(
            svc.runtime_describe(root, "r", "beef").unwrap_err().code,
            FLOW_PROJECT_REQUIRED
        );
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        // A manifest with errors: FLOW_PROJECT_INVALID with the issues (M10).
        fs::write(
            tmp.path().join(".mdium/project.yaml"),
            "schemaVersion: 1\nid: Bad Id\nname: P\n",
        )
        .unwrap();
        let err = svc.runtime_describe(root, "r", "beef").unwrap_err();
        assert_eq!(err.code, FLOW_PROJECT_INVALID);
        assert_eq!(err.details[0].code, crate::issues::FLOW_INVALID_ID);
        let text = "schemaVersion: 1\nid: p\nname: P\nruntimes:\n  r: { kind: python, python: nope, module: m }\n";
        fs::write(tmp.path().join(".mdium/project.yaml"), text).unwrap();
        let sha = sha256_hex(text.as_bytes());
        // I7: describe runs project code, so it needs the shown manifest's hash.
        assert_eq!(
            svc.runtime_describe(root, "r", "beef").unwrap_err().code,
            FLOW_FILE_CHANGED
        );
        assert_eq!(
            svc.runtime_describe(root, "zzz", &sha).unwrap_err().code,
            crate::issues::FLOW_RUNTIME_UNKNOWN
        );
        // No interpreter at `nope`: resolution fails before any process starts.
        let err = svc.runtime_describe(root, "r", &sha).unwrap_err();
        assert_eq!(err.code, crate::run::worker::FLOW_RUNTIME_START_FAILED);
        assert!(err.message.contains("no interpreter found"), "{}", err.message);
        let describe_dir = tmp.path().join(".mdium/flow-runs/.describe");
        assert!(
            !describe_dir.exists() || fs::read_dir(&describe_dir).unwrap().next().is_none(),
            "temp dir cleaned"
        );
        let via_call = svc
            .call(
                "flow_runtime_describe",
                serde_json::json!({ "projectRoot": root, "runtime": "zzz", "sha256": sha }),
            )
            .unwrap_err();
        assert_eq!(via_call.code, crate::issues::FLOW_RUNTIME_UNKNOWN);
        let no_sha = svc
            .call(
                "flow_runtime_describe",
                serde_json::json!({ "projectRoot": root, "runtime": "r" }),
            )
            .unwrap_err();
        assert_eq!(no_sha.code, FLOW_BAD_ARGS);
    }

    #[test]
    fn templates_are_listed_and_copied_through_call() {
        crate::templates::test_templates();
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        let list = svc
            .call("flow_template_list", serde_json::json!({ "projectRoot": root }))
            .unwrap();
        assert!(list
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "dev-workflow" && t["main"] == "flows/dev-workflow.flow.yaml"));
        let copy = serde_json::json!({ "projectRoot": root, "template": "dev-workflow", "fileName": "develop" });
        let written = svc.call("flow_template_copy", copy.clone()).unwrap();
        assert_eq!(written, serde_json::json!([".mdium/flows/develop.flow.yaml"]));
        // The copy is a valid entry flow of the project.
        let loaded = svc.load_flow(root, ".mdium/flows/develop.flow.yaml").unwrap();
        assert!(loaded.report.errors.is_empty(), "{:?}", loaded.report.errors);
        let again = svc.call("flow_template_copy", copy).unwrap_err();
        assert_eq!(again.code, crate::issues::FLOW_INVALID_VALUE);
        assert_eq!(again.details[0].params["reason"], serde_json::json!("exists"));
        let bad = svc
            .call(
                "flow_template_copy",
                serde_json::json!({ "projectRoot": root, "template": "dev-workflow", "fileName": "Bad Name" }),
            )
            .unwrap_err();
        assert_eq!(bad.code, crate::issues::FLOW_INVALID_ID);
    }

    #[test]
    fn the_template_language_is_set_through_call() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        // The default language, so the parallel tests keep their fixture.
        let reply = svc
            .call("flow_template_language", serde_json::json!({ "language": "en" }))
            .unwrap();
        assert_eq!(reply, serde_json::Value::Null);
        assert_eq!(crate::templates::language(), "en");
        let bad = svc
            .call("flow_template_language", serde_json::json!({ "lang": "ja" }))
            .unwrap_err();
        assert_eq!(bad.code, FLOW_BAD_ARGS);
    }

    #[test]
    fn every_command_name_is_dispatchable() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        for name in COMMAND_NAMES {
            // With empty args every command fails on arguments, never on the name.
            let code = svc.call(name, serde_json::json!({})).unwrap_err().code;
            assert_ne!(code, FLOW_UNKNOWN_COMMAND, "{name}");
        }
    }

    #[test]
    fn parts_cannot_be_started() {
        use crate::run::engine::FLOW_RUN_NOT_ENTRY;
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows/lib")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/lib/p.flow.yaml"), OK).unwrap();
        let review = svc
            .command_review(root, ".mdium/flows/lib/p.flow.yaml")
            .unwrap();
        svc.confirm_commands(root, ".mdium/flows/lib/p.flow.yaml", &review.sha256)
            .unwrap();
        let err = svc
            .run_start(
                root,
                ".mdium/flows/lib/p.flow.yaml",
                &BTreeMap::new(),
                &review.sha256,
            )
            .unwrap_err();
        assert_eq!(err.code, FLOW_RUN_NOT_ENTRY);
        let loaded = svc.load_flow(root, ".mdium/flows/lib/p.flow.yaml").unwrap();
        assert_eq!(loaded.kind, crate::load::FlowKind::Part);
    }

    #[test]
    fn project_setup_requires_a_valid_manifest_and_rejects_concurrent_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        assert_eq!(
            svc.project_setup(root, "", &|_| {}).unwrap_err().code,
            FLOW_PROJECT_REQUIRED
        );
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        fs::write(
            tmp.path().join(".mdium/project.yaml"),
            "schemaVersion: 1\nid: p\nname: P\n",
        )
        .unwrap();
        let sha = svc.project_load(root).unwrap().sha256.unwrap();
        let result = svc.project_setup(root, &sha, &|_| {}).unwrap();
        assert!(result.ok && result.steps.is_empty());
        let via_call = svc
            .call(
                "flow_project_setup",
                serde_json::json!({ "projectRoot": root, "sha256": sha }),
            )
            .unwrap();
        assert_eq!(via_call["ok"], true);
        // Busy: mark the root as running, then try again.
        svc.setups
            .lock()
            .unwrap()
            .insert(project_root(root).unwrap());
        assert_eq!(
            svc.project_setup(root, &sha, &|_| {}).unwrap_err().code,
            FLOW_SETUP_BUSY
        );
    }

    #[test]
    fn project_setup_refuses_a_manifest_that_changed_after_review() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        let file = tmp.path().join(".mdium/project.yaml");
        fs::write(&file, "schemaVersion: 1\nid: p\nname: P\n").unwrap();
        let sha = svc.project_load(root).unwrap().sha256.unwrap();
        fs::write(&file, "schemaVersion: 1\nid: p\nname: Changed\n").unwrap();
        assert_eq!(
            svc.project_setup(root, &sha, &|_| {}).unwrap_err().code,
            FLOW_FILE_CHANGED
        );
        assert!(svc.setups.lock().unwrap().is_empty());
    }

    #[test]
    fn project_setup_releases_the_busy_flag_after_a_failed_step() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        let step = if cfg!(windows) {
            "{ run: [cmd, /C, 'exit 3'] }"
        } else {
            "{ run: [sh, -c, 'exit 3'] }"
        };
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        fs::write(
            tmp.path().join(".mdium/project.yaml"),
            format!("schemaVersion: 1\nid: p\nname: P\nsetup:\n  - {step}\n"),
        )
        .unwrap();
        let sha = svc.project_load(root).unwrap().sha256.unwrap();
        assert!(!svc.project_setup(root, &sha, &|_| {}).unwrap().ok);
        assert!(!svc.project_setup(root, &sha, &|_| {}).unwrap().ok);
    }

    #[test]
    fn project_setup_releases_the_busy_flag_when_progress_panics() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        fs::write(
            tmp.path().join(".mdium/project.yaml"),
            "schemaVersion: 1\nid: p\nname: P\nsetup:\n  - { run: [x] }\n",
        )
        .unwrap();
        let sha = svc.project_load(root).unwrap().sha256.unwrap();
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = svc.project_setup(root, &sha, &|_| panic!("boom"));
        }));
        assert!(panicked.is_err());
        assert!(svc.setups.lock().unwrap().is_empty());
    }

    #[test]
    fn project_load_reports_missing_and_present_manifests() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        let missing = svc.project_load(root).unwrap();
        assert!(
            !missing.exists && missing.report.project.is_none() && missing.report.errors.is_empty()
        );
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        fs::write(
            tmp.path().join(".mdium/project.yaml"),
            "schemaVersion: 1\nid: p\nname: P\nsecrets: [A_KEY]\n",
        )
        .unwrap();
        let present = svc.project_load(root).unwrap();
        assert!(present.exists);
        assert_eq!(
            present.report.project.as_ref().unwrap().secrets,
            vec!["A_KEY"]
        );
        let json = serde_json::to_value(&present).unwrap();
        assert_eq!(json["path"], ".mdium/project.yaml");
        assert_eq!(json["project"]["id"], "p");
        let via_call = svc
            .call(
                "flow_project_load",
                serde_json::json!({ "projectRoot": root }),
            )
            .unwrap();
        assert_eq!(via_call["exists"], true);
    }

    const PY_FLOW: &str = "schemaVersion: 1\nid: t\nname: T\nnodes:\n  - { id: r, kind: python, runtime: r, entry: a.b, with: { x: 1 } }\n";

    #[test]
    fn python_stages_appear_in_the_review_and_need_confirmation() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nruntimes:\n  r: { kind: python, python: nope, module: m }\n").unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), PY_FLOW).unwrap();
        let review = svc
            .command_review(root, ".mdium/flows/a.flow.yaml")
            .unwrap();
        assert!(!review.confirmed);
        assert_eq!(review.stages.len(), 1);
        assert_eq!(
            (
                review.stages[0].runtime.as_str(),
                review.stages[0].entry.as_str(),
                review.stages[0].node_id.as_str()
            ),
            ("r", "a.b", "r")
        );
        let json = serde_json::to_value(&review).unwrap();
        assert_eq!(json["stages"][0]["nodeId"], "r");
    }

    #[test]
    fn start_refuses_an_invalid_manifest() {
        use crate::run::engine::FLOW_PROJECT_INVALID;
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), NO_COMMANDS).unwrap();
        fs::write(
            tmp.path().join(".mdium/project.yaml"),
            "schemaVersion: 1\nid: Bad Id\nname: P\n",
        )
        .unwrap();
        let review = svc
            .command_review(root, ".mdium/flows/a.flow.yaml")
            .unwrap();
        let err = svc
            .run_start(
                root,
                ".mdium/flows/a.flow.yaml",
                &BTreeMap::new(),
                &review.sha256,
            )
            .unwrap_err();
        assert_eq!(err.code, FLOW_PROJECT_INVALID);
        assert_eq!(err.details[0].code, crate::issues::FLOW_INVALID_ID);
    }

    #[test]
    fn artifact_path_returns_recorded_paths_only() {
        use crate::run::artifacts::write_artifacts_json;
        use crate::run::engine::FLOW_ARTIFACT_NOT_FOUND;
        use crate::run::model::Artifact;
        use crate::run::store::RunStore;
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), NO_COMMANDS).unwrap();
        let review = svc
            .command_review(root, ".mdium/flows/a.flow.yaml")
            .unwrap();
        let started = svc
            .run_start(
                root,
                ".mdium/flows/a.flow.yaml",
                &BTreeMap::new(),
                &review.sha256,
            )
            .unwrap();
        let run_id = started.run_id;
        // Record one artifact for node `a`, attempt 1.
        let dir = RunStore::new(tmp.path())
            .node_attempt_dir(&run_id, "a", 1)
            .unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "x").unwrap();
        let recorded = |path: &str, media_type: &str| Artifact {
            index: 0,
            path: path.into(),
            label: Some("t".into()),
            media_type: media_type.into(),
            bytes: None,
            recorded_at: String::new(),
        };
        write_artifacts_json(&dir, &[recorded("a.txt", "text/plain")]).unwrap();

        let loc = svc.run_artifact_path(root, &run_id, "a", 1, 0).unwrap();
        assert!(Path::new(&loc.path).is_absolute());
        #[cfg(windows)]
        assert!(!loc.path.starts_with(r"\\?\"));
        assert!(loc.path.ends_with("a.txt"));
        assert_eq!(loc.media_type, "text/plain");
        assert_eq!(loc.bytes, Some(1));
        assert_eq!(
            svc.run_artifact_path(root, &run_id, "a", 1, 9)
                .unwrap_err()
                .code,
            FLOW_ARTIFACT_NOT_FOUND
        );
        assert_eq!(
            svc.run_artifact_path(root, &run_id, "zzz", 1, 0)
                .unwrap_err()
                .code,
            "FLOW_NODE_NOT_FOUND"
        );
        let via_call = svc
            .call(
                "flow_artifact_path",
                serde_json::json!({ "projectRoot": root, "runId": run_id, "nodeKey": "a", "attempt": 1, "index": 0 }),
            )
            .unwrap();
        assert_eq!(via_call["mediaType"], "text/plain");
        // A tampered artifacts.json pointing outside the project is refused.
        let outside = if cfg!(windows) {
            "C:/Windows/notepad.exe"
        } else {
            "/etc/passwd"
        };
        write_artifacts_json(&dir, &[recorded(outside, "application/octet-stream")]).unwrap();
        assert_eq!(
            svc.run_artifact_path(root, &run_id, "a", 1, 0)
                .unwrap_err()
                .code,
            FLOW_ARTIFACT_NOT_FOUND
        );
        svc.run_cancel(root, &run_id).unwrap();
    }

    #[test]
    fn run_meta_snapshots_the_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        fs::create_dir_all(tmp.path().join(".mdium/flows")).unwrap();
        fs::write(tmp.path().join(".mdium/flows/a.flow.yaml"), NO_COMMANDS).unwrap();
        fs::write(
            tmp.path().join(".mdium/project.yaml"),
            "schemaVersion: 1\nid: p\nname: P\nmetrics: [{ ref: costUsd, better: lower }]\n",
        )
        .unwrap();
        let review = svc
            .command_review(root, ".mdium/flows/a.flow.yaml")
            .unwrap();
        let started = svc
            .run_start(
                root,
                ".mdium/flows/a.flow.yaml",
                &BTreeMap::new(),
                &review.sha256,
            )
            .unwrap();
        let snap = svc.run_get(root, &started.run_id).unwrap();
        assert_eq!(snap.meta.project.as_ref().unwrap().id, "p");
        svc.run_cancel(root, &started.run_id).unwrap();
    }
}

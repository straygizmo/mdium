//! The service facade of the flow engine: every operation the desktop app
//! exposes as a Tauri command and the flow server exposes over HTTP, as
//! plain methods on one object (spec 2026-10-10, 10.1 "FlowService").

use crate::load::{self, FlowReport, FlowSummary, PathProblem};
use crate::parse::FlowFormat;
use crate::run::engine::{CommandReview, EngineError, FlowEngine, RunSnapshot, RunSummary};
use crate::run::model::Reason;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

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

/// Whether git ignores `.mdium/flow-runs/` in `root` (the UI suggests
/// adding it otherwise; nothing is written automatically).
pub fn flow_runs_ignored(root: &Path) -> bool {
    let mut command = std::process::Command::new("git");
    command
        .args(["check-ignore", "-q", ".mdium/flow-runs/probe"])
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

/// Every operation of the flow engine as plain methods. One per process;
/// transports (Tauri commands, HTTP handlers) are thin wrappers over it.
pub struct FlowService {
    engine: Arc<FlowEngine>,
}

impl FlowService {
    pub fn new(engine: Arc<FlowEngine>) -> Self {
        Self { engine }
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
    pub fn load_flow(&self, project_root_arg: &str, path: &str) -> Result<FlowLoadResult, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        let file = flow_file(&root, path, true)?;
        Ok(FlowLoadResult {
            path: load::relative_display(&root, &file),
            format: format_of(&file),
            report: load::check_file(&root, &file),
        })
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
        Ok(FlowLoadResult {
            path: load::relative_display(&root, &file),
            format: format_of(&file),
            report: load::check_content(&root, &file, content),
        })
    }

    pub fn command_review(&self, project_root_arg: &str, path: &str) -> Result<CommandReview, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.review_commands(&root, path)?)
    }

    pub fn confirm_commands(&self, project_root_arg: &str, path: &str, sha256: &str) -> Result<(), FlowCommandError> {
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

    pub fn run_get(&self, project_root_arg: &str, run_id: &str) -> Result<RunSnapshot, FlowCommandError> {
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
        Ok(self.engine.approve(&root, run_id, node_key, choice, comment)?)
    }

    pub fn run_rerun_node(&self, project_root_arg: &str, run_id: &str, node_key: &str) -> Result<(), FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(self.engine.rerun_node(&root, run_id, node_key)?)
    }

    pub fn run_mark_succeeded(&self, project_root_arg: &str, run_id: &str, node_key: &str) -> Result<(), FlowCommandError> {
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
        Ok(self.engine.log(&root, run_id, node_key, attempt, stream, max_bytes)?)
    }

    pub fn gitignore_status(&self, project_root_arg: &str) -> Result<GitignoreStatus, FlowCommandError> {
        let root = project_root(project_root_arg)?;
        Ok(GitignoreStatus { ignored: flow_runs_ignored(&root) })
    }

    /// Waits for active drivers to record `interrupted` (app exit).
    pub fn shutdown(&self, wait: Duration) {
        self.engine.shutdown(wait);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::driver::{ApprovalNotifier, DriverEnv, EventSink};
    use crate::run::engine::FlowEngine;
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

    fn service(dir: &Path) -> FlowService {
        let env = DriverEnv {
            launcher: Arc::new(AttachedLauncher),
            detached: None,
            sink: Arc::new(NoopSink),
            notifiers: Arc::new(vec![Arc::new(NoopNotifier) as Arc<dyn ApprovalNotifier>]),
            process_env: Arc::new(Default::default()),
            poll: Duration::from_millis(10),
        };
        FlowService::new(Arc::new(FlowEngine::new(env, dir.join("confirmations.json"))))
    }

    const OK: &str =
        "schemaVersion: 1\nid: t\nname: T\nnodes:\n  - { id: a, kind: command, run: [x] }\n";

    #[test]
    fn project_root_must_be_an_existing_absolute_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        assert_eq!(svc.list_flows("").unwrap_err().code, FLOW_PROJECT_INVALID);
        assert_eq!(svc.list_flows("relative/dir").unwrap_err().code, FLOW_PROJECT_INVALID);
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
            .validate_flow(&root, ".mdium/flows/new.flow.yaml", "schemaVersion: 1\nid: t\nname: T\nnodes: []\n")
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
            svc.load_flow(&root, ".mdium/flows/none.flow.yaml").unwrap_err().code,
            FLOW_FILE_NOT_FOUND
        );
        assert_eq!(svc.load_flow(&root, "../x.flow.yaml").unwrap_err().code, FLOW_FILE_PATH_INVALID);
        assert_eq!(svc.validate_flow(&root, "notes.md", OK).unwrap_err().code, FLOW_FILE_PATH_INVALID);
    }

    #[test]
    fn engine_errors_keep_code_and_details() {
        use crate::run::engine::FLOW_RUN_INVALID_ID;
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
        assert_eq!(svc.command_review("", "x.flow.yaml").unwrap_err().code, FLOW_PROJECT_INVALID);
    }

    #[test]
    fn run_list_of_a_fresh_project_is_empty_and_unknown_ids_fail() {
        use crate::run::engine::FLOW_RUN_INVALID_ID;
        let tmp = tempfile::tempdir().unwrap();
        let svc = service(tmp.path());
        let root = tmp.path().to_str().unwrap();
        assert!(svc.run_list(root).unwrap().is_empty());
        assert_eq!(svc.run_get(root, "not-an-id").unwrap_err().code, FLOW_RUN_INVALID_ID);
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
        assert!(svc.gitignore_status(root).unwrap().ignored);
    }
}

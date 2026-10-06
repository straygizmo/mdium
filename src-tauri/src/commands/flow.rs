// src-tauri/src/commands/flow.rs
//! Tauri commands of the generic flow engine (PR 1: read and validate
//! flow definition files only; nothing is executed). The UI that calls
//! these is gated behind the `experimentalFlows` setting.

use crate::flow::load::{self, FlowReport, FlowSummary, PathProblem};
use crate::flow::parse::FlowFormat;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The project root is empty, not absolute, or not an existing directory.
pub const FLOW_PROJECT_INVALID: &str = "FLOW_PROJECT_INVALID";
/// The flow path is not a `*.flow.{yaml,yml,json}` file inside the project
/// (or goes through a link).
pub const FLOW_FILE_PATH_INVALID: &str = "FLOW_FILE_PATH_INVALID";
/// The flow file does not exist.
pub const FLOW_FILE_NOT_FOUND: &str = "FLOW_FILE_NOT_FOUND";
/// Listing the flows directory failed.
pub const FLOW_LIST_FAILED: &str = "FLOW_LIST_FAILED";
/// The blocking task could not be joined.
pub const FLOW_COMMAND_FAILED: &str = "FLOW_COMMAND_FAILED";

/// A command failure as the UI receives it: `{ code, message }`. `message`
/// is a log detail; the UI localizes by `code`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FlowCommandError {
    pub code: String,
    pub message: String,
    /// Machine-readable details (validation problems, nodes needing action, ...).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<crate::flow::run::model::Reason>,
}

impl FlowCommandError {
    pub(crate) fn new(code: &str, detail: impl std::fmt::Display) -> Self {
        Self {
            code: code.to_string(),
            message: format!("{code}: {detail}"),
            details: Vec::new(),
        }
    }
}

impl From<crate::flow::run::engine::EngineError> for FlowCommandError {
    fn from(err: crate::flow::run::engine::EngineError) -> Self {
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

pub(crate) async fn blocking<T, F>(op: F) -> Result<T, FlowCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, FlowCommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(op)
        .await
        .map_err(|err| FlowCommandError::new(FLOW_COMMAND_FAILED, err))?
}

pub(crate) fn project_root(project_root: &str) -> Result<PathBuf, FlowCommandError> {
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

fn list(project_root_arg: &str) -> Result<Vec<FlowSummary>, FlowCommandError> {
    let root = project_root(project_root_arg)?;
    load::list_flows(&root).map_err(|err| FlowCommandError::new(FLOW_LIST_FAILED, err))
}

fn load_file(project_root_arg: &str, path: &str) -> Result<FlowLoadResult, FlowCommandError> {
    let root = project_root(project_root_arg)?;
    let file = flow_file(&root, path, true)?;
    Ok(FlowLoadResult {
        path: load::relative_display(&root, &file),
        format: format_of(&file),
        report: load::check_file(&root, &file),
    })
}

fn validate_content(
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

/// Lists `<projectRoot>/.mdium/flows/*.flow.{yaml,yml,json}` with a
/// validation summary of each.
#[tauri::command]
pub async fn flow_list(project_root: String) -> Result<Vec<FlowSummary>, FlowCommandError> {
    blocking(move || list(&project_root)).await
}

/// Reads and validates one flow file (`path` is project-relative).
#[tauri::command]
pub async fn flow_load(
    project_root: String,
    path: String,
) -> Result<FlowLoadResult, FlowCommandError> {
    blocking(move || load_file(&project_root, &path)).await
}

/// Validates unsaved `content` as if it were the file at `path`
/// (project-relative; sub-flow references resolve from its directory).
#[tauri::command]
pub async fn flow_validate(
    project_root: String,
    path: String,
    content: String,
) -> Result<FlowLoadResult, FlowCommandError> {
    blocking(move || validate_content(&project_root, &path, &content)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const OK: &str =
        "schemaVersion: 1\nid: t\nname: T\nnodes:\n  - { id: a, kind: command, run: [x] }\n";

    #[test]
    fn project_root_must_be_an_existing_absolute_directory() {
        assert_eq!(list("").unwrap_err().code, FLOW_PROJECT_INVALID);
        assert_eq!(list("relative/dir").unwrap_err().code, FLOW_PROJECT_INVALID);
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("missing");
        assert_eq!(
            list(missing.to_str().unwrap()).unwrap_err().code,
            FLOW_PROJECT_INVALID
        );
    }

    #[test]
    fn load_and_validate_return_reports() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_str().unwrap().to_string();
        let dir = tmp.path().join(".mdium/flows");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.flow.yaml"), OK).unwrap();

        let loaded = load_file(&root, ".mdium/flows/a.flow.yaml").unwrap();
        assert_eq!(loaded.path, ".mdium/flows/a.flow.yaml");
        assert_eq!(loaded.format, FlowFormat::Yaml);
        assert!(loaded.report.errors.is_empty());
        let json = serde_json::to_value(&loaded).unwrap();
        assert_eq!(json["flow"]["id"], "t");
        assert!(json["errors"].as_array().unwrap().is_empty());

        let checked = validate_content(
            &root,
            ".mdium/flows/new.flow.yaml",
            "schemaVersion: 1\nid: t\nname: T\nnodes: []\n",
        )
        .unwrap();
        assert_eq!(checked.report.errors.len(), 1);

        assert_eq!(list(&root).unwrap().len(), 1);
    }

    #[test]
    fn path_errors_map_to_command_codes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_str().unwrap().to_string();
        assert_eq!(
            load_file(&root, ".mdium/flows/none.flow.yaml")
                .unwrap_err()
                .code,
            FLOW_FILE_NOT_FOUND
        );
        assert_eq!(
            load_file(&root, "../x.flow.yaml").unwrap_err().code,
            FLOW_FILE_PATH_INVALID
        );
        assert_eq!(
            validate_content(&root, "notes.md", OK).unwrap_err().code,
            FLOW_FILE_PATH_INVALID
        );
    }
}

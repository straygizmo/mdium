//! Flow files on disk: listing `.mdium/flows/`, reading with a size limit,
//! the full check (parse → decode → validate), and file references
//! (`promptRef`, `subflow.flow`, file loop bodies): containment in the
//! project, no links, existence, sub-flow recursion and arguments.

use crate::flow::issues::*;
use crate::flow::model::*;
use crate::flow::parse::{decode, parse_text, FlowFormat};
use crate::flow::validate::validate;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// Largest flow file we read (1 MiB).
pub const MAX_FLOW_FILE_BYTES: u64 = 1024 * 1024;
/// Deepest sub-flow nesting we follow.
pub const MAX_SUBFLOW_DEPTH: usize = 16;
/// Directory of a project's flow files, relative to its root.
pub const FLOWS_DIR: &str = ".mdium/flows";

/// The outcome of checking one flow file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowReport {
    /// The decoded flow; `None` when parsing or decoding failed.
    pub flow: Option<FlowDef>,
    pub errors: Vec<FlowIssue>,
    pub warnings: Vec<FlowIssue>,
}

impl FlowReport {
    fn from_issues(flow: Option<FlowDef>, issues: Issues) -> Self {
        Self {
            flow,
            errors: issues.errors,
            warnings: issues.warnings,
        }
    }

    fn single_error(issue: FlowIssue) -> Self {
        Self {
            flow: None,
            errors: vec![issue],
            warnings: vec![],
        }
    }
}

/// Parse, decode and validate `text` without touching the file system.
pub fn check_text(text: &str, format: FlowFormat) -> (Option<FlowDef>, Issues) {
    let value = match parse_text(text, format) {
        Ok(value) => value,
        Err(issue) => {
            let mut issues = Issues::default();
            issues.error(issue);
            return (None, issues);
        }
    };
    let decoded = decode(&value);
    let mut issues = decoded.issues;
    if let Some(flow) = &decoded.flow {
        issues.extend(validate(flow));
    }
    (decoded.flow, issues)
}

/// Lexically normalizes a path (`.` and `..`), without touching the disk.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Why a path is unusable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathProblem {
    /// Absolute, escapes the project root, or goes through a link.
    Outside(&'static str),
    NotFound,
}

/// Resolves `relative` against `base_dir` and checks that it stays inside
/// `project_root`, that no component below the root is a symlink or
/// junction, and that it names an existing file.
pub fn resolve_in_project(
    project_root: &Path,
    base_dir: &Path,
    relative: &str,
) -> Result<PathBuf, PathProblem> {
    let rel = Path::new(relative);
    if rel.is_absolute()
        || rel.has_root()
        || rel.components().any(|c| matches!(c, Component::Prefix(_)))
    {
        return Err(PathProblem::Outside("absolute"));
    }
    let root = normalize(project_root);
    let target = normalize(&base_dir.join(rel));
    let inner = target
        .strip_prefix(&root)
        .map_err(|_| PathProblem::Outside("outside-root"))?;
    if inner.as_os_str().is_empty() {
        return Err(PathProblem::Outside("outside-root"));
    }
    let mut current = root.clone();
    for component in inner.components() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(PathProblem::Outside("link")),
            Ok(_) => {}
            Err(_) => return Err(PathProblem::NotFound),
        }
    }
    if !current.is_file() {
        return Err(PathProblem::NotFound);
    }
    Ok(current)
}

fn path_issue(problem: PathProblem, path: &str, reference: &str) -> FlowIssue {
    match problem {
        PathProblem::Outside(reason) => FlowIssue::new(FLOW_PATH_OUTSIDE_PROJECT, path)
            .with("reason", reason)
            .with("ref", reference),
        PathProblem::NotFound => FlowIssue::new(FLOW_REF_NOT_FOUND, path).with("ref", reference),
    }
}

/// Reads a flow file, refusing files over [`MAX_FLOW_FILE_BYTES`].
fn read_flow_file(path: &Path) -> Result<String, FlowIssue> {
    let meta = std::fs::metadata(path)
        .map_err(|err| FlowIssue::new(FLOW_REF_NOT_FOUND, "").with("message", err.to_string()))?;
    if meta.len() > MAX_FLOW_FILE_BYTES {
        return Err(FlowIssue::new(FLOW_FILE_TOO_LARGE, "")
            .with("size", meta.len())
            .with("limit", MAX_FLOW_FILE_BYTES));
    }
    let bytes = std::fs::read(path)
        .map_err(|err| FlowIssue::new(FLOW_REF_NOT_FOUND, "").with("message", err.to_string()))?;
    String::from_utf8(bytes).map_err(|_| {
        FlowIssue::new(FLOW_PARSE_FAILED, "").with("message", "file is not valid UTF-8")
    })
}

/// Checks `text` as the content of `file` (which need not exist yet),
/// including its file references.
pub fn check_content(project_root: &Path, file: &Path, text: &str) -> FlowReport {
    let Some(format) = file
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(FlowFormat::from_file_name)
    else {
        return FlowReport::single_error(
            FlowIssue::new(FLOW_INVALID_VALUE, "").with("reason", "bad-file-name"),
        );
    };
    let mut stack = vec![normalize(file)];
    check_content_at(project_root, file, text, format, &mut stack)
}

/// Reads and fully checks `file`.
pub fn check_file(project_root: &Path, file: &Path) -> FlowReport {
    match read_flow_file(file) {
        Ok(text) => check_content(project_root, file, &text),
        Err(issue) => FlowReport::single_error(issue),
    }
}

fn check_content_at(
    project_root: &Path,
    file: &Path,
    text: &str,
    format: FlowFormat,
    stack: &mut Vec<PathBuf>,
) -> FlowReport {
    let (flow, mut issues) = check_text(text, format);
    if let Some(flow) = &flow {
        let base = file.parent().unwrap_or(project_root).to_path_buf();
        let mut refs = RefChecker {
            project_root,
            base: &base,
            stack,
            issues: Issues::default(),
        };
        refs.nodes(&flow.nodes, "");
        issues.extend(refs.issues);
    }
    FlowReport::from_issues(flow, issues)
}

struct RefChecker<'a> {
    project_root: &'a Path,
    base: &'a Path,
    stack: &'a mut Vec<PathBuf>,
    issues: Issues,
}

impl RefChecker<'_> {
    fn nodes(&mut self, nodes: &[FlowNode], path: &str) {
        for (i, node) in nodes.iter().enumerate() {
            let node_path = if path.is_empty() {
                format!("nodes[{i}]")
            } else {
                format!("{path}.nodes[{i}]")
            };
            match &node.kind {
                NodeKind::Agent(agent) => {
                    if let Some(prompt_ref) = &agent.prompt_ref {
                        if !prompt_ref.starts_with("builtin:") && !prompt_ref.trim().is_empty() {
                            let p = format!("{node_path}.promptRef");
                            if let Err(problem) =
                                resolve_in_project(self.project_root, self.base, prompt_ref)
                            {
                                self.issues.error(path_issue(problem, &p, prompt_ref));
                            }
                        }
                    }
                }
                NodeKind::Subflow(sub) => {
                    self.flow_ref(
                        &sub.flow,
                        &format!("{node_path}.flow"),
                        &sub.params,
                        &node_path,
                    );
                }
                NodeKind::Loop(lp) => match &lp.body {
                    LoopBody::File(file) => {
                        self.flow_ref(file, &format!("{node_path}.body"), &lp.params, &node_path);
                    }
                    LoopBody::Inline(body) => self.nodes(&body.nodes, &format!("{node_path}.body")),
                },
                _ => {}
            }
        }
    }

    /// A referenced flow file: resolve, recurse, and match arguments.
    fn flow_ref(
        &mut self,
        reference: &str,
        path: &str,
        args: &BTreeMap<String, Value>,
        node_path: &str,
    ) {
        if reference.trim().is_empty() || crate::flow::template::has_template(reference) {
            return; // already reported by the validator
        }
        let file = match resolve_in_project(self.project_root, self.base, reference) {
            Ok(file) => file,
            Err(problem) => {
                self.issues.error(path_issue(problem, path, reference));
                return;
            }
        };
        let Some(format) = file
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(FlowFormat::from_file_name)
        else {
            self.issues
                .error(invalid_ref(path, reference, "bad-file-name"));
            return;
        };
        let key = normalize(&file);
        if self.stack.contains(&key) {
            self.issues.error(
                FlowIssue::new(FLOW_SUBFLOW_RECURSION, path)
                    .with("ref", reference)
                    .with("reason", "cycle"),
            );
            return;
        }
        if self.stack.len() >= MAX_SUBFLOW_DEPTH {
            self.issues.error(
                FlowIssue::new(FLOW_SUBFLOW_RECURSION, path)
                    .with("ref", reference)
                    .with("reason", "too-deep"),
            );
            return;
        }
        let text = match read_flow_file(&file) {
            Ok(text) => text,
            Err(issue) => {
                self.issues.error(
                    FlowIssue {
                        path: path.to_string(),
                        ..issue
                    }
                    .with("ref", reference),
                );
                return;
            }
        };
        self.stack.push(key);
        let child = check_content_at(self.project_root, &file, &text, format, self.stack);
        self.stack.pop();
        if child
            .errors
            .iter()
            .any(|e| e.code == FLOW_SUBFLOW_RECURSION)
        {
            self.issues.error(
                FlowIssue::new(FLOW_SUBFLOW_RECURSION, path)
                    .with("ref", reference)
                    .with("reason", "cycle"),
            );
            return;
        }
        if !child.errors.is_empty() {
            self.issues.error(
                FlowIssue::new(FLOW_SUBFLOW_INVALID, path)
                    .with("ref", reference)
                    .with("errorCount", child.errors.len()),
            );
            return;
        }
        let Some(child) = child.flow else { return };
        for key in args.keys() {
            if !child.params.contains_key(key) {
                self.issues.error(
                    FlowIssue::new(FLOW_PARAM_MISMATCH, format!("{node_path}.params.{key}"))
                        .with("param", key.clone())
                        .with("reason", "unknown"),
                );
            }
        }
        for (name, def) in &child.params {
            if def.required && def.default.is_none() && !args.contains_key(name) {
                self.issues.error(
                    FlowIssue::new(FLOW_PARAM_MISMATCH, format!("{node_path}.params"))
                        .with("param", name.clone())
                        .with("reason", "missing"),
                );
            }
        }
    }
}

fn invalid_ref(path: &str, reference: &str, reason: &str) -> FlowIssue {
    FlowIssue::new(FLOW_INVALID_VALUE, path)
        .with("reason", reason)
        .with("ref", reference)
}

/// One entry of [`list_flows`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSummary {
    /// Project-relative path with `/` separators.
    pub path: String,
    pub id: Option<String>,
    pub name: Option<String>,
    pub error_count: usize,
    pub warning_count: usize,
}

/// Project-relative display form of `file` (`/` separators).
pub fn relative_display(project_root: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(project_root).unwrap_or(file);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Lists and checks the flow files in `<root>/.mdium/flows/` (not
/// recursive; links are skipped). A missing directory yields an empty list.
pub fn list_flows(project_root: &Path) -> std::io::Result<Vec<FlowSummary>> {
    let dir = project_root.join(FLOWS_DIR);
    for sub in [project_root.join(".mdium"), dir.clone()] {
        match std::fs::symlink_metadata(&sub) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => return Ok(vec![]),
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(err) => return Err(err),
        }
    }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_file() && FlowFormat::from_file_name(&name).is_some() {
            files.push(entry.path());
        }
    }
    files.sort();
    Ok(files
        .iter()
        .map(|file| {
            let report = check_file(project_root, file);
            FlowSummary {
                path: relative_display(project_root, file),
                id: report.flow.as_ref().map(|f| f.id.clone()),
                name: report.flow.as_ref().map(|f| f.name.clone()),
                error_count: report.errors.len(),
                warning_count: report.warnings.len(),
            }
        })
        .collect())
}

/// Resolves a project-relative flow path given by the UI: it must stay in
/// the project, avoid links, and have a flow file name. The file itself
/// need not exist (`must_exist: false`, for validating unsaved content).
pub fn resolve_flow_path(
    project_root: &Path,
    relative: &str,
    must_exist: bool,
) -> Result<PathBuf, PathProblem> {
    let name_ok = Path::new(relative)
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(FlowFormat::from_file_name)
        .is_some();
    if !name_ok {
        return Err(PathProblem::Outside("bad-file-name"));
    }
    if must_exist {
        return resolve_in_project(project_root, project_root, relative);
    }
    let rel = Path::new(relative);
    if rel.is_absolute()
        || rel.has_root()
        || rel.components().any(|c| matches!(c, Component::Prefix(_)))
    {
        return Err(PathProblem::Outside("absolute"));
    }
    let root = normalize(project_root);
    let target = normalize(&root.join(rel));
    let inner = target
        .strip_prefix(&root)
        .map_err(|_| PathProblem::Outside("outside-root"))?;
    let mut current = root.clone();
    for component in inner.components() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(PathProblem::Outside("link")),
            _ => {}
        }
    }
    Ok(target)
}

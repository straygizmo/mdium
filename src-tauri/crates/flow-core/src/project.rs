//! The project manifest `.mdium/project.yaml` (spec 2026-10-10, chapter 2):
//! runtimes, setup steps, secret names, flow roles and metrics. Parsed and
//! validated like flow files: unknown top-level keys warn, unknown nested
//! attributes are errors, paths stay inside the project.

use crate::issues::*;
use crate::load::MAX_FLOW_FILE_BYTES;
use crate::parse::{check_keys, parse_text, FlowFormat};
use crate::template::{has_template, is_ident};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path};

pub const PROJECT_FILE: &str = ".mdium/project.yaml";
pub const PROJECT_SCHEMA_VERSION: u32 = 1;

const TOP_LEVEL_KEYS: &[&str] = &[
    "schemaVersion",
    "id",
    "name",
    "description",
    "runtimes",
    "setup",
    "secrets",
    "flows",
    "metrics",
];
const RUNTIME_KEYS: &[&str] = &["kind", "python", "module", "cwd", "env"];
const SETUP_KEYS: &[&str] = &["run", "workingDir"];
const METRIC_KEYS: &[&str] = &["ref", "better"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDef {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub runtimes: BTreeMap<String, RuntimeDef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setup: Vec<SetupStep>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secrets: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub flows: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub metrics: Vec<MetricDef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Python,
}

/// One interpreter path or OS-specific candidates (the first that exists wins).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PythonPath {
    One(String),
    Candidates(Vec<String>),
}

impl PythonPath {
    pub fn candidates(&self) -> Vec<String> {
        match self {
            PythonPath::One(p) => vec![p.clone()],
            PythonPath::Candidates(ps) => ps.clone(),
        }
    }
}

fn default_cwd() -> String {
    ".".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDef {
    pub kind: RuntimeKind,
    pub python: PythonPath,
    pub module: String,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStep {
    pub run: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Better {
    Higher,
    Lower,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricDef {
    #[serde(rename = "ref")]
    pub reference: String,
    pub better: Better,
}

/// A checked manifest, as returned to the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReport {
    pub project: Option<ProjectDef>,
    pub errors: Vec<FlowIssue>,
    pub warnings: Vec<FlowIssue>,
}

impl ProjectReport {
    fn from_issues(project: Option<ProjectDef>, issues: Issues) -> Self {
        Self {
            project,
            errors: issues.errors,
            warnings: issues.warnings,
        }
    }
}

/// Parses, decodes and validates manifest text (no file system).
pub fn check_project_text(text: &str) -> ProjectReport {
    let mut issues = Issues::default();
    let value = match parse_text(text, FlowFormat::Yaml) {
        Ok(value) => value,
        Err(issue) => {
            issues.error(issue);
            return ProjectReport::from_issues(None, issues);
        }
    };
    let Some(root) = value.as_object() else {
        issues.error(FlowIssue::new(FLOW_INVALID_VALUE, "").with("reason", "not-an-object"));
        return ProjectReport::from_issues(None, issues);
    };
    match root.get("schemaVersion").and_then(Value::as_u64) {
        Some(v) if v == u64::from(PROJECT_SCHEMA_VERSION) => {}
        _ => {
            issues.error(
                FlowIssue::new(FLOW_SCHEMA_UNSUPPORTED, "schemaVersion")
                    .with(
                        "found",
                        root.get("schemaVersion").cloned().unwrap_or(Value::Null),
                    )
                    .with("supported", PROJECT_SCHEMA_VERSION),
            );
            return ProjectReport::from_issues(None, issues);
        }
    }
    for key in root.keys() {
        if !TOP_LEVEL_KEYS.contains(&key.as_str()) {
            issues.warn(FlowIssue::new(FLOW_UNKNOWN_KEY, key.clone()).with("key", key.clone()));
        }
    }
    if let Some(runtimes) = root.get("runtimes").and_then(Value::as_object) {
        for (name, def) in runtimes {
            check_keys(def, &format!("runtimes.{name}"), RUNTIME_KEYS, &mut issues);
        }
    }
    if let Some(steps) = root.get("setup").and_then(Value::as_array) {
        for (i, step) in steps.iter().enumerate() {
            check_keys(step, &format!("setup[{i}]"), SETUP_KEYS, &mut issues);
        }
    }
    if let Some(metrics) = root.get("metrics").and_then(Value::as_array) {
        for (i, metric) in metrics.iter().enumerate() {
            check_keys(metric, &format!("metrics[{i}]"), METRIC_KEYS, &mut issues);
        }
    }
    if issues.has_errors() {
        return ProjectReport::from_issues(None, issues);
    }
    let known: serde_json::Map<String, Value> = root
        .iter()
        .filter(|(k, _)| TOP_LEVEL_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let project: ProjectDef = match serde_json::from_value(Value::Object(known)) {
        Ok(p) => p,
        Err(err) => {
            issues.error(
                FlowIssue::new(FLOW_INVALID_VALUE, "")
                    .with("reason", "decode")
                    .with("message", err.to_string()),
            );
            return ProjectReport::from_issues(None, issues);
        }
    };
    issues.extend(validate_project(&project));
    if issues.has_errors() {
        return ProjectReport::from_issues(None, issues);
    }
    ProjectReport::from_issues(Some(project), issues)
}

fn is_project_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_uppercase() || c == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn is_module_name(name: &str) -> bool {
    !name.is_empty()
        && name.split('.').all(|part| {
            let mut chars = part.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

/// True when `relative` is a relative path that never climbs above its start.
pub fn inside_root(relative: &str) -> bool {
    if relative.is_empty() {
        return false;
    }
    let mut depth: i64 = 0;
    for component in Path::new(relative).components() {
        match component {
            Component::Prefix(_) | Component::RootDir => return false,
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
        }
    }
    true
}

fn invalid(path: impl Into<String>, reason: &str) -> FlowIssue {
    FlowIssue::new(FLOW_INVALID_VALUE, path).with("reason", reason)
}

fn outside(path: impl Into<String>, value: &str) -> FlowIssue {
    FlowIssue::new(FLOW_PATH_OUTSIDE_PROJECT, path).with("path", value)
}

/// Semantic checks of a decoded manifest.
pub fn validate_project(project: &ProjectDef) -> Issues {
    let mut issues = Issues::default();
    if !is_project_id(&project.id) {
        issues.error(FlowIssue::new(FLOW_INVALID_ID, "id").with("name", project.id.clone()));
    }
    if project.name.trim().is_empty() {
        issues.error(invalid("name", "empty"));
    }
    for (name, rt) in &project.runtimes {
        let path = format!("runtimes.{name}");
        if !is_ident(name) {
            issues.error(FlowIssue::new(FLOW_INVALID_ID, &path).with("name", name.clone()));
        }
        let candidates = rt.python.candidates();
        if candidates.is_empty() {
            issues.error(invalid(format!("{path}.python"), "empty"));
        }
        for (i, candidate) in candidates.iter().enumerate() {
            let p = format!("{path}.python[{i}]");
            if has_template(candidate) {
                issues.error(invalid(&p, "template-not-allowed"));
            } else if !inside_root(candidate) {
                issues.error(outside(&p, candidate));
            }
        }
        if !is_module_name(&rt.module) {
            issues.error(invalid(format!("{path}.module"), "bad-module-name"));
        }
        if has_template(&rt.module) {
            issues.error(invalid(format!("{path}.module"), "template-not-allowed"));
        }
        if !inside_root(&rt.cwd) {
            issues.error(outside(format!("{path}.cwd"), &rt.cwd));
        }
        for key in rt.env.keys() {
            if !is_env_name(key) {
                issues.error(
                    FlowIssue::new(FLOW_INVALID_ID, format!("{path}.env.{key}"))
                        .with("name", key.clone()),
                );
            }
        }
    }
    for (i, step) in project.setup.iter().enumerate() {
        let path = format!("setup[{i}]");
        if step.run.is_empty() {
            issues.error(invalid(format!("{path}.run"), "empty"));
        }
        for (j, arg) in step.run.iter().enumerate() {
            if has_template(arg) {
                issues.error(invalid(format!("{path}.run[{j}]"), "template-not-allowed"));
            }
        }
        if let Some(dir) = &step.working_dir {
            if !inside_root(dir) {
                issues.error(outside(format!("{path}.workingDir"), dir));
            }
        }
    }
    for (i, name) in project.secrets.iter().enumerate() {
        if !is_env_name(name) {
            issues.error(
                FlowIssue::new(FLOW_INVALID_ID, format!("secrets[{i}]")).with("name", name.clone()),
            );
        }
    }
    for (role, file) in &project.flows {
        let path = format!("flows.{role}");
        if !is_ident(role) {
            issues.error(FlowIssue::new(FLOW_INVALID_ID, &path).with("name", role.clone()));
        }
        let is_flow_name = file
            .rsplit('/')
            .next()
            .and_then(FlowFormat::from_file_name)
            .is_some();
        if !is_flow_name {
            issues.error(invalid(&path, "bad-file-name"));
        } else if !inside_root(file) {
            issues.error(outside(&path, file));
        }
    }
    for (i, metric) in project.metrics.iter().enumerate() {
        let path = format!("metrics[{i}].ref");
        let ok = metric.reference == "costUsd"
            || metric
                .reference
                .strip_prefix("outputs.")
                .is_some_and(is_ident);
        if !ok {
            issues.error(invalid(&path, "bad-metric-ref"));
        }
    }
    issues
}

/// Project-relative flow display paths (`.mdium/<value>`, `/` separators) → role.
pub fn flow_roles(project: &ProjectDef) -> BTreeMap<String, String> {
    project
        .flows
        .iter()
        .map(|(role, file)| {
            let display = format!(
                ".mdium/{}",
                file.trim_start_matches("./").replace('\\', "/")
            );
            (display, role.clone())
        })
        .collect()
}

/// Reads `<root>/.mdium/project.yaml`; `None` when it does not exist.
pub fn load_project(project_root: &Path) -> Option<ProjectReport> {
    let file = project_root.join(PROJECT_FILE);
    for probe in [project_root.join(".mdium"), file.clone()] {
        match std::fs::symlink_metadata(&probe) {
            Ok(meta) if meta.file_type().is_symlink() => return None,
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    let mut issues = Issues::default();
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(err) => {
            issues.error(FlowIssue::new(FLOW_PARSE_FAILED, "").with("message", err.to_string()));
            return Some(ProjectReport::from_issues(None, issues));
        }
    };
    if bytes.len() as u64 > MAX_FLOW_FILE_BYTES {
        issues.error(
            FlowIssue::new(FLOW_FILE_TOO_LARGE, "")
                .with("size", bytes.len())
                .with("limit", MAX_FLOW_FILE_BYTES),
        );
        return Some(ProjectReport::from_issues(None, issues));
    }
    let Ok(text) = String::from_utf8(bytes) else {
        issues.error(
            FlowIssue::new(FLOW_PARSE_FAILED, "").with("message", "file is not valid UTF-8"),
        );
        return Some(ProjectReport::from_issues(None, issues));
    };
    Some(check_project_text(&text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/projects")
    }

    fn codes(issues: &[FlowIssue]) -> Vec<String> {
        let mut c: Vec<String> = issues.iter().map(|i| i.code.clone()).collect();
        c.sort();
        c
    }

    #[test]
    fn valid_fixtures_decode_without_issues() {
        for name in ["video-gen.project.yaml", "minimal.project.yaml"] {
            let text = fs::read_to_string(fixtures().join("valid").join(name)).unwrap();
            let report = check_project_text(&text);
            assert!(report.errors.is_empty(), "{name}: {:#?}", report.errors);
            assert!(report.warnings.is_empty(), "{name}: {:#?}", report.warnings);
            assert!(report.project.is_some(), "{name}");
        }
        let text = fs::read_to_string(fixtures().join("valid/video-gen.project.yaml")).unwrap();
        let project = check_project_text(&text).project.unwrap();
        assert_eq!(project.id, "video-gen");
        let rt = &project.runtimes["video_gen"];
        assert_eq!(rt.kind, RuntimeKind::Python);
        assert_eq!(
            rt.python.candidates(),
            vec![".venv/Scripts/python.exe", ".venv/bin/python"]
        );
        assert_eq!(rt.module, "video_gen_flow");
        assert_eq!(rt.cwd, ".");
        assert_eq!(project.setup[0].run, vec!["uv", "sync"]);
        assert_eq!(project.secrets, vec!["GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]);
        assert_eq!(project.metrics[2].reference, "costUsd");
        assert_eq!(project.metrics[2].better, Better::Lower);
        assert_eq!(
            flow_roles(&project),
            std::collections::BTreeMap::from([
                (
                    ".mdium/flows/production-cycle.flow.yaml".to_string(),
                    "main".to_string()
                ),
                (
                    ".mdium/flows/improve.flow.yaml".to_string(),
                    "improve".to_string()
                ),
            ])
        );
    }

    #[test]
    fn minimal_manifest_has_defaults() {
        let text = fs::read_to_string(fixtures().join("valid/minimal.project.yaml")).unwrap();
        let project = check_project_text(&text).project.unwrap();
        assert!(
            project.runtimes.is_empty() && project.setup.is_empty() && project.secrets.is_empty()
        );
        assert!(project.flows.is_empty() && project.metrics.is_empty());
    }

    #[test]
    fn invalid_fixtures_report_exactly_their_error() {
        let cases = [
            ("schema", FLOW_SCHEMA_UNSUPPORTED),
            ("bad-id", FLOW_INVALID_ID),
            ("runtime-outside", FLOW_PATH_OUTSIDE_PROJECT),
            ("runtime-unknown-field", FLOW_UNKNOWN_FIELD),
            ("setup-empty", FLOW_INVALID_VALUE),
            ("setup-templated", FLOW_INVALID_VALUE),
            ("metric-bad-ref", FLOW_INVALID_VALUE),
            ("flows-bad-name", FLOW_INVALID_VALUE),
            ("secret-bad-name", FLOW_INVALID_ID),
        ];
        let dir = fixtures().join("invalid");
        let mut seen = 0;
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let stem = path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .trim_end_matches(".project.yaml")
                .to_string();
            let (_, expected) = cases
                .iter()
                .find(|(n, _)| *n == stem)
                .unwrap_or_else(|| panic!("{stem} has no expectation"));
            let report = check_project_text(&fs::read_to_string(&path).unwrap());
            assert_eq!(
                codes(&report.errors),
                vec![expected.to_string()],
                "{stem}: {:#?}",
                report.errors
            );
            assert!(report.project.is_none(), "{stem}");
            seen += 1;
        }
        assert_eq!(seen, cases.len());
    }

    #[test]
    fn unknown_top_level_key_is_a_warning() {
        let text =
            fs::read_to_string(fixtures().join("warnings/unknown-key.project.yaml")).unwrap();
        let report = check_project_text(&text);
        assert!(report.errors.is_empty());
        assert_eq!(codes(&report.warnings), vec![FLOW_UNKNOWN_KEY]);
        assert!(report.project.is_some());
    }

    #[test]
    fn python_candidates_need_not_exist_yet() {
        // Review Focus 3: existence is setup's job, not validation's.
        let report = check_project_text(
            "schemaVersion: 1\nid: x\nname: X\nruntimes:\n  r: { kind: python, python: [.venv/Scripts/python.exe, .venv/bin/python], module: m }\n",
        );
        assert!(report.errors.is_empty(), "{:#?}", report.errors);
    }

    #[test]
    fn load_project_distinguishes_missing_from_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(load_project(tmp.path()).is_none());
        fs::create_dir_all(tmp.path().join(".mdium")).unwrap();
        fs::write(
            tmp.path().join(PROJECT_FILE),
            "schemaVersion: 1\nid: x\nname: X\n",
        )
        .unwrap();
        let report = load_project(tmp.path()).unwrap();
        assert!(report.errors.is_empty() && report.project.is_some());
        fs::write(tmp.path().join(PROJECT_FILE), "{ not yaml").unwrap();
        let report = load_project(tmp.path()).unwrap();
        assert_eq!(codes(&report.errors), vec![FLOW_PARSE_FAILED]);
    }

    #[test]
    fn inside_root_rejects_escapes_and_absolute_paths() {
        assert!(inside_root(".venv/bin/python"));
        assert!(inside_root("./a/../b"));
        assert!(inside_root("."));
        assert!(!inside_root("../x"));
        assert!(!inside_root("a/../../x"));
        assert!(!inside_root("/abs"));
        assert!(!inside_root("C:\\abs"));
        assert!(!inside_root(""));
    }
}

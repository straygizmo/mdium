//! Built-in flow templates shipped with MDium (`resources/flow-templates`).
//!
//! A flow references a template as `mdium:<name>` (a sub-flow's `flow`, a
//! file loop body). Each template is a directory `<dir>/<name>/` with a
//! `project.yaml` whose `flows.main` names the template's flow file
//! (relative to the template directory). Parts of a template live under
//! `<main dir>/lib/<name>/` and are referenced from the main flow as
//! `lib/<name>/...`, so a copy into a project keeps the references working.
//!
//! A template may carry translations: `<dir>/<name>/locales/<language>/`
//! mirrors the flow files (the main flow and its parts) with the texts the
//! user sees (`name`, `description`, approval messages, comments) in that
//! language; the structure is identical. The process-wide language (the UI
//! language, set by the app) picks the mirror when one exists, else the
//! default (English) files are used, for resolution and for copies alike.
//!
//! The templates directory is process-wide: the app sets it at startup from
//! its resource directory; until then no template resolves.

use crate::issues::*;
use crate::load::{resolve_flow_path, resolve_in_project, FLOWS_DIR, MAX_FLOW_FILE_BYTES};
use crate::model::{FlowDef, FlowNode, LoopBody, NodeKind};
use crate::parse::FlowFormat;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// Prefix of a template reference.
pub const TEMPLATE_PREFIX: &str = "mdium:";
/// The manifest file of a template directory.
pub const TEMPLATE_MANIFEST: &str = "project.yaml";

/// The directory of a template's translations (`<template>/locales/<language>/`).
pub const LOCALES_DIR: &str = "locales";
/// The language of the default template files.
pub const DEFAULT_LANGUAGE: &str = "en";

static DIR: RwLock<Option<PathBuf>> = RwLock::new(None);
static LANGUAGE: RwLock<String> = RwLock::new(String::new());

/// Process-wide templates directory (`resources/flow-templates`); `None` until the app sets it.
pub fn set_dir(dir: PathBuf) {
    *DIR.write().unwrap_or_else(|e| e.into_inner()) = Some(dir);
}

pub fn dir() -> Option<PathBuf> {
    DIR.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Process-wide language of the templates (the UI language); the default
/// files serve a language without a mirror.
pub fn set_language(language: &str) {
    *LANGUAGE.write().unwrap_or_else(|e| e.into_inner()) = language.trim().to_string();
}

/// The current language (`DEFAULT_LANGUAGE` until the app sets one).
pub fn language() -> String {
    let current = LANGUAGE.read().unwrap_or_else(|e| e.into_inner());
    if current.is_empty() {
        DEFAULT_LANGUAGE.to_string()
    } else {
        current.clone()
    }
}

/// The translations directory of `root` for `language`, when one exists.
/// Only a plain tag (letters, digits and `-`, like `ja` or `pt-br`) is looked up.
fn locale_dir(root: &Path, language: &str) -> Option<PathBuf> {
    let tag = language.trim();
    let well_formed = !tag.is_empty()
        && tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !tag.starts_with('-');
    if !well_formed || tag == DEFAULT_LANGUAGE {
        return None;
    }
    let dir = root.join(LOCALES_DIR).join(tag);
    dir.is_dir().then_some(dir)
}

/// A resolved template reference.
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateRef {
    pub name: String,
    /// The template directory.
    pub root: PathBuf,
    /// The absolute path of the template's main flow file.
    pub main: PathBuf,
    /// `mdium:<name>`: how the template appears in bundles and run snapshots.
    pub display: String,
}

/// A template as listed for "new flow from template".
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub name: String,
    pub title: String,
    pub description: String,
    /// The main flow file, relative to the template directory (`flows/...`).
    pub main: String,
}

/// True when `reference` names a built-in template (`mdium:...`).
pub fn is_template_ref(reference: &str) -> bool {
    reference.starts_with(TEMPLATE_PREFIX)
}

/// True for `mdium:<name>` with a well-formed name (lowercase letters,
/// digits and `-`, not starting with `-`).
pub fn is_valid_ref(reference: &str) -> bool {
    reference
        .strip_prefix(TEMPLATE_PREFIX)
        .is_some_and(is_template_name)
}

fn is_template_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
}

fn unknown(name: &str, reason: &str) -> FlowIssue {
    FlowIssue::new(FLOW_TEMPLATE_UNKNOWN, "")
        .with("template", name)
        .with("reason", reason)
}

/// Reads and validates `<root>/project.yaml`.
fn read_manifest(name: &str, root: &Path) -> Result<crate::project::ProjectDef, FlowIssue> {
    let file = root.join(TEMPLATE_MANIFEST);
    let too_large = std::fs::metadata(&file)
        .map(|m| m.len() > MAX_FLOW_FILE_BYTES)
        .map_err(|_| unknown(name, "no-manifest"))?;
    if too_large {
        return Err(unknown(name, "bad-manifest"));
    }
    let text = std::fs::read_to_string(&file).map_err(|_| unknown(name, "no-manifest"))?;
    let report = crate::project::check_project_text(&text);
    match report.project {
        Some(project) if report.errors.is_empty() => Ok(project),
        _ => Err(unknown(name, "bad-manifest")),
    }
}

/// Resolves `mdium:<name>` to the template's directory and main flow file
/// in the process-wide language.
pub fn resolve(reference: &str) -> Result<TemplateRef, FlowIssue> {
    resolve_localized(reference, &language())
}

/// Resolves `mdium:<name>` with the files of `language`: the main flow of
/// its `locales/<language>/` mirror when the mirror has one, else the default.
pub fn resolve_localized(reference: &str, language: &str) -> Result<TemplateRef, FlowIssue> {
    let name = reference.strip_prefix(TEMPLATE_PREFIX).unwrap_or(reference);
    if !is_template_ref(reference) || !is_template_name(name) {
        return Err(unknown(name, "bad-name"));
    }
    let dir = dir().ok_or_else(|| unknown(name, "no-templates"))?;
    let root = dir.join(name);
    if !root.is_dir() {
        return Err(unknown(name, "not-found"));
    }
    let project = read_manifest(name, &root)?;
    let main_rel = project
        .flows
        .get("main")
        .ok_or_else(|| unknown(name, "no-main-flow"))?;
    let main = resolve_in_project(&root, &root, main_rel)
        .map_err(|_| unknown(name, "main-flow-missing"))?;
    // A mirror without the main flow serves the default file.
    let main = locale_dir(&root, language)
        .and_then(|dir| resolve_in_project(&root, &dir, main_rel).ok())
        .filter(|file| file.is_file())
        .unwrap_or(main);
    Ok(TemplateRef {
        name: name.to_string(),
        root,
        main,
        display: format!("{TEMPLATE_PREFIX}{name}"),
    })
}

/// The templates of the templates directory, by name.
pub fn list() -> Vec<TemplateInfo> {
    let Some(dir) = dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<TemplateInfo> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let template = resolve(&format!("{TEMPLATE_PREFIX}{name}")).ok()?;
            let project = read_manifest(&name, &template.root).ok()?;
            Some(TemplateInfo {
                main: project.flows.get("main").cloned().unwrap_or_default(),
                title: project.name,
                description: project.description.unwrap_or_default(),
                name,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The flow-file suffix of `file` (`.flow.yaml`, `.flow.yml`, `.flow.json`).
fn flow_suffix(file: &Path) -> &'static str {
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
    match FlowFormat::from_file_name(name) {
        Some(FlowFormat::Json) => ".flow.json",
        _ if name.ends_with(".flow.yml") => ".flow.yml",
        _ => ".flow.yaml",
    }
}

/// Flow files under `dir`, recursively (links skipped).
fn collect_flow_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_dir() {
            collect_flow_files(&entry.path(), out);
        } else if file_type.is_file() && FlowFormat::from_file_name(&name).is_some() {
            out.push(entry.path());
        }
    }
}

fn exists_issue(path: &str) -> FlowIssue {
    FlowIssue::new(FLOW_INVALID_VALUE, "")
        .with("reason", "exists")
        .with("path", path)
}

/// Copies the template's flow files (in the process-wide language) into
/// `<project>/.mdium/flows/`: the main flow as `<file_name>.flow.yaml`, parts
/// under `lib/<template>/...`. Refuses to overwrite. Returns the written
/// project-relative paths, the main flow first.
pub fn copy_into(project_root: &Path, name: &str, file_name: &str) -> Result<Vec<String>, FlowIssue> {
    copy_into_localized(project_root, name, file_name, &language())
}

/// [`copy_into`] with the files of `language` (see [`resolve_localized`]).
pub fn copy_into_localized(
    project_root: &Path,
    name: &str,
    file_name: &str,
    language: &str,
) -> Result<Vec<String>, FlowIssue> {
    if !is_template_name(file_name) {
        return Err(FlowIssue::new(FLOW_INVALID_ID, "fileName").with("name", file_name));
    }
    let template = resolve_localized(&format!("{TEMPLATE_PREFIX}{name}"), language)?;
    let main_dir = template.main.parent().unwrap_or(&template.root).to_path_buf();
    // (source, project-relative destination)
    let mut plan = vec![(
        template.main.clone(),
        format!("{FLOWS_DIR}/{file_name}{}", flow_suffix(&template.main)),
    )];
    let parts_dir = main_dir.join("lib").join(&template.name);
    let mut parts = Vec::new();
    collect_flow_files(&parts_dir, &mut parts);
    parts.sort();
    for part in parts {
        let rel = crate::load::relative_display(&main_dir, &part);
        plan.push((part, format!("{FLOWS_DIR}/{rel}")));
    }
    let mut targets = Vec::new();
    for (_, rel) in &plan {
        let target = resolve_flow_path(project_root, rel, false).map_err(|_| {
            FlowIssue::new(FLOW_PATH_OUTSIDE_PROJECT, "fileName").with("ref", rel.clone())
        })?;
        if target.exists() {
            return Err(exists_issue(rel));
        }
        targets.push(target);
    }
    let mut written = Vec::new();
    for (i, ((source, rel), target)) in plan.iter().zip(&targets).enumerate() {
        let mut bytes = std::fs::read(source).map_err(|e| {
            FlowIssue::new(FLOW_REF_NOT_FOUND, "").with("message", e.to_string())
        })?;
        if i == 0 {
            // The copy's id follows its file name, so two copies never share an id.
            bytes = with_flow_id(&bytes, file_name);
        }
        crate::fsutil::atomic_write(target, &bytes).map_err(|e| {
            FlowIssue::new(FLOW_INVALID_VALUE, "")
                .with("reason", "write-failed")
                .with("message", e.to_string())
        })?;
        written.push(rel.clone());
    }
    Ok(written)
}

/// Rewrites the top-level `id` of a flow file's text to `id`: the `id:` line
/// of YAML (the rest is kept as written), or the `id` key of JSON.
fn with_flow_id(bytes: &[u8], id: &str) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    if text.trim_start().starts_with('{') {
        return match serde_json::from_str::<serde_json::Value>(text) {
            Ok(mut value) => {
                value["id"] = serde_json::Value::String(id.to_string());
                serde_json::to_vec_pretty(&value).unwrap_or_else(|_| bytes.to_vec())
            }
            Err(_) => bytes.to_vec(),
        };
    }
    let mut done = false;
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            if !done && line.starts_with("id:") {
                done = true;
                let cr = if line.ends_with('\r') { "\r" } else { "" };
                format!("id: {id}{cr}")
            } else {
                line.to_string()
            }
        })
        .collect();
    lines.join("\n").into_bytes()
}

/// What a template flow may not contain: `command` / `python` nodes (they
/// would run code the user never reviewed in their project) and prompt files
/// (`promptRef` other than `builtin:`). Inline loop bodies are included.
pub fn check_template_flow(flow: &FlowDef) -> Vec<FlowIssue> {
    let mut out = Vec::new();
    check_nodes(&flow.nodes, "", &mut out);
    out
}

fn check_nodes(nodes: &[FlowNode], path: &str, out: &mut Vec<FlowIssue>) {
    for (i, node) in nodes.iter().enumerate() {
        let node_path = if path.is_empty() {
            format!("nodes[{i}]")
        } else {
            format!("{path}.nodes[{i}]")
        };
        let refused = |reason: &str| {
            FlowIssue::new(FLOW_SUBFLOW_INVALID, node_path.clone())
                .with("reason", reason)
                .with("node", node.id.clone())
        };
        match &node.kind {
            NodeKind::Command(_) => out.push(refused("template-command")),
            NodeKind::Python(_) => out.push(refused("template-python")),
            NodeKind::Agent(agent) => {
                if agent
                    .prompt_ref
                    .as_deref()
                    .is_some_and(|r| !r.starts_with("builtin:"))
                {
                    out.push(refused("template-prompt-ref"));
                }
            }
            NodeKind::Loop(lp) => {
                if let LoopBody::Inline(body) = &lp.body {
                    check_nodes(&body.nodes, &format!("{node_path}.body"), out);
                }
            }
            _ => {}
        }
    }
}

/// Points the templates directory at the repository's `resources/flow-templates`
/// (the shipped templates are the tests' fixture).
#[cfg(test)]
pub(crate) fn test_templates() {
    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        set_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../resources/flow-templates"),
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_and_lists_the_bundled_templates() {
        test_templates();
        let t = resolve("mdium:dev-workflow").unwrap();
        assert_eq!(t.display, "mdium:dev-workflow");
        assert!(t.main.ends_with("flows/dev-workflow.flow.yaml") && t.main.is_file());
        assert_eq!(resolve("mdium:nope").unwrap_err().code, FLOW_TEMPLATE_UNKNOWN);
        assert_eq!(resolve("mdium:Bad Name").unwrap_err().code, FLOW_TEMPLATE_UNKNOWN);
        assert!(list().iter().any(|t| t.name == "dev-workflow" && t.main == "flows/dev-workflow.flow.yaml"));
        let tmp = tempfile::tempdir().unwrap();
        let written = copy_into(tmp.path(), "dev-workflow", "develop").unwrap();
        assert_eq!(written, vec![".mdium/flows/develop.flow.yaml".to_string()]);
        // The copy's id follows the file name; the rest of the file is kept.
        let copied = std::fs::read_to_string(tmp.path().join(".mdium/flows/develop.flow.yaml")).unwrap();
        let report = crate::load::check_content(tmp.path(), &tmp.path().join(".mdium/flows/develop.flow.yaml"), &copied);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.flow.unwrap().id, "develop");
        let original = std::fs::read_to_string(&t.main).unwrap();
        assert_eq!(copied.replace("id: develop", "id: dev-workflow"), original);
        assert_eq!(copy_into(tmp.path(), "dev-workflow", "develop").unwrap_err().code, FLOW_INVALID_VALUE);
        // improve-app: the main flow plus its parts under lib/improve-app/.
        let improve = resolve("mdium:improve-app").unwrap();
        assert!(list().iter().any(|t| t.name == "improve-app" && t.main == "flows/improve-app.flow.yaml"));
        let written = copy_into(tmp.path(), "improve-app", "improve").unwrap();
        assert_eq!(
            written,
            vec![
                ".mdium/flows/improve.flow.yaml".to_string(),
                ".mdium/flows/lib/improve-app/improve-propose.flow.yaml".to_string(),
                ".mdium/flows/lib/improve-app/improve-verify.flow.yaml".to_string(),
            ]
        );
        let copied = std::fs::read_to_string(tmp.path().join(".mdium/flows/improve.flow.yaml")).unwrap();
        let mut lines = copied.lines();
        assert!(lines.next().unwrap().starts_with("schemaVersion:"));
        assert_eq!(lines.next().unwrap(), "id: improve");
        let original = std::fs::read_to_string(&improve.main).unwrap();
        assert_eq!(copied.replacen("id: improve", "id: improve-app", 1), original);
        let main_dir = improve.main.parent().unwrap();
        for part in ["improve-propose.flow.yaml", "improve-verify.flow.yaml"] {
            let copied = std::fs::read(tmp.path().join(".mdium/flows/lib/improve-app").join(part)).unwrap();
            let original = std::fs::read(main_dir.join("lib/improve-app").join(part)).unwrap();
            assert_eq!(copied, original, "{part}");
        }
        // The verify part runs `project:main` without params, so the copy checks
        // clean in a project whose main flow needs none.
        std::fs::write(tmp.path().join(".mdium/flows/main.flow.yaml"), "schemaVersion: 1\nid: main\nname: Main\nnodes:\n  - { id: ok, kind: approval }\n").unwrap();
        std::fs::write(tmp.path().join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nflows:\n  main: flows/main.flow.yaml\n").unwrap();
        let report = crate::load::check_content(tmp.path(), &tmp.path().join(".mdium/flows/improve.flow.yaml"), &copied);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.flow.unwrap().id, "improve");
    }

    #[test]
    fn the_language_picks_the_localized_template_files() {
        test_templates();
        let en = resolve_localized("mdium:dev-workflow", "en").unwrap();
        assert!(en.main.ends_with("dev-workflow/flows/dev-workflow.flow.yaml"), "{}", en.main.display());
        let ja = resolve_localized("mdium:dev-workflow", "ja").unwrap();
        assert!(
            ja.main.ends_with("dev-workflow/locales/ja/flows/dev-workflow.flow.yaml"),
            "{}",
            ja.main.display()
        );
        assert_eq!(ja.root, en.root);
        assert_eq!(ja.display, "mdium:dev-workflow");
        // A language without a mirror, or an ill-formed tag, falls back to the default files.
        for lang in ["xx", "", "../ja", "ja/..", "JA_JP"] {
            assert_eq!(resolve_localized("mdium:dev-workflow", lang).unwrap().main, en.main, "{lang:?}");
        }
        // The process-wide language (English until the app sets it) drives
        // `resolve` and `copy_into`; tests never switch it, since they run in
        // parallel and the bundled files are their fixture.
        assert_eq!(language(), "en");
        assert_eq!(resolve("mdium:dev-workflow").unwrap().main, en.main);
    }

    /// Removes the user-facing texts (`name`, `description`, approval `message`)
    /// so the two language versions of a flow can be compared structurally.
    fn structure(flow: &FlowDef) -> serde_json::Value {
        fn strip(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::Object(map) => {
                    map.remove("message");
                    for child in map.values_mut() {
                        strip(child);
                    }
                }
                serde_json::Value::Array(items) => items.iter_mut().for_each(strip),
                _ => {}
            }
        }
        let mut value = serde_json::to_value(flow).unwrap();
        let map = value.as_object_mut().unwrap();
        map.remove("name");
        map.remove("description");
        strip(&mut value);
        value
    }

    #[test]
    fn every_template_has_a_japanese_mirror_with_the_same_structure() {
        test_templates();
        let templates = list();
        assert!(!templates.is_empty());
        for info in templates {
            let reference = format!("{TEMPLATE_PREFIX}{}", info.name);
            let en = resolve_localized(&reference, "en").unwrap();
            let ja = resolve_localized(&reference, "ja").unwrap();
            assert_ne!(en.main, ja.main, "{}: no ja mirror", info.name);
            let en_dir = en.main.parent().unwrap();
            let ja_dir = ja.main.parent().unwrap();
            let mut en_files = vec![en.main.clone()];
            collect_flow_files(&en_dir.join("lib").join(&info.name), &mut en_files);
            let mut ja_files = vec![ja.main.clone()];
            collect_flow_files(&ja_dir.join("lib").join(&info.name), &mut ja_files);
            assert_eq!(en_files.len(), ja_files.len(), "{}: the mirror has extra files", info.name);
            for en_file in en_files {
                let rel = crate::load::relative_display(en_dir, &en_file);
                let ja_file = ja_dir.join(&rel);
                assert!(ja_file.is_file(), "{}: {rel} has no ja mirror", info.name);
                let parse = |file: &Path| {
                    let text = std::fs::read_to_string(file).unwrap();
                    let (flow, issues) = crate::load::check_text(&text, FlowFormat::Yaml);
                    assert!(issues.errors.is_empty(), "{}: {:?}", file.display(), issues.errors);
                    flow.unwrap()
                };
                let en_flow = parse(&en_file);
                let ja_flow = parse(&ja_file);
                assert!(check_template_flow(&ja_flow).is_empty(), "{rel}");
                assert_eq!(structure(&en_flow), structure(&ja_flow), "{}: {rel} differs beyond its texts", info.name);
                // The texts the user sees are translated, not copied.
                assert_ne!(en_flow.name, ja_flow.name, "{rel}");
                assert_ne!(en_flow.description, ja_flow.description, "{rel}");
                for (en_node, ja_node) in en_flow.nodes.iter().zip(&ja_flow.nodes) {
                    if let (NodeKind::Approval(en_ap), NodeKind::Approval(ja_ap)) = (&en_node.kind, &ja_node.kind) {
                        assert_ne!(en_ap.message, ja_ap.message, "{rel}: {}", en_node.id);
                    }
                }
            }
        }
    }

    #[test]
    fn copy_uses_the_localized_files() {
        test_templates();
        let tmp = tempfile::tempdir().unwrap();
        let written = copy_into_localized(tmp.path(), "improve-app", "improve", "ja").unwrap();
        assert_eq!(
            written,
            vec![
                ".mdium/flows/improve.flow.yaml".to_string(),
                ".mdium/flows/lib/improve-app/improve-propose.flow.yaml".to_string(),
                ".mdium/flows/lib/improve-app/improve-verify.flow.yaml".to_string(),
            ]
        );
        let ja = resolve_localized("mdium:improve-app", "ja").unwrap();
        let copied = std::fs::read_to_string(tmp.path().join(".mdium/flows/improve.flow.yaml")).unwrap();
        let original = std::fs::read_to_string(&ja.main).unwrap();
        assert_eq!(copied.replacen("id: improve", "id: improve-app", 1), original);
        assert_eq!(copied.lines().nth(1), Some("id: improve"));
        let ja_dir = ja.main.parent().unwrap();
        for part in ["improve-propose.flow.yaml", "improve-verify.flow.yaml"] {
            let copied = std::fs::read(tmp.path().join(".mdium/flows/lib/improve-app").join(part)).unwrap();
            let original = std::fs::read(ja_dir.join("lib/improve-app").join(part)).unwrap();
            assert_eq!(copied, original, "{part}");
        }
        // The copy (its parts and its `mdium:dev-workflow` reference) checks clean.
        std::fs::write(tmp.path().join(".mdium/flows/main.flow.yaml"), "schemaVersion: 1\nid: main\nname: Main\nnodes:\n  - { id: ok, kind: approval }\n").unwrap();
        std::fs::write(tmp.path().join(".mdium/project.yaml"), "schemaVersion: 1\nid: p\nname: P\nflows:\n  main: flows/main.flow.yaml\n").unwrap();
        let report = crate::load::check_content(tmp.path(), &tmp.path().join(".mdium/flows/improve.flow.yaml"), &copied);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.flow.unwrap().name, "改善ループ");
    }

    #[test]
    fn copy_refuses_bad_file_names_and_unknown_templates() {
        test_templates();
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(copy_into(tmp.path(), "dev-workflow", "../x").unwrap_err().code, FLOW_INVALID_ID);
        assert_eq!(copy_into(tmp.path(), "nope", "x").unwrap_err().code, FLOW_TEMPLATE_UNKNOWN);
        assert!(!tmp.path().join(".mdium").exists());
    }

    #[test]
    fn template_flows_refuse_commands_python_and_prompt_files() {
        let flow = |yaml: &str| {
            let (flow, issues) = crate::load::check_text(
                &format!("schemaVersion: 1\nid: t\nname: T\n{yaml}"),
                FlowFormat::Yaml,
            );
            assert!(issues.errors.is_empty(), "{:?}", issues.errors);
            flow.unwrap()
        };
        let reasons = |flow: &FlowDef| -> Vec<String> {
            check_template_flow(flow)
                .iter()
                .map(|i| i.params["reason"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            reasons(&flow("nodes:\n  - { id: l, kind: loop, mode: foreach, items: [1], maxIterations: 3, body: { nodes: [{ id: c, kind: command, run: [echo] }] } }\n")),
            vec!["template-command"]
        );
        assert_eq!(
            reasons(&flow("nodes:\n  - { id: a, kind: agent, provider: claude, permission: read-only, promptRef: ./p.md }\n")),
            vec!["template-prompt-ref"]
        );
        assert!(reasons(&flow("nodes:\n  - { id: a, kind: agent, provider: claude, permission: read-only, promptRef: 'builtin:design' }\n")).is_empty());
    }

    #[test]
    fn the_improve_app_flows_pass_the_template_check() {
        test_templates();
        let main = resolve("mdium:improve-app").unwrap().main;
        let main_dir = main.parent().unwrap().to_path_buf();
        let files = [
            main,
            main_dir.join("lib/improve-app/improve-propose.flow.yaml"),
            main_dir.join("lib/improve-app/improve-verify.flow.yaml"),
        ];
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap();
            let (flow, issues) = crate::load::check_text(&text, FlowFormat::Yaml);
            assert!(issues.errors.is_empty(), "{}: {:?}", file.display(), issues.errors);
            let issues = check_template_flow(&flow.unwrap());
            assert!(issues.is_empty(), "{}: {issues:?}", file.display());
        }
    }
}

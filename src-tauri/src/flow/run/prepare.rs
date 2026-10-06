//! Checks done before a run starts: features this engine version runs,
//! command-safety rules, parameter values, the command list shown for
//! confirmation (spec 7.2), and the template resolver used while running.

use crate::flow::model::{CommandRun, FlowDef, NodeKind, ParamType};
use crate::flow::run::model::{Reason, RunState};
use crate::flow::template::{self, Reference};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// The flow uses something this engine version cannot run yet.
pub const FLOW_RUN_UNSUPPORTED: &str = "FLOW_RUN_UNSUPPORTED";
/// A template could change which program runs or inject shell syntax.
pub const FLOW_RUN_UNSAFE_TEMPLATE: &str = "FLOW_RUN_UNSAFE_TEMPLATE";
pub const FLOW_PARAM_UNKNOWN: &str = "FLOW_PARAM_UNKNOWN";
pub const FLOW_PARAM_MISSING: &str = "FLOW_PARAM_MISSING";
pub const FLOW_PARAM_INVALID: &str = "FLOW_PARAM_INVALID";

/// Problems that prevent this engine version from running `flow`
/// (node kinds and features owned by later PRs, unsafe templates).
pub fn check_runnable(flow: &FlowDef) -> Vec<Reason> {
    let mut problems = Vec::new();
    let unsupported = |path: String, feature: &str| {
        Reason::new(FLOW_RUN_UNSUPPORTED)
            .with("path", path)
            .with("feature", feature)
    };
    for (i, node) in flow.nodes.iter().enumerate() {
        let path = format!("nodes[{i}]");
        match &node.kind {
            NodeKind::Command(command) => match &command.run {
                CommandRun::Argv(argv) => {
                    if argv.first().is_some_and(|p| template::has_template(p)) {
                        problems.push(
                            Reason::new(FLOW_RUN_UNSAFE_TEMPLATE)
                                .with("path", format!("{path}.run[0]"))
                                .with("rule", "program-templated"),
                        );
                    }
                }
                CommandRun::Shell(text) => {
                    if template::has_template(text) {
                        problems.push(
                            Reason::new(FLOW_RUN_UNSAFE_TEMPLATE)
                                .with("path", format!("{path}.run"))
                                .with("rule", "shell-templated"),
                        );
                    }
                }
            },
            NodeKind::Approval(_) => {}
            other => problems.push(unsupported(path.clone(), other.name())),
        }
        if node.concurrency_key.is_some() {
            problems.push(unsupported(
                format!("{path}.concurrencyKey"),
                "concurrencyKey",
            ));
        }
    }
    for (i, edge) in flow.edges.iter().enumerate() {
        if edge.max_traversals.is_some() {
            problems.push(unsupported(format!("edges[{i}]"), "back-edge"));
        }
    }
    problems
}

/// Applies defaults and checks the arguments given at start.
pub fn prepare_params(
    flow: &FlowDef,
    given: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, Vec<Reason>> {
    let mut problems = Vec::new();
    for key in given.keys() {
        if !flow.params.contains_key(key) {
            problems.push(Reason::new(FLOW_PARAM_UNKNOWN).with("param", key.clone()));
        }
    }
    let mut out = BTreeMap::new();
    for (name, def) in &flow.params {
        let value = match given
            .get(name)
            .filter(|v| !v.is_null())
            .or(def.default.as_ref())
        {
            Some(value) => value.clone(),
            None if def.required => {
                problems.push(Reason::new(FLOW_PARAM_MISSING).with("param", name.clone()));
                continue;
            }
            None => continue,
        };
        let ok = match def.ty {
            ParamType::String | ParamType::Path => value.is_string(),
            ParamType::Number => value.is_number(),
            ParamType::Bool => value.is_boolean(),
        };
        if !ok {
            problems.push(Reason::new(FLOW_PARAM_INVALID).with("param", name.clone()));
            continue;
        }
        out.insert(name.clone(), value);
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(problems)
    }
}

/// One command as shown for confirmation: the unexpanded definition.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSummary {
    pub node_id: String,
    /// argv array or shell string, exactly as written (templates unexpanded).
    pub run: Value,
    pub shell: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    /// Environment variables the node sets (names and unexpanded values).
    pub env: BTreeMap<String, String>,
    /// True when any argument, the working directory or an env value is templated.
    pub templated: bool,
}

/// Every command a flow can run (spec 7.2).
pub fn command_summaries(flow: &FlowDef) -> Vec<CommandSummary> {
    let mut out = Vec::new();
    for node in &flow.nodes {
        if let NodeKind::Command(command) = &node.kind {
            let (run, mut templated) = match &command.run {
                CommandRun::Argv(argv) => (
                    Value::from(argv.clone()),
                    argv.iter().any(|a| template::has_template(a)),
                ),
                CommandRun::Shell(text) => {
                    (Value::from(text.clone()), template::has_template(text))
                }
            };
            let working_dir = command
                .working_dir
                .clone()
                .or_else(|| flow.defaults.working_dir.clone());
            templated |= working_dir.as_deref().is_some_and(template::has_template);
            let mut env = flow.env.clone();
            env.extend(command.env.clone());
            templated |= env.values().any(|v| template::has_template(v));
            out.push(CommandSummary {
                node_id: node.id.clone(),
                run,
                shell: command.shell,
                working_dir,
                env,
                templated,
            });
        }
    }
    out
}

/// Values available to templates while a node runs.
pub struct TemplateContext<'a> {
    pub params: &'a BTreeMap<String, Value>,
    pub state: &'a RunState,
    pub run_id: &'a str,
    pub run_dir: &'a Path,
    pub node_dir: Option<&'a Path>,
    pub project_root: &'a Path,
    /// Passthrough environment (`envPassthrough` names only).
    pub env: &'a BTreeMap<String, String>,
}

impl TemplateContext<'_> {
    pub fn resolve(&self, reference: &Reference) -> Option<Value> {
        let path = |p: &Path| Value::String(p.to_string_lossy().into_owned());
        match reference {
            Reference::Param(name) => self.params.get(name).cloned(),
            Reference::NodeOutput { node, key } => {
                self.state.nodes.get(node)?.outputs.get(key).cloned()
            }
            Reference::RunId => Some(Value::String(self.run_id.to_string())),
            Reference::RunDir => Some(path(self.run_dir)),
            Reference::NodeDir => self.node_dir.map(path),
            Reference::ProjectRoot => Some(path(self.project_root)),
            Reference::Env(name) => self.env.get(name).map(|v| Value::String(v.clone())),
            // Loop variables and `iteration` belong to loops (not run by this version).
            Reference::LoopVar(_) | Reference::Index | Reference::IterationOutput(_) => None,
        }
    }

    /// Renders a template to a string (non-string values as JSON).
    pub fn render_string(&self, text: &str) -> Result<String, Reason> {
        match template::render(text, &|r| self.resolve(r)) {
            Ok(Value::String(s)) => Ok(s),
            Ok(other) => Ok(other.to_string()),
            Err(template::RenderError::Unresolved(reference)) => {
                Err(Reason::new("FLOW_TEMPLATE_UNRESOLVED").with("ref", reference.to_string()))
            }
            Err(template::RenderError::Parse(err)) => {
                Err(Reason::new("FLOW_TEMPLATE_INVALID").with("reason", err.reason()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::load::check_text;
    use crate::flow::parse::FlowFormat;
    use serde_json::json;

    fn flow(yaml: &str) -> FlowDef {
        let (flow, issues) = check_text(
            &format!("schemaVersion: 1\nid: t\nname: T\n{yaml}"),
            FlowFormat::Yaml,
        );
        assert!(issues.errors.is_empty(), "{:#?}", issues.errors);
        flow.unwrap()
    }

    fn codes(reasons: &[Reason]) -> Vec<(String, String)> {
        reasons
            .iter()
            .map(|r| {
                (
                    r.code.clone(),
                    r.params
                        .get("path")
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn rejects_what_this_version_cannot_run() {
        let def = flow(
            "params: { p: { type: string } }\nnodes:\n  - { id: a, kind: agent, provider: claude, permission: read-only, prompt: x }\n  - { id: b, kind: command, run: ['${{ params.p }}'] }\n  - { id: c, kind: command, run: 'echo ${{ params.p }}', shell: true }\n  - { id: d, kind: command, run: [x, '${{ params.p }}'], concurrencyKey: k }\n  - { id: e, kind: approval }\nedges:\n  - { from: a, to: b }\n  - { from: b, to: c }\n  - { from: c, to: d }\n  - { from: d, to: e }\n  - { from: e, to: d, port: reject, maxTraversals: 2 }\n",
        );
        assert_eq!(
            codes(&check_runnable(&def)),
            vec![
                (FLOW_RUN_UNSUPPORTED.into(), "nodes[0]".into()),
                (FLOW_RUN_UNSAFE_TEMPLATE.into(), "nodes[1].run[0]".into()),
                (FLOW_RUN_UNSAFE_TEMPLATE.into(), "nodes[2].run".into()),
                (
                    FLOW_RUN_UNSUPPORTED.into(),
                    "nodes[3].concurrencyKey".into()
                ),
                (FLOW_RUN_UNSUPPORTED.into(), "edges[4]".into()),
            ]
        );
        let ok = flow("nodes:\n  - { id: a, kind: command, run: [x, '${{ run.id }}'] }\n  - { id: b, kind: approval }\n");
        assert!(check_runnable(&ok).is_empty());
    }

    #[test]
    fn params_get_defaults_and_are_checked() {
        let def = flow(
            "params:\n  dir: { type: path, required: true }\n  n: { type: number, default: 3 }\n  flag: { type: bool }\nnodes:\n  - { id: a, kind: approval }\n",
        );
        let given = BTreeMap::from([("dir".to_string(), json!("in"))]);
        assert_eq!(
            prepare_params(&def, &given).unwrap(),
            BTreeMap::from([
                ("dir".to_string(), json!("in")),
                ("n".to_string(), json!(3))
            ])
        );
        let bad = BTreeMap::from([
            ("n".to_string(), json!("three")),
            ("extra".to_string(), json!(1)),
        ]);
        let mut errors: Vec<String> = prepare_params(&def, &bad)
            .unwrap_err()
            .into_iter()
            .map(|r| r.code)
            .collect();
        errors.sort();
        assert_eq!(
            errors,
            vec![FLOW_PARAM_INVALID, FLOW_PARAM_MISSING, FLOW_PARAM_UNKNOWN]
        );
    }

    #[test]
    fn command_summaries_show_unexpanded_commands() {
        let def = flow(
            "env: { A: '1' }\ndefaults: { workingDir: '${{ project.root }}/sub' }\nnodes:\n  - { id: a, kind: command, run: [tool, build], env: { B: '${{ run.id }}' } }\n  - { id: b, kind: command, run: 'echo hi', shell: true }\n  - { id: c, kind: approval }\n",
        );
        let list = command_summaries(&def);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].run, json!(["tool", "build"]));
        assert_eq!(
            list[0].working_dir.as_deref(),
            Some("${{ project.root }}/sub")
        );
        assert_eq!(
            list[0].env,
            BTreeMap::from([
                ("A".into(), "1".into()),
                ("B".into(), "${{ run.id }}".into())
            ])
        );
        assert!(list[0].templated);
        assert_eq!(list[1].run, json!("echo hi"));
        assert!(list[1].shell);
    }

    #[test]
    fn context_resolves_references() {
        let mut state = RunState::new(["a"]);
        state
            .nodes
            .get_mut("a")
            .unwrap()
            .outputs
            .insert("k".into(), json!([1]));
        let params = BTreeMap::from([("p".to_string(), json!("v"))]);
        let env = BTreeMap::from([("HOME_X".to_string(), "h".to_string())]);
        let ctx = TemplateContext {
            params: &params,
            state: &state,
            run_id: "r1",
            run_dir: Path::new("/runs/r1"),
            node_dir: None,
            project_root: Path::new("/p"),
            env: &env,
        };
        assert_eq!(
            ctx.render_string("${{ params.p }}-${{ run.id }}").unwrap(),
            "v-r1"
        );
        assert_eq!(
            ctx.render_string("${{ nodes.a.outputs.k }}").unwrap(),
            "[1]"
        );
        assert_eq!(ctx.render_string("${{ env.HOME_X }}").unwrap(), "h");
        let err = ctx.render_string("${{ node.dir }}").unwrap_err();
        assert_eq!(err.code, "FLOW_TEMPLATE_UNRESOLVED");
        assert_eq!(
            ctx.render_string("${{ nodes.a.outputs.none }}")
                .unwrap_err()
                .params["ref"],
            "nodes.a.outputs.none"
        );
    }
}

//! Checks done before a run starts: features this engine version runs,
//! command-safety rules, parameter values, the command list shown for
//! confirmation (spec 7.2), and the template resolver used while running.

use crate::flow::model::{CommandRun, FlowDef, FlowNode, LoopBody, NodeKind, ParamType};
use crate::flow::run::model::Reason;
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

/// Visitor of [`walk`]: `(path, enclosing loop ids, node)`.
type Visit<'v, 'a> = &'v mut dyn FnMut(&str, &[String], &'a FlowNode);

/// Calls `visit` for every node of `nodes`, including inline loop bodies.
fn walk<'a>(nodes: &'a [FlowNode], path: &str, within: &mut Vec<String>, visit: Visit<'_, 'a>) {
    for (i, node) in nodes.iter().enumerate() {
        let node_path = if path.is_empty() {
            format!("nodes[{i}]")
        } else {
            format!("{path}.nodes[{i}]")
        };
        visit(&node_path, within, node);
        if let NodeKind::Loop(lp) = &node.kind {
            if let LoopBody::Inline(body) = &lp.body {
                within.push(node.id.clone());
                walk(&body.nodes, &format!("{node_path}.body"), within, visit);
                within.pop();
            }
        }
    }
}

/// Problems that prevent this engine version from running the flow and the
/// files it references (`bundle`: `(project-relative path, flow)`, root first).
pub fn check_runnable(bundle: &[(&str, &FlowDef)]) -> Vec<Reason> {
    let mut problems = Vec::new();
    for (file, flow) in bundle {
        let mut push = |code: &str, path: String, key: &str, value: &str| {
            problems.push(
                Reason::new(code)
                    .with("file", *file)
                    .with("path", path)
                    .with(key, value),
            );
        };
        walk(&flow.nodes, "", &mut Vec::new(), &mut |path, _, node| {
            match &node.kind {
                NodeKind::Command(command) => match &command.run {
                    CommandRun::Argv(argv) => {
                        if argv.first().is_some_and(|p| template::has_template(p)) {
                            push(
                                FLOW_RUN_UNSAFE_TEMPLATE,
                                format!("{path}.run[0]"),
                                "rule",
                                "program-templated",
                            );
                        }
                    }
                    CommandRun::Shell(text) => {
                        if template::has_template(text) {
                            push(
                                FLOW_RUN_UNSAFE_TEMPLATE,
                                format!("{path}.run"),
                                "rule",
                                "shell-templated",
                            );
                        }
                    }
                },
                NodeKind::Approval(_)
                | NodeKind::Loop(_)
                | NodeKind::Branch(_)
                | NodeKind::Subflow(_) => {}
                other => push(
                    FLOW_RUN_UNSUPPORTED,
                    path.to_string(),
                    "feature",
                    other.name(),
                ),
            }
            if node.concurrency_key.is_some() {
                push(
                    FLOW_RUN_UNSUPPORTED,
                    format!("{path}.concurrencyKey"),
                    "feature",
                    "concurrencyKey",
                );
            }
        });
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
    /// Project-relative flow file that defines the command.
    pub file: String,
    /// Enclosing loop ids (inline loop bodies), outermost first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub within: Vec<String>,
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

/// Every command the flow and its referenced files can run (spec 7.2).
pub fn command_summaries(bundle: &[(&str, &FlowDef)]) -> Vec<CommandSummary> {
    let mut out = Vec::new();
    for (file, flow) in bundle {
        walk(&flow.nodes, "", &mut Vec::new(), &mut |_, within, node| {
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
                    file: file.to_string(),
                    within: within.to_vec(),
                    node_id: node.id.clone(),
                    run,
                    shell: command.shell,
                    working_dir,
                    env,
                    templated,
                });
            }
        });
    }
    out
}

/// A loop variable visible to templates.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopVar {
    pub name: String,
    pub item: Value,
    pub index: usize,
}

/// Outputs of a node visible from a place in the run.
pub type OutputsLookup<'a> = &'a dyn Fn(&str) -> Option<BTreeMap<String, Value>>;

/// Values available to templates at one place in a run.
pub struct TemplateContext<'a> {
    pub params: &'a BTreeMap<String, Value>,
    /// Outputs of a node visible from here (scope rules applied by the caller).
    pub outputs: OutputsLookup<'a>,
    /// Loop variables of the enclosing inline loops, innermost last.
    pub vars: &'a [LoopVar],
    /// Outputs of the iteration that just ended (`while` loop `until` only).
    pub iteration: Option<&'a BTreeMap<String, Value>>,
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
            Reference::NodeOutput { node, key } => (self.outputs)(node)?.get(key).cloned(),
            Reference::RunId => Some(Value::String(self.run_id.to_string())),
            Reference::RunDir => Some(path(self.run_dir)),
            Reference::NodeDir => self.node_dir.map(path),
            Reference::ProjectRoot => Some(path(self.project_root)),
            Reference::Env(name) => self.env.get(name).map(|v| Value::String(v.clone())),
            Reference::LoopVar(name) => self
                .vars
                .iter()
                .rev()
                .find(|v| &v.name == name)
                .map(|v| v.item.clone()),
            Reference::Index => self.vars.last().map(|v| Value::from(v.index)),
            Reference::IterationOutput(key) => self.iteration?.get(key).cloned(),
        }
    }

    /// Renders a template to a value (a single reference keeps its type).
    pub fn render_value(&self, text: &str) -> Result<Value, Reason> {
        template::render(text, &|r| self.resolve(r)).map_err(|err| match err {
            template::RenderError::Unresolved(reference) => {
                Reason::new("FLOW_TEMPLATE_UNRESOLVED").with("ref", reference.to_string())
            }
            template::RenderError::Parse(err) => {
                Reason::new("FLOW_TEMPLATE_INVALID").with("reason", err.reason())
            }
        })
    }

    /// Renders a template to a string (non-string values as JSON).
    pub fn render_string(&self, text: &str) -> Result<String, Reason> {
        Ok(match self.render_value(text)? {
            Value::String(s) => s,
            other => other.to_string(),
        })
    }

    /// Renders every string inside `value` (arrays and objects recursively).
    pub fn render_json(&self, value: &Value) -> Result<Value, Reason> {
        Ok(match value {
            Value::String(text) => self.render_value(text)?,
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|v| self.render_json(v))
                    .collect::<Result<_, _>>()?,
            ),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| Ok((k.clone(), self.render_json(v)?)))
                    .collect::<Result<_, Reason>>()?,
            ),
            other => other.clone(),
        })
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
    fn rejects_what_this_version_cannot_run_anywhere_in_the_bundle() {
        let def = flow(
            "params: { p: { type: string } }\nnodes:\n  - { id: a, kind: agent, provider: claude, permission: read-only, prompt: x }\n  - { id: b, kind: command, run: ['${{ params.p }}'] }\n  - { id: c, kind: command, run: 'echo ${{ params.p }}', shell: true }\n  - { id: d, kind: command, run: [x, '${{ params.p }}'], concurrencyKey: k }\n  - id: l\n    kind: loop\n    mode: foreach\n    items: [1]\n    maxIterations: 1\n    body:\n      nodes:\n        - { id: inner, kind: command, run: ['${{ item }}'] }\nedges:\n  - { from: a, to: b }\n  - { from: b, to: c }\n  - { from: c, to: d }\n  - { from: d, to: l }\n",
        );
        let sub = flow("nodes:\n  - { id: s, kind: action, uses: mdium/issue-close }\n");
        assert_eq!(
            codes(&check_runnable(&[
                ("root.flow.yaml", &def),
                ("sub.flow.yaml", &sub)
            ])),
            vec![
                (FLOW_RUN_UNSUPPORTED.into(), "nodes[0]".into()),
                (FLOW_RUN_UNSAFE_TEMPLATE.into(), "nodes[1].run[0]".into()),
                (FLOW_RUN_UNSAFE_TEMPLATE.into(), "nodes[2].run".into()),
                (
                    FLOW_RUN_UNSUPPORTED.into(),
                    "nodes[3].concurrencyKey".into()
                ),
                (
                    FLOW_RUN_UNSAFE_TEMPLATE.into(),
                    "nodes[4].body.nodes[0].run[0]".into()
                ),
                (FLOW_RUN_UNSUPPORTED.into(), "nodes[0]".into()),
            ]
        );
        let ok = flow(
            "nodes:\n  - { id: a, kind: command, run: [x, '${{ run.id }}'] }\n  - { id: b, kind: approval }\n  - { id: c, kind: branch, cases: [ { when: { ref: run.id, op: exists }, port: y } ] }\n  - { id: s, kind: subflow, flow: ./x.flow.yaml }\nedges:\n  - { from: a, to: b, port: success }\n  - { from: b, to: a, port: reject, maxTraversals: 2 }\n",
        );
        assert!(check_runnable(&[("r", &ok)]).is_empty());
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
    fn command_summaries_cover_inline_bodies_and_files() {
        let def = flow(
            "env: { A: '1' }\ndefaults: { workingDir: '${{ project.root }}/sub' }\nnodes:\n  - { id: a, kind: command, run: [tool, build], env: { B: '${{ run.id }}' } }\n  - { id: b, kind: command, run: 'echo hi', shell: true }\n  - id: l\n    kind: loop\n    mode: foreach\n    items: [1]\n    maxIterations: 1\n    body:\n      nodes:\n        - { id: inner, kind: command, run: [x, '${{ item }}'] }\n",
        );
        let sub = flow("nodes:\n  - { id: s, kind: command, run: [y] }\n");
        let list = command_summaries(&[("r.flow.yaml", &def), ("s.flow.yaml", &sub)]);
        assert_eq!(list.len(), 4);
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
        assert!(list[1].shell);
        assert_eq!(
            (list[2].node_id.as_str(), list[2].within.clone()),
            ("inner", vec!["l".to_string()])
        );
        assert_eq!(
            (list[3].file.as_str(), list[3].node_id.as_str()),
            ("s.flow.yaml", "s")
        );
    }

    #[test]
    fn context_resolves_references() {
        let params = BTreeMap::from([("p".to_string(), json!("v"))]);
        let env = BTreeMap::from([("HOME_X".to_string(), "h".to_string())]);
        let outputs =
            |id: &str| (id == "a").then(|| BTreeMap::from([("k".to_string(), json!([1]))]));
        let vars = vec![
            LoopVar {
                name: "outer".into(),
                item: json!("o"),
                index: 4,
            },
            LoopVar {
                name: "item".into(),
                item: json!({ "n": 1 }),
                index: 2,
            },
        ];
        let iteration = BTreeMap::from([("done".to_string(), json!(true))]);
        let ctx = TemplateContext {
            params: &params,
            outputs: &outputs,
            vars: &vars,
            iteration: Some(&iteration),
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
        assert_eq!(ctx.render_value("${{ item }}").unwrap(), json!({ "n": 1 }));
        assert_eq!(
            ctx.render_string("${{ outer }}/${{ index }}").unwrap(),
            "o/2"
        );
        assert_eq!(
            ctx.render_value("${{ iteration.outputs.done }}").unwrap(),
            json!(true)
        );
        assert_eq!(ctx.render_string("${{ env.HOME_X }}").unwrap(), "h");
        assert_eq!(
            ctx.render_string("${{ node.dir }}").unwrap_err().code,
            "FLOW_TEMPLATE_UNRESOLVED"
        );
        assert_eq!(
            ctx.render_json(&json!({ "a": ["${{ params.p }}", 2] }))
                .unwrap(),
            json!({ "a": ["v", 2] })
        );
    }
}

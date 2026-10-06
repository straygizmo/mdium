//! Semantic validation of a decoded [`FlowDef`]: names, per-kind rules,
//! edges and ports, cycles and back-edges, entry/reachability, and
//! template/condition references (spec 2.3–2.8). File references
//! (`promptRef`, sub-flows, file loop bodies) are checked by
//! [`crate::flow::load`], which needs the file system.

use crate::flow::condition::Condition;
use crate::flow::issues::*;
use crate::flow::model::*;
use crate::flow::template::{self, is_ident, Reference, RESERVED_ROOTS};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

/// Validates `flow` and returns the findings.
pub fn validate(flow: &FlowDef) -> Issues {
    let mut v = Validator {
        issues: Issues::default(),
        params: flow.params.keys().cloned().collect(),
        env_passthrough: flow.env_passthrough.iter().cloned().collect(),
    };
    v.flow_level(flow);
    v.check_ids(flow);
    let top_ids: BTreeSet<String> = flow.nodes.iter().map(|n| n.id.clone()).collect();
    let ctx = Ctx {
        visible: vec![top_ids.clone()],
        loop_vars: vec![],
        iteration: false,
    };
    v.scope(&flow.nodes, &flow.edges, "", &ctx);
    for (key, text) in &flow.outputs {
        let path = format!("outputs.{key}");
        if !is_ident(key) {
            v.issues
                .error(FlowIssue::new(FLOW_INVALID_ID, &path).with("name", key.clone()));
        }
        v.template(text, &path, &ctx);
    }
    for (name, text) in &flow.env {
        let path = format!("env.{name}");
        if !is_env_name(name) {
            v.issues
                .error(FlowIssue::new(FLOW_INVALID_ID, &path).with("name", name.clone()));
        }
        v.template(text, &path, &ctx);
    }
    if let Some(dir) = &flow.defaults.working_dir {
        v.template(dir, "defaults.workingDir", &ctx);
    }
    v.issues
}

struct Validator {
    issues: Issues,
    params: BTreeSet<String>,
    env_passthrough: BTreeSet<String>,
}

/// What references may see at a given place.
#[derive(Clone)]
struct Ctx {
    /// Node ids of the current scope and every enclosing inline scope.
    visible: Vec<BTreeSet<String>>,
    /// Iteration variables of the enclosing loops (innermost last).
    loop_vars: Vec<String>,
    /// Inside a `while` loop's `until` (may read `iteration.outputs`).
    iteration: bool,
}

fn is_flow_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
}

fn is_node_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn is_port_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b) if b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Output ports a node can leave through.
pub fn node_ports(node: &FlowNode) -> Vec<String> {
    let mut ports: Vec<String> = match &node.kind {
        NodeKind::Approval(a) => a.effective_options(),
        NodeKind::Branch(b) => {
            let mut ports: Vec<String> = b.cases.iter().map(|c| c.port.clone()).collect();
            ports.extend(b.default.clone());
            ports
        }
        NodeKind::Agent(a) if a.output_contract == OutputContract::Outcome => {
            vec![PORT_SUCCESS.into(), PORT_ATTENTION.into()]
        }
        _ => vec![PORT_SUCCESS.into()],
    };
    if !ports.iter().any(|p| p == PORT_FAILURE) {
        ports.push(PORT_FAILURE.into());
    }
    ports
}

/// Every node of `nodes`, including inline loop bodies, with its path.
fn walk_nodes<'a>(nodes: &'a [FlowNode], path: &str, out: &mut Vec<(String, &'a FlowNode)>) {
    for (i, node) in nodes.iter().enumerate() {
        let node_path = format!("{}[{i}]", join(path, "nodes"));
        if let NodeKind::Loop(LoopNode {
            body: LoopBody::Inline(body),
            ..
        }) = &node.kind
        {
            walk_nodes(&body.nodes, &join(&node_path, "body"), out);
        }
        out.push((node_path, node));
    }
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn invalid(path: impl Into<String>, reason: &str) -> FlowIssue {
    FlowIssue::new(FLOW_INVALID_VALUE, path).with("reason", reason)
}

impl Validator {
    fn flow_level(&mut self, flow: &FlowDef) {
        if !is_flow_id(&flow.id) {
            self.issues
                .error(FlowIssue::new(FLOW_INVALID_ID, "id").with("name", flow.id.clone()));
        }
        if flow.name.trim().is_empty() {
            self.issues.error(invalid("name", "empty"));
        }
        for (name, def) in &flow.params {
            let path = format!("params.{name}");
            if !is_ident(name) {
                self.issues
                    .error(FlowIssue::new(FLOW_INVALID_ID, &path).with("name", name.clone()));
            }
            if let Some(default) = &def.default {
                let ok = match def.ty {
                    ParamType::String | ParamType::Path => default.is_string(),
                    ParamType::Number => default.is_number(),
                    ParamType::Bool => default.is_boolean(),
                };
                if !ok {
                    self.issues
                        .error(invalid(join(&path, "default"), "type-mismatch"));
                }
            }
        }
        for (i, name) in flow.env_passthrough.iter().enumerate() {
            if !is_env_name(name) {
                self.issues.error(
                    FlowIssue::new(FLOW_INVALID_ID, format!("envPassthrough[{i}]"))
                        .with("name", name.clone()),
                );
            }
        }
        if let Some(timeout) = &flow.defaults.timeout {
            self.duration(timeout, "defaults.timeout");
        }
        if let Some(retry) = &flow.defaults.retry {
            self.retry(retry, "defaults.retry");
        }
        let limits = &flow.limits;
        if limits.max_concurrent_nodes == Some(0) {
            self.issues
                .error(invalid("limits.maxConcurrentNodes", "zero"));
        }
        if limits.max_traversals == Some(0) {
            self.issues.error(invalid("limits.maxTraversals", "zero"));
        }
        if let Some(budget) = limits.budget_usd {
            if !(budget.is_finite() && budget > 0.0) {
                self.issues
                    .error(invalid("limits.budgetUsd", "not-positive"));
            }
        }
        if let Some(grace) = &limits.stop_grace {
            self.duration(grace, "limits.stopGrace");
        }
    }

    fn duration(&mut self, text: &str, path: &str) {
        if parse_duration(text).is_none() {
            self.issues
                .error(invalid(path, "bad-duration").with("value", text));
        }
    }

    fn retry(&mut self, retry: &RetryPolicy, path: &str) {
        if let Some(backoff) = &retry.backoff {
            self.duration(backoff, &join(path, "backoff"));
        }
        if matches!(&retry.on, Some(on) if on.is_empty()) {
            self.issues.error(invalid(join(path, "on"), "empty"));
        }
    }

    /// Node ids: form and uniqueness across the whole file (inline bodies
    /// included, so an inner node never shadows an outer one).
    fn check_ids(&mut self, flow: &FlowDef) {
        let mut all = Vec::new();
        walk_nodes(&flow.nodes, "", &mut all);
        let mut seen: HashMap<&str, &str> = HashMap::new();
        for (path, node) in &all {
            let id_path = join(path, "id");
            if !is_node_id(&node.id) {
                self.issues
                    .error(FlowIssue::new(FLOW_INVALID_ID, &id_path).with("name", node.id.clone()));
            }
            if let Some(first) = seen.get(node.id.as_str()) {
                self.issues.error(
                    FlowIssue::new(FLOW_DUPLICATE_NODE_ID, &id_path)
                        .with("id", node.id.clone())
                        .with("first", first.to_string()),
                );
            } else {
                seen.insert(&node.id, path);
            }
        }
    }

    /// One graph scope: its nodes, edges and graph shape.
    fn scope(&mut self, nodes: &[FlowNode], edges: &[FlowEdge], path: &str, ctx: &Ctx) {
        for (i, node) in nodes.iter().enumerate() {
            self.node(node, &format!("{}[{i}]", join(path, "nodes")), ctx);
        }
        self.graph(nodes, edges, path);
    }

    fn node(&mut self, node: &FlowNode, path: &str, ctx: &Ctx) {
        if let Some(timeout) = &node.timeout {
            self.duration(timeout, &join(path, "timeout"));
        }
        if let Some(retry) = &node.retry {
            self.retry(retry, &join(path, "retry"));
        }
        if let Some(cost) = &node.cost {
            if matches!(cost.estimate_usd, Some(v) if !(v.is_finite() && v >= 0.0)) {
                self.issues
                    .error(invalid(join(path, "cost.estimateUsd"), "negative"));
            }
            if matches!(cost.budget_usd, Some(v) if !(v.is_finite() && v > 0.0)) {
                self.issues
                    .error(invalid(join(path, "cost.budgetUsd"), "not-positive"));
            }
        }
        if let Some(when) = &node.when {
            self.condition(when, &join(path, "when"), ctx);
        }
        if matches!(&node.concurrency_key, Some(key) if key.trim().is_empty()) {
            self.issues
                .error(invalid(join(path, "concurrencyKey"), "empty"));
        }
        if let Some(name) = &node.name {
            if name.trim().is_empty() {
                self.issues.error(invalid(join(path, "name"), "empty"));
            }
        }
        match &node.kind {
            NodeKind::Agent(agent) => self.agent(agent, path, ctx),
            NodeKind::Command(command) => self.command(command, path, ctx),
            NodeKind::Approval(approval) => self.approval(approval, path, ctx),
            NodeKind::Loop(lp) => self.loop_node(lp, path, ctx),
            NodeKind::Branch(branch) => self.branch(branch, path, ctx),
            NodeKind::Subflow(sub) => {
                self.static_ref(&sub.flow, &join(path, "flow"));
                for (key, value) in &sub.params {
                    let p = format!("{path}.params.{key}");
                    if !is_ident(key) {
                        self.issues
                            .error(FlowIssue::new(FLOW_INVALID_ID, &p).with("name", key.clone()));
                    }
                    self.value_templates(value, &p, ctx);
                }
            }
            NodeKind::Action(action) => {
                if !KNOWN_ACTIONS.contains(&action.uses.as_str()) {
                    self.issues.error(
                        FlowIssue::new(FLOW_ACTION_UNKNOWN, join(path, "uses"))
                            .with("uses", action.uses.clone()),
                    );
                }
                for (key, value) in &action.with_args {
                    self.value_templates(value, &format!("{path}.with.{key}"), ctx);
                }
            }
        }
    }

    /// A path that must not be templated (prompt / flow references).
    fn static_ref(&mut self, text: &str, path: &str) {
        if text.trim().is_empty() {
            self.issues.error(invalid(path, "empty"));
        } else if template::has_template(text) {
            self.issues.error(invalid(path, "template-not-allowed"));
        }
    }

    fn agent(&mut self, agent: &AgentNode, path: &str, ctx: &Ctx) {
        match (&agent.prompt, &agent.prompt_ref) {
            (None, None) => self
                .issues
                .error(invalid(join(path, "prompt"), "prompt-missing")),
            (Some(_), Some(_)) => self
                .issues
                .error(invalid(join(path, "promptRef"), "prompt-conflict")),
            (Some(prompt), None) => {
                if prompt.trim().is_empty() {
                    self.issues.error(invalid(join(path, "prompt"), "empty"));
                }
                self.template(prompt, &join(path, "prompt"), ctx);
            }
            (None, Some(prompt_ref)) => {
                let ref_path = join(path, "promptRef");
                if let Some(name) = prompt_ref.strip_prefix("builtin:") {
                    if !is_ident(name) {
                        self.issues.error(invalid(ref_path, "bad-builtin"));
                    }
                } else {
                    self.static_ref(prompt_ref, &ref_path);
                }
            }
        }
        if let Some(model) = &agent.model {
            self.template(model, &join(path, "model"), ctx);
        }
        if let Some(dir) = &agent.working_dir {
            self.template(dir, &join(path, "workingDir"), ctx);
        }
        if let Some(policy) = &agent.policy {
            self.value_templates(policy, &join(path, "policy"), ctx);
        }
    }

    fn command(&mut self, command: &CommandNode, path: &str, ctx: &Ctx) {
        let run_path = join(path, "run");
        match (&command.run, command.shell) {
            (CommandRun::Shell(_), false) => self
                .issues
                .error(invalid(&run_path, "string-requires-shell")),
            (CommandRun::Argv(_), true) => self
                .issues
                .error(invalid(&run_path, "shell-requires-string")),
            (CommandRun::Shell(text), true) => {
                if text.trim().is_empty() {
                    self.issues.error(invalid(&run_path, "empty"));
                }
                self.template(text, &run_path, ctx);
            }
            (CommandRun::Argv(argv), false) => {
                if argv.first().is_none_or(|program| program.trim().is_empty()) {
                    self.issues.error(invalid(&run_path, "empty"));
                }
                for (i, arg) in argv.iter().enumerate() {
                    self.template(arg, &format!("{run_path}[{i}]"), ctx);
                }
            }
        }
        if let Some(dir) = &command.working_dir {
            self.template(dir, &join(path, "workingDir"), ctx);
        }
        for (name, value) in &command.env {
            let p = format!("{path}.env.{name}");
            if !is_env_name(name) {
                self.issues
                    .error(FlowIssue::new(FLOW_INVALID_ID, &p).with("name", name.clone()));
            }
            self.template(value, &p, ctx);
        }
        if matches!(&command.success_codes, Some(codes) if codes.is_empty()) {
            self.issues
                .error(invalid(join(path, "successCodes"), "empty"));
        }
    }

    fn approval(&mut self, approval: &ApprovalNode, path: &str, ctx: &Ctx) {
        if let Some(options) = &approval.options {
            self.port_names(options, &join(path, "options"));
        }
        if let Some(message) = &approval.message {
            self.template(message, &join(path, "message"), ctx);
        }
        for (i, show) in approval.show.iter().enumerate() {
            // `show` entries name values to display, e.g. "nodes.x.outputs.y".
            let p = format!("{path}.show[{i}]");
            match template::parse_reference(show) {
                Ok(reference) => self.reference(&reference, &p, ctx),
                Err(_) => self.issues.error(
                    FlowIssue::new(FLOW_TEMPLATE_INVALID, p)
                        .with("reason", "bad-reference")
                        .with("text", show.clone()),
                ),
            }
        }
    }

    /// Ports declared by a node (approval options, branch cases): valid,
    /// unique, non-empty, and not the reserved `failure`.
    fn port_names(&mut self, names: &[String], path: &str) {
        if names.is_empty() {
            self.issues.error(invalid(path, "empty"));
        }
        let mut seen = BTreeSet::new();
        for (i, name) in names.iter().enumerate() {
            let p = format!("{path}[{i}]");
            if !is_port_name(name) {
                self.issues
                    .error(FlowIssue::new(FLOW_INVALID_ID, &p).with("name", name.clone()));
            } else if name == PORT_FAILURE {
                self.issues.error(invalid(&p, "reserved-port"));
            } else if !seen.insert(name.as_str()) {
                self.issues
                    .error(invalid(&p, "duplicate-port").with("port", name.clone()));
            }
        }
    }

    fn branch(&mut self, branch: &BranchNode, path: &str, ctx: &Ctx) {
        let mut ports: Vec<String> = branch.cases.iter().map(|c| c.port.clone()).collect();
        let cases_path = join(path, "cases");
        if ports.is_empty() {
            self.issues.error(invalid(&cases_path, "empty"));
        }
        if let Some(default) = &branch.default {
            ports.push(default.clone());
        }
        if !ports.is_empty() {
            // Report port problems against the case (or `default`) that declares them.
            let mut seen = BTreeSet::new();
            for (i, port) in ports.iter().enumerate() {
                let p = if i < branch.cases.len() {
                    format!("{cases_path}[{i}].port")
                } else {
                    join(path, "default")
                };
                if !is_port_name(port) {
                    self.issues
                        .error(FlowIssue::new(FLOW_INVALID_ID, &p).with("name", port.clone()));
                } else if port == PORT_FAILURE {
                    self.issues.error(invalid(&p, "reserved-port"));
                } else if !seen.insert(port.as_str()) {
                    self.issues
                        .error(invalid(&p, "duplicate-port").with("port", port.clone()));
                }
            }
        }
        for (i, case) in branch.cases.iter().enumerate() {
            self.condition(&case.when, &format!("{cases_path}[{i}].when"), ctx);
        }
    }

    fn loop_node(&mut self, lp: &LoopNode, path: &str, ctx: &Ctx) {
        match lp.max_iterations {
            None => self.issues.error(FlowIssue::new(
                FLOW_LOOP_LIMIT_MISSING,
                join(path, "maxIterations"),
            )),
            Some(0) => self
                .issues
                .error(invalid(join(path, "maxIterations"), "zero")),
            Some(_) => {}
        }
        if lp.parallelism == Some(0) {
            self.issues
                .error(invalid(join(path, "parallelism"), "zero"));
        }
        let var = lp.loop_var().to_string();
        if !is_ident(&var) || RESERVED_ROOTS.contains(&var.as_str()) {
            self.issues
                .error(FlowIssue::new(FLOW_INVALID_ID, join(path, "as")).with("name", var.clone()));
        }
        match lp.mode {
            LoopMode::Foreach => {
                if lp.until.is_some() {
                    self.issues
                        .error(invalid(join(path, "until"), "until-requires-while"));
                }
                match &lp.items {
                    None => self
                        .issues
                        .error(invalid(join(path, "items"), "items-missing")),
                    Some(Value::Array(items)) => {
                        for (i, item) in items.iter().enumerate() {
                            self.value_templates(item, &format!("{path}.items[{i}]"), ctx);
                        }
                    }
                    Some(Value::String(text)) => {
                        // Must be exactly one reference, so it can resolve to an array.
                        let single = matches!(
                            template::parse_template(text).as_deref(),
                            Ok([template::Segment::Ref(_)])
                        );
                        if !single && template::parse_template(text).is_ok() {
                            self.issues
                                .error(invalid(join(path, "items"), "items-not-array"));
                        }
                        self.template(text, &join(path, "items"), ctx);
                    }
                    Some(_) => self
                        .issues
                        .error(invalid(join(path, "items"), "items-not-array")),
                }
            }
            LoopMode::While => {
                if lp.items.is_some() {
                    self.issues
                        .error(invalid(join(path, "items"), "items-requires-foreach"));
                }
                match &lp.until {
                    None => self
                        .issues
                        .error(invalid(join(path, "until"), "until-missing")),
                    Some(until) => {
                        let mut until_ctx = ctx.clone();
                        until_ctx.iteration = true;
                        self.condition(until, &join(path, "until"), &until_ctx);
                    }
                }
            }
        }
        let mut body_ctx = ctx.clone();
        body_ctx.loop_vars.push(var);
        match &lp.body {
            LoopBody::File(file) => {
                self.static_ref(file, &join(path, "body"));
                for (key, value) in &lp.params {
                    let p = format!("{path}.params.{key}");
                    if !is_ident(key) {
                        self.issues
                            .error(FlowIssue::new(FLOW_INVALID_ID, &p).with("name", key.clone()));
                    }
                    self.value_templates(value, &p, &body_ctx);
                }
            }
            LoopBody::Inline(body) => {
                if !lp.params.is_empty() {
                    self.issues
                        .error(invalid(join(path, "params"), "params-need-file-body"));
                }
                let body_path = join(path, "body");
                body_ctx
                    .visible
                    .push(body.nodes.iter().map(|n| n.id.clone()).collect());
                self.scope(&body.nodes, &body.edges, &body_path, &body_ctx);
                for (key, text) in &body.outputs {
                    let p = format!("{body_path}.outputs.{key}");
                    if !is_ident(key) {
                        self.issues
                            .error(FlowIssue::new(FLOW_INVALID_ID, &p).with("name", key.clone()));
                    }
                    self.template(text, &p, &body_ctx);
                }
            }
        }
    }

    fn condition(&mut self, condition: &Condition, path: &str, ctx: &Ctx) {
        for reference in condition.references() {
            self.reference(reference, path, ctx);
        }
    }

    /// Checks templates in every string inside `value`.
    fn value_templates(&mut self, value: &Value, path: &str, ctx: &Ctx) {
        match value {
            Value::String(text) => self.template(text, path, ctx),
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    self.value_templates(item, &format!("{path}[{i}]"), ctx);
                }
            }
            Value::Object(map) => {
                for (key, item) in map {
                    self.value_templates(item, &join(path, key), ctx);
                }
            }
            _ => {}
        }
    }

    fn template(&mut self, text: &str, path: &str, ctx: &Ctx) {
        match template::references(text) {
            Ok(references) => {
                for reference in &references {
                    self.reference(reference, path, ctx);
                }
            }
            Err(err) => {
                let mut issue =
                    FlowIssue::new(FLOW_TEMPLATE_INVALID, path).with("reason", err.reason());
                if let template::TemplateError::BadReference(expr) = err {
                    issue = issue.with("text", expr);
                }
                self.issues.error(issue);
            }
        }
    }

    fn reference(&mut self, reference: &Reference, path: &str, ctx: &Ctx) {
        let bad = |reason: &str| {
            FlowIssue::new(FLOW_TEMPLATE_INVALID, path)
                .with("reason", reason)
                .with("ref", reference.to_string())
        };
        match reference {
            Reference::Param(name) if !self.params.contains(name) => {
                self.issues.error(bad("unknown-param"));
            }
            Reference::NodeOutput { node, .. }
                if !ctx.visible.iter().any(|ids| ids.contains(node)) =>
            {
                self.issues.error(
                    FlowIssue::new(FLOW_UNKNOWN_NODE_REF, path)
                        .with("node", node.clone())
                        .with("ref", reference.to_string()),
                );
            }
            Reference::IterationOutput(_) if !ctx.iteration => {
                self.issues.error(bad("iteration-outside-until"));
            }
            Reference::LoopVar(name) if !ctx.loop_vars.contains(name) => {
                self.issues.error(bad("unknown-variable"));
            }
            Reference::Index if ctx.loop_vars.is_empty() => {
                self.issues.error(bad("index-outside-loop"));
            }
            Reference::Env(name) if !self.env_passthrough.contains(name) => {
                self.issues.error(bad("env-not-passed"));
            }
            _ => {}
        }
    }

    /// Edges, ports, back-edges, cycles, entry nodes and reachability of
    /// one scope.
    fn graph(&mut self, nodes: &[FlowNode], edges: &[FlowEdge], path: &str) {
        let index: BTreeMap<&str, &FlowNode> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        let edges_path = join(path, "edges");
        let mut forward: Vec<(&str, &str)> = Vec::new();
        let mut back: Vec<(usize, &FlowEdge)> = Vec::new();
        for (i, edge) in edges.iter().enumerate() {
            let p = format!("{edges_path}[{i}]");
            let mut ok = true;
            for (field, id) in [("from", &edge.from), ("to", &edge.to)] {
                if !index.contains_key(id.as_str()) {
                    ok = false;
                    self.issues.error(
                        FlowIssue::new(FLOW_UNKNOWN_NODE_REF, join(&p, field))
                            .with("node", id.clone()),
                    );
                }
            }
            if let Some(from) = index.get(edge.from.as_str()) {
                if !node_ports(from).iter().any(|port| port == edge.port()) {
                    ok = false;
                    self.issues.error(
                        FlowIssue::new(FLOW_UNKNOWN_PORT, join(&p, "port"))
                            .with("node", edge.from.clone())
                            .with("port", edge.port().to_string())
                            .with("ports", node_ports(from)),
                    );
                }
            }
            if edge.max_traversals == Some(0) {
                self.issues
                    .error(invalid(join(&p, "maxTraversals"), "zero"));
            }
            if !ok {
                continue;
            }
            if edge.max_traversals.is_some() {
                back.push((i, edge));
            } else {
                forward.push((edge.from.as_str(), edge.to.as_str()));
            }
        }

        // The graph without back-edges must be a DAG (Kahn's algorithm).
        let mut indegree: BTreeMap<&str, usize> = index.keys().map(|id| (*id, 0)).collect();
        let mut successors: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (from, to) in &forward {
            *indegree.get_mut(to).expect("checked above") += 1;
            successors.entry(from).or_default().push(to);
        }
        let reaches = |start: &str, goal: &str| -> bool {
            let mut seen = BTreeSet::new();
            let mut stack = vec![start];
            while let Some(id) = stack.pop() {
                if id == goal {
                    return true;
                }
                if seen.insert(id) {
                    stack.extend(successors.get(id).into_iter().flatten().copied());
                }
            }
            false
        };
        let mut queue: VecDeque<&str> = indegree
            .iter()
            .filter(|(_, d)| **d == 0)
            .map(|(id, _)| *id)
            .collect();
        let mut remaining = indegree.clone();
        while let Some(id) = queue.pop_front() {
            remaining.remove(id);
            for next in successors.get(id).into_iter().flatten() {
                let d = indegree.get_mut(next).expect("known node");
                *d -= 1;
                if *d == 0 {
                    queue.push_back(next);
                }
            }
        }
        if !remaining.is_empty() {
            // Name the nodes on a cycle, not the ones merely downstream of it.
            let cycle: Vec<String> = remaining
                .keys()
                .filter(|id| {
                    successors
                        .get(*id)
                        .into_iter()
                        .flatten()
                        .any(|next| reaches(next, id))
                })
                .map(|id| id.to_string())
                .collect();
            self.issues
                .error(FlowIssue::new(FLOW_CYCLE_WITHOUT_LIMIT, &edges_path).with("nodes", cycle));
        }

        // A bounded edge that doesn't close a cycle is probably a mistake.
        for (i, edge) in back {
            if !reaches(&edge.to, &edge.from) {
                self.issues.warn(
                    FlowIssue::new(FLOW_TRAVERSAL_LIMIT_UNUSED, format!("{edges_path}[{i}]"))
                        .with("from", edge.from.clone())
                        .with("to", edge.to.clone()),
                );
            }
        }

        // Entry nodes are those without incoming forward edges (a back-edge
        // re-enters a node rather than making it a successor; spec 2.4).
        // The forward graph being a DAG, every node is then reachable from
        // an entry, so "no entry" / "unreachable" cannot occur once acyclic.
        if nodes.is_empty() {
            self.issues.error(invalid(join(path, "nodes"), "empty"));
        }
    }
}

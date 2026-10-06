//! Data model of a flow definition (`*.flow.yaml`, `*.flow.json`).
//!
//! The model mirrors the on-disk format one to one (camelCase keys). It is
//! deliberately permissive about values: [`crate::flow::parse`] rejects
//! unknown keys and malformed conditions before decoding, and
//! [`crate::flow::validate`] checks everything that needs the whole graph
//! (ids, ports, cycles, references).

use crate::flow::condition::Condition;
use crate::workflow::model::Provider;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;

/// The only `schemaVersion` this build understands.
pub const FLOW_SCHEMA_VERSION: u32 = 1;

/// Port taken when a node finishes successfully (and the default of an edge).
pub const PORT_SUCCESS: &str = "success";
/// Port taken when a node fails.
pub const PORT_FAILURE: &str = "failure";
/// Extra port of an `agent` node whose output contract reports `attention`.
pub const PORT_ATTENTION: &str = "attention";

/// Default options of an `approval` node.
pub const DEFAULT_APPROVAL_OPTIONS: [&str; 2] = ["approve", "reject"];
/// Default name of a loop's iteration variable.
pub const DEFAULT_LOOP_VAR: &str = "item";

/// Built-in actions an `action` node may use (`uses: mdium/<name>`).
pub const KNOWN_ACTIONS: [&str; 7] = [
    "mdium/screen-input",
    "mdium/git-worktree-create",
    "mdium/design-doc-commit",
    "mdium/issue-entry",
    "mdium/git-merge-local",
    "mdium/issue-close",
    "mdium/git-worktree-discard",
];

/// One flow definition file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowDef {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, ParamDef>,
    #[serde(default, skip_serializing_if = "NodeDefaults::is_empty")]
    pub defaults: NodeDefaults,
    #[serde(default, skip_serializing_if = "FlowLimits::is_empty")]
    pub limits: FlowLimits,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env_passthrough: Vec<String>,
    pub nodes: Vec<FlowNode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edges: Vec<FlowEdge>,
    /// Flow outputs (templates), exposed to a parent `subflow` / file-bodied `loop`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub outputs: BTreeMap<String, String>,
    /// Editor-only data (positions, viewport); opaque to the engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<Value>,
}

/// Type of a flow parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParamType {
    String,
    Number,
    Bool,
    Path,
}

/// Declaration of one flow parameter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDef {
    #[serde(rename = "type")]
    pub ty: ParamType,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Values every node inherits unless it overrides them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
}

impl NodeDefaults {
    fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// Run-wide limits.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent_nodes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_traversals: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_grace: Option<String>,
}

impl FlowLimits {
    fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// Failure kinds a retry policy reacts to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RetryOn {
    Failed,
    Timeout,
}

/// Automatic retry of a failed node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backoff: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<Vec<RetryOn>>,
}

/// Cost estimate and per-node budget.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_usd: Option<f64>,
}

/// One node: the attributes shared by every kind plus the kind itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNode {
    pub id: String,
    // Tagged by "kind". Unknown attributes are rejected by the parser's key
    // check, since serde's `flatten` and `deny_unknown_fields` don't combine.
    #[serde(flatten)]
    pub kind: NodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<CostSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<Condition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency_key: Option<String>,
}

/// The kind-specific part of a node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NodeKind {
    Agent(AgentNode),
    Command(CommandNode),
    Approval(ApprovalNode),
    Loop(LoopNode),
    Branch(BranchNode),
    Subflow(SubflowNode),
    Action(ActionNode),
}

impl NodeKind {
    /// The `kind` string as written on disk.
    pub fn name(&self) -> &'static str {
        match self {
            NodeKind::Agent(_) => "agent",
            NodeKind::Command(_) => "command",
            NodeKind::Approval(_) => "approval",
            NodeKind::Loop(_) => "loop",
            NodeKind::Branch(_) => "branch",
            NodeKind::Subflow(_) => "subflow",
            NodeKind::Action(_) => "action",
        }
    }
}

/// Permission of an agent session (`cli-default` is not available to flows).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentPermission {
    ReadOnly,
    FullAccess,
}

/// How an agent's final response is interpreted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputContract {
    /// YAML frontmatter with `outcome` / `reason` / optional `outputs`.
    #[default]
    Outcome,
    /// Free text; success unless the turn itself fails.
    Free,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNode {
    pub provider: Provider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// File-relative path, or `builtin:<name>` for a prompt shipped with MDium.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_ref: Option<String>,
    pub permission: AgentPermission,
    #[serde(default)]
    pub output_contract: OutputContract,
    /// Guard settings (spec ch. 7); opaque until the agent executor lands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
}

/// `run` of a command: an argv array, or a shell string when `shell: true`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CommandRun {
    Argv(Vec<String>),
    Shell(String),
}

/// How a command reports back to MDium.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommandProtocol {
    #[default]
    #[serde(rename = "mdium-v1")]
    MdiumV1,
    #[serde(rename = "none")]
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandNode {
    pub run: CommandRun,
    #[serde(default)]
    pub shell: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success_codes: Option<Vec<i32>>,
    #[serde(default)]
    pub protocol: CommandProtocol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detach: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalNode {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub show: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

impl ApprovalNode {
    /// The options (= output ports), falling back to the defaults.
    pub fn effective_options(&self) -> Vec<String> {
        match &self.options {
            Some(options) => options.clone(),
            None => DEFAULT_APPROVAL_OPTIONS
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoopMode {
    Foreach,
    While,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnItemFailure {
    Stop,
    Continue,
}

/// A loop body: a file-relative flow path, or an inline graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LoopBody {
    File(String),
    Inline(InlineBody),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineBody {
    pub nodes: Vec<FlowNode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edges: Vec<FlowEdge>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub outputs: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopNode {
    pub mode: LoopMode,
    /// `foreach` only: a template resolving to an array, or a literal array.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Value>,
    /// `while` only: evaluated after each iteration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<Condition>,
    /// Required; `None` only so the validator can report it precisely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallelism: Option<u32>,
    pub body: LoopBody,
    #[serde(rename = "as", default, skip_serializing_if = "Option::is_none")]
    pub as_var: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_item_failure: Option<OnItemFailure>,
    /// File body only: arguments of the body flow.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, Value>,
}

impl LoopNode {
    /// Name of the iteration variable.
    pub fn loop_var(&self) -> &str {
        self.as_var.as_deref().unwrap_or(DEFAULT_LOOP_VAR)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCase {
    pub when: Condition,
    pub port: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchNode {
    pub cases: Vec<BranchCase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubflowNode {
    pub flow: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionNode {
    pub uses: String,
    #[serde(rename = "with", default, skip_serializing_if = "BTreeMap::is_empty")]
    pub with_args: BTreeMap<String, Value>,
}

/// A transition between two nodes of the same scope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowEdge {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
    /// Marks the edge as a back-edge (one that closes a cycle) and bounds it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_traversals: Option<u32>,
}

impl FlowEdge {
    /// The port, defaulting to `success`.
    pub fn port(&self) -> &str {
        self.port.as_deref().unwrap_or(PORT_SUCCESS)
    }
}

/// Parses a duration written as `<n>s`, `<n>m` or `<n>h` (e.g. `30s`, `2h`).
pub fn parse_duration(text: &str) -> Option<Duration> {
    let text = text.trim();
    // Split before the last char (not byte): input may be non-ASCII ("30分").
    let (last_index, _) = text.char_indices().last()?;
    let (digits, unit) = text.split_at(last_index);
    if digits.is_empty() {
        return None;
    }
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = digits.parse().ok()?;
    let secs = match unit {
        "s" => Some(n),
        "m" => n.checked_mul(60),
        "h" => n.checked_mul(3600),
        _ => None,
    }?;
    if secs == 0 {
        return None;
    }
    Some(Duration::from_secs(secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_duration_accepts_units() {
        assert_eq!(parse_duration("30s"), Some(Duration::from_secs(30)));
        assert_eq!(parse_duration("15m"), Some(Duration::from_secs(900)));
        assert_eq!(parse_duration("2h"), Some(Duration::from_secs(7200)));
    }

    #[test]
    fn parse_duration_rejects_malformed() {
        for bad in [
            "",
            "s",
            "10",
            "1d",
            "-1s",
            "1.5h",
            "0s",
            "h1",
            "99999999999999999999h",
            "30分",
            "1時間",
            "分",
        ] {
            assert_eq!(parse_duration(bad), None, "{bad}");
        }
    }

    #[test]
    fn approval_options_default() {
        let node = ApprovalNode {
            message: None,
            show: vec![],
            options: None,
        };
        assert_eq!(node.effective_options(), vec!["approve", "reject"]);
    }
}

//! Run-time model of a flow run: statuses and their transition tables
//! (spec 4.2 / 4.3), the event log entries (spec 4.4), and the state that
//! the events reduce to. [`apply`] is the only way a [`RunState`] changes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Status of a flow run (spec 4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Pending,
    Running,
    AwaitingApproval,
    Stopping,
    Paused,
    Interrupted,
    Completed,
    Failed,
    Cancelled,
}

impl RunStatus {
    #[cfg(test)]
    pub const ALL: [RunStatus; 9] = [
        RunStatus::Pending,
        RunStatus::Running,
        RunStatus::AwaitingApproval,
        RunStatus::Stopping,
        RunStatus::Paused,
        RunStatus::Interrupted,
        RunStatus::Completed,
        RunStatus::Failed,
        RunStatus::Cancelled,
    ];

    /// A run in this status has (or should have) a driver working on it.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            RunStatus::Running | RunStatus::AwaitingApproval | RunStatus::Stopping
        )
    }

    /// No further transitions except the ones in the table (resume etc.).
    pub fn is_finished(self) -> bool {
        matches!(self, RunStatus::Completed | RunStatus::Cancelled)
    }
}

/// Run transition table (spec 4.2). Everything else is rejected.
pub fn run_transition_allowed(from: RunStatus, to: RunStatus) -> bool {
    use RunStatus::*;
    match (from, to) {
        (Pending, Running) => true,
        (Running, AwaitingApproval) => true,
        (AwaitingApproval, Running) => true,
        (Running | AwaitingApproval, Stopping) => true,
        (Stopping, Paused) => true,
        (Paused | Interrupted | Failed, Running) => true,
        (Running, Completed | Failed) => true,
        (Running | AwaitingApproval | Stopping, Interrupted) => true,
        (from, Cancelled) => !matches!(from, Completed | Cancelled),
        _ => false,
    }
}

/// Status of one node in a run (spec 4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Ready,
    Running,
    AwaitingApproval,
    RetryWait,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    Interrupted,
}

impl NodeStatus {
    #[cfg(test)]
    pub const ALL: [NodeStatus; 10] = [
        NodeStatus::Pending,
        NodeStatus::Ready,
        NodeStatus::Running,
        NodeStatus::AwaitingApproval,
        NodeStatus::RetryWait,
        NodeStatus::Succeeded,
        NodeStatus::Failed,
        NodeStatus::Skipped,
        NodeStatus::Cancelled,
        NodeStatus::Interrupted,
    ];

    /// Settled for the purpose of edge resolution.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            NodeStatus::Succeeded | NodeStatus::Failed | NodeStatus::Skipped
        )
    }
}

/// Node transition table (spec 4.3, plus `running → ready` for a node that
/// ended because of a stop request, and `skipped → pending` for a node
/// re-armed when a back-edge opens a new pass upstream of it, and
/// `awaiting_approval → cancelled` for a waiting instance a new pass retires).
pub fn node_transition_allowed(from: NodeStatus, to: NodeStatus) -> bool {
    use NodeStatus::*;
    matches!(
        (from, to),
        (Pending, Ready)
            | (Pending, Skipped)
            | (Ready, Running)
            | (Running, Succeeded)
            | (Running, Failed)
            | (Running, AwaitingApproval)
            | (AwaitingApproval, Succeeded)
            | (AwaitingApproval, Failed)
            | (Running, RetryWait)
            | (RetryWait, Ready)
            | (Running, Cancelled)
            | (Running, Interrupted)
            | (Running, Ready)
            | (Failed, Ready)
            | (Interrupted, Ready)
            | (Cancelled, Ready)
            | (Failed, Succeeded)
            | (Skipped, Pending)
            | (AwaitingApproval, Cancelled)
    )
}

/// A machine-readable reason (`code` + `params`), localized by the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reason {
    pub code: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, Value>,
}

impl Reason {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
            params: BTreeMap::new(),
        }
    }

    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.params.insert(key.to_string(), value.into());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostKind {
    Actual,
    Estimated,
}

/// What an approval is about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// Node waiting for the decision; `None` for a run-level budget approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_key: Option<String>,
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Values named by the approval node's `show`, resolved when it paused.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub show: BTreeMap<String, Value>,
    pub reason: Reason,
}

/// One line of `events.jsonl`: `{seq, ts, type, nodeKey?, data}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowEvent {
    pub seq: u64,
    pub ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_key: Option<String>,
    #[serde(flatten)]
    pub body: EventBody,
}

/// Event payloads (`type` + `data`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum EventBody {
    #[serde(rename_all = "camelCase")]
    RunStatus {
        from: RunStatus,
        to: RunStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<Reason>,
    },
    #[serde(rename_all = "camelCase")]
    NodeStatus {
        from: NodeStatus,
        to: NodeStatus,
        attempt: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<Reason>,
        /// Output port taken (set when the node settles or is skipped by `when`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        port: Option<String>,
    },
    NodeOutput {
        key: String,
        value: Value,
    },
    #[serde(rename_all = "camelCase")]
    NodeArtifact {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    NodeProgress {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fraction: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Cost {
        usd: f64,
        kind: CostKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        units: Option<Value>,
    },
    /// An approval is requested (node or budget).
    ApprovalRequested(ApprovalRequest),
    /// An approval was given.
    #[serde(rename_all = "camelCase")]
    Approval {
        choice: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        comment: Option<String>,
        by: String,
    },
    #[serde(rename_all = "camelCase")]
    Process {
        pid: u32,
        started_at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_file: Option<String>,
    },
    /// The budget limit was raised by an approval.
    #[serde(rename_all = "camelCase")]
    BudgetRaised {
        limit_usd: f64,
    },
    /// Something odd that does not change status (bad protocol line, ...).
    Warning(Reason),
    /// A scope opened; `nodes` are the ids of its graph (they start `pending`).
    #[serde(rename_all = "camelCase")]
    ScopeStarted {
        prefix: String,
        #[serde(flatten)]
        init: ScopeInit,
        nodes: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    ScopeFinished {
        prefix: String,
        status: ScopeStatus,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        outputs: BTreeMap<String, Value>,
    },
    /// A `foreach` loop fixed its items (spec 4.4 `loop_items`).
    #[serde(rename_all = "camelCase")]
    LoopItems {
        items: Vec<Value>,
        #[serde(default)]
        limit_reached: bool,
    },
    /// A back-edge was traversed (spec 4.4 `traversal`).
    #[serde(rename_all = "camelCase")]
    Traversal {
        scope: String,
        edge: usize,
        count: u32,
    },
    /// Nodes of a scope start a new pass (new pending instances).
    #[serde(rename_all = "camelCase")]
    NewPass {
        scope: String,
        ids: Vec<String>,
    },
}

impl EventBody {
    /// Status changes are fsynced and force a checkpoint.
    pub fn is_status(&self) -> bool {
        matches!(
            self,
            EventBody::RunStatus { .. } | EventBody::NodeStatus { .. }
        )
    }
}

/// Cost totals; nodes that never reported are counted as unknown.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostTotals {
    pub actual: f64,
    pub estimated: f64,
}

impl CostTotals {
    pub fn total(&self) -> f64 {
        self.actual + self.estimated
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
}

/// Status of a scope (the root, a loop iteration, or a sub-flow).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeStatus {
    Running,
    Completed,
    Failed,
}

/// How a scope was opened (recorded once in `scope_started`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeInit {
    /// The loop / sub-flow node instance that opened it (`None` for the root).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// Prefix of the enclosing scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Inline loop bodies read the enclosing scope's nodes and variables;
    /// file bodies and sub-flows only get `params` (spec 2.5).
    #[serde(default)]
    pub inherits: bool,
    pub graph: crate::flow::run::scope::GraphLoc,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, Value>,
    /// Iteration variable name (inline bodies only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub var: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
}

/// A scope's materialized state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeRecord {
    #[serde(flatten)]
    pub init: ScopeInit,
    pub status: ScopeStatus,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub outputs: BTreeMap<String, Value>,
    /// Sequence number of the event that opened it (scheduling order).
    pub order: u64,
}

/// A `foreach` loop's resolved items (fixed at loop start, reused on resume).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopRecord {
    pub items: Vec<Value>,
    #[serde(default)]
    pub limit_reached: bool,
}

/// Materialized state of one node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeState {
    pub status: NodeStatus,
    /// Number of the current/last attempt (0 = never started).
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub outputs: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<Artifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    #[serde(default)]
    pub cost: CostTotals,
    /// True once any cost was reported (otherwise the cost is unknown).
    #[serde(default)]
    pub cost_reported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

impl NodeState {
    pub fn new() -> Self {
        Self {
            status: NodeStatus::Pending,
            attempt: 0,
            port: None,
            reason: None,
            outputs: BTreeMap::new(),
            artifacts: Vec::new(),
            progress: None,
            cost: CostTotals::default(),
            cost_reported: false,
            process: None,
            started_at: None,
            finished_at: None,
        }
    }
}

impl Default for NodeState {
    fn default() -> Self {
        Self::new()
    }
}

/// Materialized state of a run (what `state.json` stores).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    /// Sequence number of the last applied event (0 = none).
    pub seq: u64,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    pub nodes: BTreeMap<String, NodeState>,
    #[serde(default)]
    pub cost: CostTotals,
    /// Pending approvals (node or budget), in request order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub approvals: Vec<ApprovalRequest>,
    /// Effective budget limit after approvals raised it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_limit_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Scopes by prefix (`""` is the root).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub scopes: BTreeMap<String, ScopeRecord>,
    /// `foreach` items by loop instance key.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub loops: BTreeMap<String, LoopRecord>,
    /// Current pass per `<prefix><id>` (absent = 1).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub passes: BTreeMap<String, u32>,
    /// Back-edge traversal counts per `<prefix>#<edge index>`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub traversals: BTreeMap<String, u32>,
}

impl RunState {
    /// Initial state with every node `pending`.
    pub fn new<'a>(node_keys: impl IntoIterator<Item = &'a str>) -> Self {
        Self {
            seq: 0,
            status: RunStatus::Pending,
            reason: None,
            nodes: node_keys
                .into_iter()
                .map(|k| (k.to_string(), NodeState::new()))
                .collect(),
            cost: CostTotals::default(),
            approvals: Vec::new(),
            budget_limit_usd: None,
            updated_at: None,
            scopes: BTreeMap::new(),
            loops: BTreeMap::new(),
            passes: BTreeMap::new(),
            traversals: BTreeMap::new(),
        }
    }

    /// Current pass of node `id` in scope `prefix`.
    pub fn pass(&self, prefix: &str, id: &str) -> u32 {
        self.passes
            .get(&format!("{prefix}{id}"))
            .copied()
            .unwrap_or(1)
    }

    /// Key of the current instance of node `id` in scope `prefix`.
    pub fn current_key(&self, prefix: &str, id: &str) -> String {
        crate::flow::run::scope::instance_key(prefix, id, self.pass(prefix, id))
    }
}

/// Applies one event. Events are trusted (validated before they were
/// appended); unknown node keys get a fresh node so replay never panics.
pub fn apply(state: &mut RunState, event: &FlowEvent) {
    state.seq = event.seq;
    state.updated_at = Some(event.ts.clone());
    fn node<'s>(state: &'s mut RunState, event: &FlowEvent) -> Option<&'s mut NodeState> {
        let key = event.node_key.clone()?;
        Some(state.nodes.entry(key).or_default())
    }
    match &event.body {
        EventBody::RunStatus { to, reason, .. } => {
            state.status = *to;
            state.reason = reason.clone();
            if *to == RunStatus::Cancelled {
                state.approvals.clear();
            }
        }
        EventBody::NodeStatus {
            to,
            attempt,
            reason,
            port,
            ..
        } => {
            let key = event.node_key.clone();
            if let Some(n) = node(state, event) {
                n.status = *to;
                n.attempt = *attempt;
                n.reason = reason.clone();
                n.port = port.clone();
                match to {
                    NodeStatus::Running => {
                        n.started_at = Some(event.ts.clone());
                        n.finished_at = None;
                        n.process = None;
                        n.progress = None;
                    }
                    NodeStatus::Ready | NodeStatus::Pending => {
                        n.finished_at = None;
                        n.process = None;
                    }
                    s if s.is_terminal()
                        || matches!(s, NodeStatus::Cancelled | NodeStatus::Interrupted) =>
                    {
                        n.finished_at = Some(event.ts.clone());
                        n.process = None;
                    }
                    _ => {}
                }
            }
            if *to != NodeStatus::AwaitingApproval {
                state.approvals.retain(|a| a.node_key != key);
            }
        }
        EventBody::NodeOutput { key, value } => {
            if let Some(n) = node(state, event) {
                n.outputs.insert(key.clone(), value.clone());
            }
        }
        EventBody::NodeArtifact { path, label } => {
            if let Some(n) = node(state, event) {
                n.artifacts.push(Artifact {
                    path: path.clone(),
                    label: label.clone(),
                });
            }
        }
        EventBody::NodeProgress { text, fraction } => {
            if let Some(n) = node(state, event) {
                n.progress = Some(Progress {
                    text: text.clone(),
                    fraction: *fraction,
                });
            }
        }
        EventBody::Cost { usd, kind, .. } => {
            let usd = if usd.is_finite() && *usd >= 0.0 {
                *usd
            } else {
                0.0
            };
            let add = |totals: &mut CostTotals| match kind {
                CostKind::Actual => totals.actual += usd,
                CostKind::Estimated => totals.estimated += usd,
            };
            add(&mut state.cost);
            if let Some(n) = node(state, event) {
                add(&mut n.cost);
                n.cost_reported = true;
            }
        }
        EventBody::ApprovalRequested(request) => {
            state.approvals.retain(|a| a.node_key != request.node_key);
            state.approvals.push(request.clone());
        }
        EventBody::Approval { .. } => {
            let key = event.node_key.clone();
            state.approvals.retain(|a| a.node_key != key);
        }
        EventBody::Process {
            pid,
            started_at,
            exit_file,
        } => {
            if let Some(n) = node(state, event) {
                n.process = Some(ProcessInfo {
                    pid: *pid,
                    started_at: started_at.clone(),
                    exit_file: exit_file.clone(),
                });
            }
        }
        EventBody::BudgetRaised { limit_usd } => {
            state.budget_limit_usd = Some(*limit_usd);
        }
        EventBody::Warning(_) => {}
        EventBody::ScopeStarted {
            prefix,
            init,
            nodes,
        } => {
            state.scopes.insert(
                prefix.clone(),
                ScopeRecord {
                    init: init.clone(),
                    status: ScopeStatus::Running,
                    outputs: BTreeMap::new(),
                    order: event.seq,
                },
            );
            for id in nodes {
                let key = state.current_key(prefix, id);
                state.nodes.entry(key).or_default();
            }
        }
        EventBody::ScopeFinished {
            prefix,
            status,
            outputs,
        } => {
            if let Some(scope) = state.scopes.get_mut(prefix) {
                scope.status = *status;
                scope.outputs = outputs.clone();
            }
        }
        EventBody::LoopItems {
            items,
            limit_reached,
        } => {
            if let Some(key) = event.node_key.clone() {
                state.loops.insert(
                    key,
                    LoopRecord {
                        items: items.clone(),
                        limit_reached: *limit_reached,
                    },
                );
            }
        }
        EventBody::Traversal { scope, edge, count } => {
            state.traversals.insert(format!("{scope}#{edge}"), *count);
        }
        EventBody::NewPass { scope, ids } => {
            for id in ids {
                let pass = state.pass(scope, id) + 1;
                state.passes.insert(format!("{scope}{id}"), pass);
                state.nodes.insert(
                    crate::flow::run::scope::instance_key(scope, id, pass),
                    NodeState::new(),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn run_transition_table_is_exhaustive() {
        use RunStatus::*;
        let allowed: &[(RunStatus, RunStatus)] = &[
            (Pending, Running),
            (Running, AwaitingApproval),
            (AwaitingApproval, Running),
            (Running, Stopping),
            (AwaitingApproval, Stopping),
            (Stopping, Paused),
            (Paused, Running),
            (Interrupted, Running),
            (Failed, Running),
            (Running, Completed),
            (Running, Failed),
            (Running, Interrupted),
            (AwaitingApproval, Interrupted),
            (Stopping, Interrupted),
            (Pending, Cancelled),
            (Running, Cancelled),
            (AwaitingApproval, Cancelled),
            (Stopping, Cancelled),
            (Paused, Cancelled),
            (Interrupted, Cancelled),
            (Failed, Cancelled),
        ];
        for from in RunStatus::ALL {
            for to in RunStatus::ALL {
                assert_eq!(
                    run_transition_allowed(from, to),
                    allowed.contains(&(from, to)),
                    "{from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn node_transition_table_is_exhaustive() {
        use NodeStatus::*;
        let allowed: &[(NodeStatus, NodeStatus)] = &[
            (Pending, Ready),
            (Pending, Skipped),
            (Ready, Running),
            (Running, Succeeded),
            (Running, Failed),
            (Running, AwaitingApproval),
            (Running, RetryWait),
            (Running, Cancelled),
            (Running, Interrupted),
            (Running, Ready),
            (AwaitingApproval, Succeeded),
            (AwaitingApproval, Failed),
            (RetryWait, Ready),
            (Failed, Ready),
            (Failed, Succeeded),
            (Interrupted, Ready),
            (Cancelled, Ready),
            (Skipped, Pending),
            (AwaitingApproval, Cancelled),
        ];
        for from in NodeStatus::ALL {
            for to in NodeStatus::ALL {
                assert_eq!(
                    node_transition_allowed(from, to),
                    allowed.contains(&(from, to)),
                    "{from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn events_use_the_spec_shape() {
        let event = FlowEvent {
            seq: 3,
            ts: "2026-10-06T00:00:00.000Z".into(),
            node_key: Some("collect".into()),
            body: EventBody::NodeStatus {
                from: NodeStatus::Ready,
                to: NodeStatus::Running,
                attempt: 1,
                reason: None,
                port: None,
            },
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            json!({
                "seq": 3, "ts": "2026-10-06T00:00:00.000Z", "nodeKey": "collect",
                "type": "node_status", "data": { "from": "ready", "to": "running", "attempt": 1 }
            })
        );
        let back: FlowEvent = serde_json::from_value(value).unwrap();
        assert_eq!(back, event);
        // A run-level event has no nodeKey.
        let run = FlowEvent {
            seq: 1,
            ts: "t".into(),
            node_key: None,
            body: EventBody::RunStatus {
                from: RunStatus::Pending,
                to: RunStatus::Running,
                reason: Some(Reason::new("X").with("a", 1)),
            },
        };
        let value = serde_json::to_value(&run).unwrap();
        assert_eq!(value["type"], "run_status");
        assert!(value.get("nodeKey").is_none());
        assert_eq!(serde_json::from_value::<FlowEvent>(value).unwrap(), run);
        // Every body round-trips.
        let bodies = vec![
            EventBody::NodeOutput {
                key: "k".into(),
                value: json!([1, 2]),
            },
            EventBody::NodeArtifact {
                path: "p".into(),
                label: Some("l".into()),
            },
            EventBody::NodeProgress {
                text: "t".into(),
                fraction: Some(0.5),
            },
            EventBody::Cost {
                usd: 1.5,
                kind: CostKind::Estimated,
                provider: Some("p".into()),
                model: None,
                units: Some(json!({ "tokens_in": 1 })),
            },
            EventBody::ApprovalRequested(ApprovalRequest {
                node_key: Some("a".into()),
                options: vec!["approve".into(), "reject".into()],
                message: Some("m".into()),
                show: BTreeMap::from([("nodes.x.outputs.y".to_string(), json!(1))]),
                reason: Reason::new("FLOW_APPROVAL_NODE"),
            }),
            EventBody::Approval {
                choice: "approve".into(),
                comment: None,
                by: "user".into(),
            },
            EventBody::Process {
                pid: 42,
                started_at: "s".into(),
                exit_file: None,
            },
            EventBody::BudgetRaised { limit_usd: 20.0 },
            EventBody::Warning(Reason::new("W")),
        ];
        for body in bodies {
            let event = FlowEvent {
                seq: 9,
                ts: "t".into(),
                node_key: Some("n".into()),
                body,
            };
            let text = serde_json::to_string(&event).unwrap();
            assert_eq!(
                serde_json::from_str::<FlowEvent>(&text).unwrap(),
                event,
                "{text}"
            );
        }
    }

    #[test]
    fn scope_events_round_trip_and_reduce() {
        use crate::flow::run::scope::GraphLoc;
        let init = ScopeInit {
            owner: Some("docs".into()),
            parent: Some(String::new()),
            inherits: true,
            graph: GraphLoc {
                file: "f.flow.yaml".into(),
                path: vec!["docs".into()],
            },
            params: BTreeMap::new(),
            var: Some("doc".into()),
            item: Some(json!("a")),
            index: Some(0),
        };
        let bodies = vec![
            EventBody::ScopeStarted {
                prefix: "docs[0]/".into(),
                init: init.clone(),
                nodes: vec!["proc".into()],
            },
            EventBody::ScopeFinished {
                prefix: "docs[0]/".into(),
                status: ScopeStatus::Completed,
                outputs: BTreeMap::from([("k".to_string(), json!(1))]),
            },
            EventBody::LoopItems {
                items: vec![json!("a")],
                limit_reached: true,
            },
            EventBody::Traversal {
                scope: String::new(),
                edge: 2,
                count: 1,
            },
            EventBody::NewPass {
                scope: String::new(),
                ids: vec!["gen".into()],
            },
        ];
        let mut state = RunState::new(["docs", "gen"]);
        for (i, body) in bodies.into_iter().enumerate() {
            let event = FlowEvent {
                seq: i as u64 + 1,
                ts: "t".into(),
                node_key: Some("docs".into()),
                body,
            };
            let text = serde_json::to_string(&event).unwrap();
            assert_eq!(
                serde_json::from_str::<FlowEvent>(&text).unwrap(),
                event,
                "{text}"
            );
            apply(&mut state, &event);
        }
        let scope = &state.scopes["docs[0]/"];
        assert_eq!(scope.init, init);
        assert_eq!(scope.status, ScopeStatus::Completed);
        assert_eq!(scope.order, 1);
        assert!(state.nodes.contains_key("docs[0]/proc"));
        assert!(state.loops["docs"].limit_reached);
        assert_eq!(state.traversals["#2"], 1);
        assert_eq!(state.pass("", "gen"), 2);
        assert_eq!(state.current_key("", "gen"), "gen@2");
        assert_eq!(state.nodes["gen@2"].status, NodeStatus::Pending);
        assert_eq!(
            state.nodes["gen"].status,
            NodeStatus::Pending,
            "the old instance stays"
        );
    }

    fn ev(seq: u64, node: Option<&str>, body: EventBody) -> FlowEvent {
        FlowEvent {
            seq,
            ts: format!("t{seq}"),
            node_key: node.map(String::from),
            body,
        }
    }

    #[test]
    fn reducer_tracks_nodes_costs_and_approvals() {
        let mut state = RunState::new(["a", "b"]);
        let events = vec![
            ev(
                1,
                None,
                EventBody::RunStatus {
                    from: RunStatus::Pending,
                    to: RunStatus::Running,
                    reason: None,
                },
            ),
            ev(
                2,
                Some("a"),
                EventBody::NodeStatus {
                    from: NodeStatus::Pending,
                    to: NodeStatus::Ready,
                    attempt: 0,
                    reason: None,
                    port: None,
                },
            ),
            ev(
                3,
                Some("a"),
                EventBody::NodeStatus {
                    from: NodeStatus::Ready,
                    to: NodeStatus::Running,
                    attempt: 1,
                    reason: None,
                    port: None,
                },
            ),
            ev(
                4,
                Some("a"),
                EventBody::Process {
                    pid: 7,
                    started_at: "s".into(),
                    exit_file: None,
                },
            ),
            ev(
                5,
                Some("a"),
                EventBody::Cost {
                    usd: 1.0,
                    kind: CostKind::Actual,
                    provider: None,
                    model: None,
                    units: None,
                },
            ),
            ev(
                6,
                Some("a"),
                EventBody::Cost {
                    usd: 0.5,
                    kind: CostKind::Estimated,
                    provider: None,
                    model: None,
                    units: None,
                },
            ),
            ev(
                7,
                Some("a"),
                EventBody::NodeOutput {
                    key: "n".into(),
                    value: json!(3),
                },
            ),
            ev(
                8,
                Some("a"),
                EventBody::NodeStatus {
                    from: NodeStatus::Running,
                    to: NodeStatus::Succeeded,
                    attempt: 1,
                    reason: None,
                    port: Some("success".into()),
                },
            ),
            ev(
                9,
                Some("b"),
                EventBody::ApprovalRequested(ApprovalRequest {
                    node_key: Some("b".into()),
                    options: vec!["ok".into()],
                    message: None,
                    show: BTreeMap::new(),
                    reason: Reason::new("FLOW_APPROVAL_NODE"),
                }),
            ),
        ];
        for e in &events {
            apply(&mut state, e);
        }
        assert_eq!(state.seq, 9);
        let a = &state.nodes["a"];
        assert_eq!(a.status, NodeStatus::Succeeded);
        assert_eq!(a.port.as_deref(), Some("success"));
        assert_eq!(a.outputs["n"], json!(3));
        assert!(a.process.is_none(), "settled nodes forget their process");
        assert_eq!(
            a.cost,
            CostTotals {
                actual: 1.0,
                estimated: 0.5
            }
        );
        assert_eq!(state.cost.total(), 1.5);
        assert_eq!(state.approvals.len(), 1);
        apply(
            &mut state,
            &ev(
                10,
                Some("b"),
                EventBody::Approval {
                    choice: "ok".into(),
                    comment: None,
                    by: "u".into(),
                },
            ),
        );
        assert!(state.approvals.is_empty());
        apply(
            &mut state,
            &ev(11, None, EventBody::BudgetRaised { limit_usd: 3.0 }),
        );
        assert_eq!(state.budget_limit_usd, Some(3.0));
        // Unknown node keys never panic.
        apply(
            &mut state,
            &ev(
                12,
                Some("zzz"),
                EventBody::NodeProgress {
                    text: "x".into(),
                    fraction: None,
                },
            ),
        );
        assert!(state.nodes.contains_key("zzz"));
    }
}

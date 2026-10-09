//! The run driver (spec 4.2–4.8): one thread per run that owns the run's
//! event log. Each tick it polls running commands, applies controls,
//! settles pending nodes in every live scope (joins, `when`, skipped
//! propagation), advances loops and sub-flows, follows back-edges into new
//! passes, and starts ready nodes. State only ever changes by appending an
//! event and applying it (see [`Driver::emit`]).
//!
//! PR 4a: scopes (loops, sub-flows), branches and back-edges. Commands run
//! one at a time; concurrency limits are PR 4b.

use crate::flow::condition::Condition;
use crate::flow::model::{
    parse_duration, CommandNode, CommandProtocol, CommandRun, FlowDef, FlowNode, LoopBody,
    LoopMode, LoopNode, NodeKind, OnItemFailure, RetryOn, RetryPolicy, PORT_FAILURE, PORT_SUCCESS,
};
use crate::flow::run::model::*;
use crate::flow::run::prepare::{prepare_params, LoopVar, TemplateContext};
use crate::flow::run::process::{
    decide, CommandResult, LaunchSpec, Launcher, ProcessHandle, ProtocolItem, ProtocolOutcome,
    ProtocolReader,
};
use crate::flow::run::scope::{
    self, iteration_prefix, ref_key, split_key, subflow_prefix, Graph, GraphLoc,
};
use crate::flow::run::store::{EventLog, RunMeta, RunStore, CHECKPOINT_EVERY};
use crate::flow::run::supervise::DetachedProcess;
use crate::flow::template;
use crate::workflow::fsutil;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

// Reason codes recorded by the driver.
pub const FLOW_NODE_FAILED: &str = "FLOW_NODE_FAILED";
pub const FLOW_NODE_TIMEOUT: &str = "FLOW_NODE_TIMEOUT";
pub const FLOW_NODE_STOPPED: &str = "FLOW_NODE_STOPPED";
pub const FLOW_STOP_GRACE_EXCEEDED: &str = "FLOW_STOP_GRACE_EXCEEDED";
pub const FLOW_STOP_REQUESTED: &str = "FLOW_STOP_REQUESTED";
pub const FLOW_RUN_CANCELLED: &str = "FLOW_RUN_CANCELLED";
pub const FLOW_APP_EXITED: &str = "FLOW_APP_EXITED";
/// A running node's process could not be reconnected after a restart.
pub const FLOW_PROCESS_LOST: &str = "FLOW_PROCESS_LOST";
pub const FLOW_BUDGET_EXCEEDED: &str = "FLOW_BUDGET_EXCEEDED";
pub const FLOW_APPROVAL_NODE: &str = "FLOW_APPROVAL_NODE";
pub const FLOW_COMMAND_NEEDS_APPROVAL: &str = "FLOW_COMMAND_NEEDS_APPROVAL";
pub const FLOW_COMMAND_SPAWN_FAILED: &str = "FLOW_COMMAND_SPAWN_FAILED";
pub const FLOW_CONDITION_TYPE: &str = "FLOW_CONDITION_TYPE";
pub const FLOW_APPROVAL_REJECTED: &str = "FLOW_APPROVAL_REJECTED";
pub const FLOW_PROTOCOL_WARNING: &str = "FLOW_PROTOCOL_WARNING";
pub const FLOW_RESUMED: &str = "FLOW_RESUMED";
/// A back-edge was traversed `maxTraversals` times already.
pub const FLOW_TRAVERSAL_LIMIT: &str = "FLOW_TRAVERSAL_LIMIT";
/// No branch case matched and there is no `default`.
pub const FLOW_BRANCH_NO_MATCH: &str = "FLOW_BRANCH_NO_MATCH";
/// A `foreach` loop's `items` did not resolve to an array.
pub const FLOW_LOOP_ITEMS_INVALID: &str = "FLOW_LOOP_ITEMS_INVALID";
/// A loop iteration failed (with `onItemFailure: stop`).
pub const FLOW_LOOP_ITERATION_FAILED: &str = "FLOW_LOOP_ITERATION_FAILED";
/// A sub-flow (or file loop body) failed.
pub const FLOW_SUBFLOW_FAILED: &str = "FLOW_SUBFLOW_FAILED";
/// A referenced flow is missing from the run snapshot.
pub const FLOW_SUBFLOW_MISSING: &str = "FLOW_SUBFLOW_MISSING";
/// A node instance was retired because a back-edge opened a new pass.
pub const FLOW_PASS_RESET: &str = "FLOW_PASS_RESET";
/// No node can make progress (should not happen; reported instead of hanging).
pub const FLOW_RUN_STUCK: &str = "FLOW_RUN_STUCK";
/// A scope output could not be rendered (warning; the output is left out).
pub const FLOW_OUTPUT_UNRESOLVED: &str = "FLOW_OUTPUT_UNRESOLVED";

/// Options of a budget approval.
pub const BUDGET_OPTIONS: [&str; 2] = ["approve", "stop"];
/// Options of a command that reported `needs_approval`.
pub const COMMAND_APPROVAL_OPTIONS: [&str; 2] = ["approve", "reject"];

/// Requests from the engine to a running driver.
#[derive(Debug, Clone, PartialEq)]
pub enum Control {
    /// Cooperative stop (the STOP file is created by the engine).
    Stop,
    Cancel,
    /// App exit: kill attached processes (detached ones keep running).
    Shutdown,
    Approve {
        node_key: Option<String>,
        choice: String,
        comment: Option<String>,
        by: String,
    },
}

/// Receives state changes for the UI (Tauri events in the app, fakes in tests).
pub trait EventSink: Send + Sync {
    fn run_changed(&self, project_root: &Path, run_id: &str, state: &RunState);
    fn node_changed(
        &self,
        project_root: &Path,
        run_id: &str,
        node_key: &str,
        node: &NodeState,
        seq: u64,
    );
    fn progress(&self, project_root: &Path, run_id: &str, node_key: &str, progress: &Progress);
}

/// Extension point for approval notifications (spec 6.5). Implementations
/// must not block; failures must not affect the run.
pub trait ApprovalNotifier: Send + Sync {
    fn approval_requested(&self, project_root: &Path, run_id: &str, request: &ApprovalRequest);
}

/// Shared services of all drivers.
#[derive(Clone)]
pub struct DriverEnv {
    pub launcher: Arc<dyn Launcher>,
    /// Launcher for `detach: true` commands (the default); `None` runs them attached.
    pub detached: Option<Arc<dyn Launcher>>,
    pub sink: Arc<dyn EventSink>,
    pub notifiers: Arc<Vec<Arc<dyn ApprovalNotifier>>>,
    /// Process environment visible to `env.*` templates (passthrough filtered per flow).
    pub process_env: Arc<BTreeMap<String, String>>,
    /// How often running processes and the STOP file are polled.
    pub poll: Duration,
}

/// Minimum interval between persisted progress events of one node.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
/// Commands running at once in a run (PR 4b makes this configurable).
const MAX_RUNNING_COMMANDS: usize = 1;

/// A command being monitored.
struct RunningCommand {
    key: String,
    attempt: u32,
    dir: PathBuf,
    success_codes: Vec<i32>,
    handle: Box<dyn ProcessHandle>,
    reader: Option<ProtocolReader>,
    outcome: Option<ProtocolOutcome>,
    started: Instant,
    timeout: Option<Duration>,
    grace_deadline: Option<Instant>,
    last_progress: Option<Instant>,
    pending_progress: Option<(String, Option<f64>)>,
}

/// How a command's monitoring ended.
enum Finish {
    Exited(i32),
    Timeout,
    GraceKilled,
}

pub struct Driver {
    store: RunStore,
    run_id: String,
    meta: RunMeta,
    state: RunState,
    log: EventLog,
    since_checkpoint: u64,
    ctrl: Receiver<Control>,
    env: DriverEnv,
    stop_requested: bool,
    cancel_requested: bool,
    shutdown_requested: bool,
    running: Vec<RunningCommand>,
    retry_at: BTreeMap<String, Instant>,
}

impl Driver {
    /// Opens the run's log and state.
    pub fn open(
        store: RunStore,
        run_id: &str,
        ctrl: Receiver<Control>,
        env: DriverEnv,
    ) -> Result<Self, String> {
        let meta = store.load_meta(run_id).map_err(|e| e.to_string())?;
        let state = store.load_state(run_id, &meta).map_err(|e| e.to_string())?;
        let log = store.open_log(run_id).map_err(|e| e.to_string())?;
        Ok(Self {
            store,
            run_id: run_id.to_string(),
            meta,
            state,
            log,
            since_checkpoint: 0,
            ctrl,
            env,
            stop_requested: false,
            cancel_requested: false,
            shutdown_requested: false,
            running: Vec::new(),
            retry_at: BTreeMap::new(),
        })
    }

    pub fn state(&self) -> &RunState {
        &self.state
    }

    // ------------------------------------------------------------ events

    /// Appends an event, applies it and notifies the sink.
    fn emit(&mut self, node_key: Option<&str>, body: EventBody) {
        let event = FlowEvent {
            seq: self.state.seq + 1,
            ts: fsutil::now(),
            node_key: node_key.map(String::from),
            body,
        };
        if let Err(err) = self.log.append(&event) {
            eprintln!(
                "[flow] failed to append event for run {}: {err}",
                self.run_id
            );
        }
        apply(&mut self.state, &event);
        self.since_checkpoint += 1;
        if event.body.is_status() || self.since_checkpoint >= CHECKPOINT_EVERY {
            self.checkpoint();
        }
        let root = self.store.project_root().to_path_buf();
        let run_level = matches!(
            event.body,
            EventBody::RunStatus { .. }
                | EventBody::BudgetRaised { .. }
                | EventBody::Cost { .. }
                | EventBody::ApprovalRequested(_)
                | EventBody::Approval { .. }
        );
        match (&event.body, node_key) {
            (EventBody::NodeProgress { .. }, Some(key)) => {
                if let Some(progress) = self.state.nodes.get(key).and_then(|n| n.progress.as_ref())
                {
                    self.env.sink.progress(&root, &self.run_id, key, progress);
                }
            }
            (EventBody::Warning(_), _) => {}
            (_, Some(key)) => {
                if let Some(node) = self.state.nodes.get(key) {
                    self.env
                        .sink
                        .node_changed(&root, &self.run_id, key, node, self.state.seq);
                }
            }
            _ => {}
        }
        if run_level {
            self.env.sink.run_changed(&root, &self.run_id, &self.state);
        }
        if let EventBody::ApprovalRequested(request) = &event.body {
            for notifier in self.env.notifiers.iter() {
                notifier.approval_requested(&root, &self.run_id, request);
            }
        }
    }

    fn checkpoint(&mut self) {
        if let Err(err) = self.store.write_checkpoint(&self.run_id, &self.state) {
            eprintln!(
                "[flow] failed to write checkpoint for run {}: {err}",
                self.run_id
            );
        }
        self.since_checkpoint = 0;
    }

    /// Moves the run if the table allows it (optimistic check on the current status).
    fn set_run(&mut self, to: RunStatus, reason: Option<Reason>) -> bool {
        let from = self.state.status;
        if from == to || !run_transition_allowed(from, to) {
            return false;
        }
        self.emit(None, EventBody::RunStatus { from, to, reason });
        true
    }

    fn set_node(
        &mut self,
        key: &str,
        to: NodeStatus,
        attempt: u32,
        reason: Option<Reason>,
        port: Option<String>,
    ) -> bool {
        let from = self
            .state
            .nodes
            .get(key)
            .map(|n| n.status)
            .unwrap_or(NodeStatus::Pending);
        if !node_transition_allowed(from, to) {
            eprintln!("[flow] rejected node transition {from:?} -> {to:?} for {key}");
            return false;
        }
        self.emit(
            Some(key),
            EventBody::NodeStatus {
                from,
                to,
                attempt,
                reason,
                port,
            },
        );
        true
    }

    fn node(&self, key: &str) -> NodeState {
        self.state.nodes.get(key).cloned().unwrap_or_default()
    }

    // ------------------------------------------------------------ scopes

    /// The root scope as recorded, or as implied for runs recorded before scopes.
    fn root_init(&self) -> ScopeInit {
        ScopeInit {
            owner: None,
            parent: None,
            inherits: false,
            graph: GraphLoc {
                file: self.meta.flow_path.clone(),
                path: Vec::new(),
            },
            params: self.meta.params.clone(),
            var: None,
            item: None,
            index: None,
        }
    }

    fn scope_init(&self, prefix: &str) -> Option<ScopeInit> {
        match self.state.scopes.get(prefix) {
            Some(scope) => Some(scope.init.clone()),
            None if prefix.is_empty() => Some(self.root_init()),
            None => None,
        }
    }

    fn scope_running(&self, prefix: &str) -> bool {
        match self.state.scopes.get(prefix) {
            Some(scope) => scope.status == ScopeStatus::Running,
            None => prefix.is_empty(),
        }
    }

    fn graph_of(&self, prefix: &str) -> Option<Graph<'_>> {
        let init = self.scope_init(prefix)?;
        scope::graph(&self.meta, &init.graph).map(|g| {
            // Rebind the lifetime to `self.meta` (init is a temporary copy).
            Graph {
                nodes: g.nodes,
                edges: g.edges,
                outputs: g.outputs,
                flow: g.flow,
            }
        })
    }

    /// `(prefix, node definition)` of an instance key.
    fn def_of(&self, key: &str) -> Option<(String, FlowNode)> {
        let (prefix, id, _) = split_key(key);
        let node = self.graph_of(prefix)?.node(id)?.clone();
        Some((prefix.to_string(), node))
    }

    /// The file flow a scope belongs to (defaults, env, envPassthrough).
    fn file_flow(&self, prefix: &str) -> &FlowDef {
        self.graph_of(prefix)
            .map(|g| g.flow)
            .unwrap_or(&self.meta.flow)
    }

    /// Ids of a scope's graph, in definition order.
    fn ids(&self, prefix: &str) -> Vec<String> {
        self.graph_of(prefix)
            .map(|g| g.nodes.iter().map(|n| n.id.clone()).collect())
            .unwrap_or_default()
    }

    /// True if a failure of `key` is handled (a failure edge leaves it).
    pub fn has_failure_edge(&self, key: &str) -> bool {
        let (prefix, id, _) = split_key(key);
        self.graph_of(prefix)
            .is_some_and(|g| g.has_edge_from(id, PORT_FAILURE))
    }

    /// The instance is its node's current pass (older passes are history).
    pub fn is_current(&self, key: &str) -> bool {
        let (prefix, id, _) = split_key(key);
        self.state.current_key(prefix, id) == key
    }

    /// The instance's scope is live (the root, or a running child scope).
    pub fn in_live_scope(&self, key: &str) -> bool {
        self.scope_running(split_key(key).0)
    }

    pub fn is_composite(&self, key: &str) -> bool {
        matches!(
            self.def_of(key).map(|(_, n)| n.kind),
            Some(NodeKind::Loop(_) | NodeKind::Subflow(_))
        )
    }

    /// Loop variables visible in a scope, innermost last.
    fn vars(&self, prefix: &str) -> Vec<LoopVar> {
        let mut vars = Vec::new();
        let mut current = prefix.to_string();
        while let Some(init) = self.scope_init(&current) {
            if let (Some(name), Some(item), Some(index)) =
                (init.var.clone(), init.item.clone(), init.index)
            {
                vars.push(LoopVar { name, item, index });
            }
            match (init.inherits, init.parent) {
                (true, Some(parent)) => current = parent,
                _ => break,
            }
        }
        vars.reverse();
        vars
    }

    /// Outputs of node `id` as seen from a scope (inline bodies see outward).
    fn outputs_seen(&self, prefix: &str, id: &str) -> Option<BTreeMap<String, Value>> {
        let mut current = prefix.to_string();
        loop {
            if self.graph_of(&current)?.node(id).is_some() {
                let key = self.state.current_key(&current, id);
                return self.state.nodes.get(&key).map(|n| n.outputs.clone());
            }
            let init = self.scope_init(&current)?;
            match (init.inherits, init.parent) {
                (true, Some(parent)) => current = parent,
                _ => return None,
            }
        }
    }

    fn passthrough_env(&self, prefix: &str) -> BTreeMap<String, String> {
        self.file_flow(prefix)
            .env_passthrough
            .iter()
            .filter_map(|name| {
                self.env
                    .process_env
                    .get(name)
                    .map(|v| (name.clone(), v.clone()))
            })
            .collect()
    }

    fn run_dir(&self) -> PathBuf {
        self.store.run_dir(&self.run_id).unwrap_or_default()
    }

    /// Runs `f` with the template context of a scope.
    fn with_ctx<R>(
        &self,
        prefix: &str,
        extra_var: Option<LoopVar>,
        node_dir: Option<&Path>,
        iteration: Option<&BTreeMap<String, Value>>,
        f: impl FnOnce(&TemplateContext) -> R,
    ) -> R {
        let run_dir = self.run_dir();
        let env = self.passthrough_env(prefix);
        let mut vars = self.vars(prefix);
        vars.extend(extra_var);
        let params = self
            .scope_init(prefix)
            .map(|i| i.params)
            .unwrap_or_default();
        let lookup = |id: &str| self.outputs_seen(prefix, id);
        let ctx = TemplateContext {
            params: &params,
            outputs: &lookup,
            vars: &vars,
            iteration,
            run_id: &self.run_id,
            run_dir: &run_dir,
            node_dir,
            project_root: self.store.project_root(),
            env: &env,
        };
        f(&ctx)
    }

    fn evaluate(
        &self,
        prefix: &str,
        condition: &Condition,
        iteration: Option<&BTreeMap<String, Value>>,
    ) -> Result<bool, Reason> {
        self.with_ctx(prefix, None, None, iteration, |ctx| {
            condition.evaluate(&|r| ctx.resolve(r)).map_err(|e| {
                Reason::new(FLOW_CONDITION_TYPE)
                    .with("ref", e.reference)
                    .with("op", e.op)
            })
        })
    }

    /// Live scopes in the order they were opened.
    fn live_scopes(&self) -> Vec<String> {
        let mut scopes: Vec<(u64, String)> = self
            .state
            .scopes
            .iter()
            .filter(|(_, s)| s.status == ScopeStatus::Running)
            .map(|(p, s)| (s.order, p.clone()))
            .collect();
        scopes.sort();
        scopes.into_iter().map(|(_, p)| p).collect()
    }

    fn ensure_root(&mut self) {
        if self.state.scopes.contains_key("") {
            return;
        }
        let init = self.root_init();
        let nodes = self.meta.flow.nodes.iter().map(|n| n.id.clone()).collect();
        self.emit(
            None,
            EventBody::ScopeStarted {
                prefix: String::new(),
                init,
                nodes,
            },
        );
    }

    // ----------------------------------------------------------- controls

    fn handle_control(&mut self, control: Control) {
        match control {
            Control::Stop => self.stop_requested = true,
            Control::Cancel => self.cancel_requested = true,
            Control::Shutdown => self.shutdown_requested = true,
            Control::Approve {
                node_key,
                choice,
                comment,
                by,
            } => {
                self.apply_approval(node_key.as_deref(), &choice, comment, &by);
            }
        }
    }

    fn drain_controls(&mut self) {
        while let Ok(control) = self.ctrl.try_recv() {
            self.handle_control(control);
        }
        if self
            .store
            .stop_file(&self.run_id)
            .map(|p| p.exists())
            .unwrap_or(false)
        {
            self.stop_requested = true;
        }
    }

    /// Waits for a control (or the poll interval) and handles it.
    fn wait_control(&mut self, timeout: Duration) {
        match self.ctrl.recv_timeout(timeout) {
            Ok(control) => self.handle_control(control),
            Err(RecvTimeoutError::Timeout) => {}
            // The engine is gone: behave like an app exit.
            Err(RecvTimeoutError::Disconnected) => self.shutdown_requested = true,
        }
        self.drain_controls();
    }

    /// Applies an approval decision. Invalid decisions are ignored (the
    /// engine validated them against the same state before sending).
    pub fn apply_approval(
        &mut self,
        node_key: Option<&str>,
        choice: &str,
        comment: Option<String>,
        by: &str,
    ) -> bool {
        let Some(request) = self
            .state
            .approvals
            .iter()
            .find(|a| a.node_key.as_deref() == node_key)
            .cloned()
        else {
            return false;
        };
        if !request.options.iter().any(|o| o == choice) {
            return false;
        }
        self.emit(
            node_key,
            EventBody::Approval {
                choice: choice.to_string(),
                comment,
                by: by.to_string(),
            },
        );
        match node_key {
            None => {
                if choice == "approve" {
                    let base = self.meta.flow.limits.budget_usd.unwrap_or(0.0);
                    let current = self
                        .state
                        .budget_limit_usd
                        .or(self.meta.flow.limits.budget_usd)
                        .unwrap_or(0.0);
                    let raised = current.max(self.state.cost.total()) + base;
                    self.emit(None, EventBody::BudgetRaised { limit_usd: raised });
                } else {
                    self.stop_requested = true;
                }
            }
            Some(key) => {
                let attempt = self.node(key).attempt;
                let is_approval_node = matches!(
                    self.def_of(key).map(|(_, n)| n.kind),
                    Some(NodeKind::Approval(_))
                );
                if is_approval_node {
                    self.settle(key, attempt, NodeStatus::Succeeded, choice, None);
                } else if choice == "approve" {
                    self.settle(key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None);
                } else {
                    self.fail_node(key, attempt, Reason::new(FLOW_APPROVAL_REJECTED));
                }
            }
        }
        true
    }

    // ------------------------------------------------------- settling

    /// Settles a node through `port`, following back-edges into new passes
    /// (or failing the node when a back-edge is exhausted).
    pub fn settle(
        &mut self,
        key: &str,
        attempt: u32,
        status: NodeStatus,
        port: &str,
        reason: Option<Reason>,
    ) {
        let (prefix, id, _) = split_key(key);
        let (prefix, id) = (prefix.to_string(), id.to_string());
        let back: Vec<(usize, String, u32)> = self
            .graph_of(&prefix)
            .map(|g| {
                g.back_edges(&id, port)
                    .into_iter()
                    .map(|(i, e)| (i, e.to.clone(), e.max_traversals.unwrap_or(0)))
                    .collect()
            })
            .unwrap_or_default();
        for (i, _, max) in &back {
            let count = self
                .state
                .traversals
                .get(&format!("{prefix}#{i}"))
                .copied()
                .unwrap_or(0);
            if count >= *max {
                let exhausted = Reason::new(FLOW_TRAVERSAL_LIMIT)
                    .with("edge", *i)
                    .with("max", *max);
                self.set_node(
                    key,
                    NodeStatus::Failed,
                    attempt,
                    Some(exhausted.clone()),
                    Some(PORT_FAILURE.into()),
                );
                // Only a forward failure edge can handle an exhausted cycle.
                let handled = self.graph_of(&prefix).is_some_and(|g| {
                    g.forward()
                        .any(|e| e.from == id && e.port() == PORT_FAILURE)
                });
                if !handled {
                    self.fail_scope(&prefix, key, exhausted);
                }
                return;
            }
        }
        self.set_node(key, status, attempt, reason.clone(), Some(port.to_string()));
        for (i, target, _) in &back {
            let count = self
                .state
                .traversals
                .get(&format!("{prefix}#{i}"))
                .copied()
                .unwrap_or(0);
            self.emit(
                Some(key),
                EventBody::Traversal {
                    scope: prefix.clone(),
                    edge: *i,
                    count: count + 1,
                },
            );
            self.open_pass(&prefix, target, &id);
        }
        if status == NodeStatus::Failed && back.is_empty() && !self.has_failure_edge(key) {
            self.fail_scope(
                &prefix,
                key,
                reason.unwrap_or_else(|| Reason::new(FLOW_NODE_FAILED)),
            );
        }
    }

    /// Opens a new pass of the cycle `target → … → source` and re-arms
    /// downstream nodes that were skipped because of it.
    fn open_pass(&mut self, prefix: &str, target: &str, source: &str) {
        let Some((cycle, downstream)) = self.graph_of(prefix).map(|g| {
            let cycle = g.cycle(target, source);
            let downstream = g.downstream(&cycle);
            (cycle, downstream)
        }) else {
            return;
        };
        for id in &cycle {
            let key = self.state.current_key(prefix, id);
            self.retire(&key);
        }
        self.emit(
            None,
            EventBody::NewPass {
                scope: prefix.to_string(),
                ids: cycle.into_iter().collect(),
            },
        );
        self.rearm(prefix, &downstream);
    }

    /// Skipped-without-port nodes become pending again (spec 2.4 re-arm rule).
    fn rearm(&mut self, prefix: &str, ids: &BTreeSet<String>) {
        for id in ids {
            let key = self.state.current_key(prefix, id);
            let node = self.node(&key);
            if node.status == NodeStatus::Skipped && node.port.is_none() {
                self.set_node(&key, NodeStatus::Pending, 0, None, None);
            }
        }
    }

    /// Ends an instance that a new pass replaces while it is still active.
    fn retire(&mut self, key: &str) {
        let node = self.node(key);
        let reason = Some(Reason::new(FLOW_PASS_RESET));
        match node.status {
            NodeStatus::Running => {
                if let Some(pos) = self.running.iter().position(|r| r.key == key) {
                    let mut command = self.running.remove(pos);
                    command.handle.kill_tree();
                }
                self.close_children(key);
                self.set_node(key, NodeStatus::Cancelled, node.attempt, reason, None);
            }
            NodeStatus::AwaitingApproval => {
                self.set_node(key, NodeStatus::Cancelled, node.attempt, reason, None);
            }
            NodeStatus::RetryWait => {
                self.retry_at.remove(key);
            }
            _ => {}
        }
    }

    /// Fails every live scope owned (directly or not) by a node instance.
    fn close_children(&mut self, owner: &str) {
        let doomed: Vec<String> = self
            .state
            .scopes
            .iter()
            .filter(|(p, s)| {
                s.status == ScopeStatus::Running
                    && (p.starts_with(&format!("{owner}/")) || p.starts_with(&format!("{owner}[")))
            })
            .map(|(p, _)| p.clone())
            .collect();
        for prefix in doomed {
            let running: Vec<String> = self
                .running
                .iter()
                .filter(|r| r.key.starts_with(&prefix))
                .map(|r| r.key.clone())
                .collect();
            for key in running {
                self.retire(&key);
            }
            self.emit(
                None,
                EventBody::ScopeFinished {
                    prefix,
                    status: ScopeStatus::Failed,
                    outputs: BTreeMap::new(),
                },
            );
        }
    }

    /// Marks a node failed (port `failure`), or retries it per its policy.
    fn fail_node(&mut self, key: &str, attempt: u32, reason: Reason) {
        self.settle(key, attempt, NodeStatus::Failed, PORT_FAILURE, Some(reason));
    }

    /// An unhandled failure in a scope: the run fails (root) or the scope
    /// fails and its owner reacts (loop / sub-flow).
    fn fail_scope(&mut self, prefix: &str, key: &str, cause: Reason) {
        if prefix.is_empty() {
            if self.state.status == RunStatus::AwaitingApproval {
                self.set_run(RunStatus::Running, None);
            }
            self.set_run(
                RunStatus::Failed,
                Some(
                    Reason::new(FLOW_NODE_FAILED)
                        .with("node", key)
                        .with("cause", cause.code),
                ),
            );
        } else if self.scope_running(prefix) {
            self.emit(
                None,
                EventBody::ScopeFinished {
                    prefix: prefix.to_string(),
                    status: ScopeStatus::Failed,
                    outputs: BTreeMap::new(),
                },
            );
        }
    }

    // ------------------------------------------------------------ budget

    fn budget_limit(&self) -> Option<f64> {
        self.state
            .budget_limit_usd
            .or(self.meta.flow.limits.budget_usd)
    }

    /// Requests a budget approval when spending passed the limit.
    fn check_budget(&mut self) {
        let Some(limit) = self.budget_limit() else {
            return;
        };
        let spent = self.state.cost.total();
        if spent <= limit || self.budget_pending() {
            return;
        }
        let request = ApprovalRequest {
            node_key: None,
            options: BUDGET_OPTIONS.iter().map(|s| s.to_string()).collect(),
            message: None,
            show: BTreeMap::new(),
            reason: Reason::new(FLOW_BUDGET_EXCEEDED)
                .with("spentUsd", spent)
                .with("limitUsd", limit),
        };
        self.emit(None, EventBody::ApprovalRequested(request));
    }

    fn budget_pending(&self) -> bool {
        self.state.approvals.iter().any(|a| a.node_key.is_none())
    }

    // --------------------------------------------------------------- main

    /// Runs until the run completes, fails, pauses, is cancelled, or the
    /// app shuts down. `resume_reason` is recorded when (re)entering `running`.
    pub fn run(mut self, resume_reason: Option<Reason>) -> RunStatus {
        self.ensure_root();
        match self.state.status {
            RunStatus::Pending | RunStatus::Paused | RunStatus::Interrupted | RunStatus::Failed => {
                self.set_run(RunStatus::Running, resume_reason);
            }
            _ => {}
        }
        // Nodes waiting for a retry when the run stopped start over.
        let waiting: Vec<(String, u32)> = self
            .state
            .nodes
            .iter()
            .filter(|(_, n)| n.status == NodeStatus::RetryWait)
            .map(|(k, n)| (k.clone(), n.attempt))
            .collect();
        for (key, attempt) in waiting {
            self.set_node(&key, NodeStatus::Ready, attempt, None, None);
        }
        self.reconnect_running();
        let idle = self.env.poll.max(Duration::from_millis(20));
        loop {
            self.drain_controls();
            if self.shutdown_requested {
                self.shutdown();
                break;
            }
            if self.cancel_requested {
                self.cancel_all();
                break;
            }
            self.poll_running();
            self.retry_due();
            if !self.state.status.is_active() {
                if self.running.is_empty() {
                    break;
                }
                self.wait_control(idle);
                continue;
            }
            if self.stop_requested {
                if self.running.is_empty() {
                    self.set_run(RunStatus::Stopping, Some(Reason::new(FLOW_STOP_REQUESTED)));
                    self.set_run(RunStatus::Paused, Some(Reason::new(FLOW_STOP_REQUESTED)));
                    break;
                }
                self.begin_stop();
                self.wait_control(idle);
                continue;
            }
            self.check_budget();
            self.advance();
            if !self.state.status.is_active() {
                continue;
            }
            if self.start_ready() {
                continue;
            }
            if !self.running.is_empty() || !self.retry_at.is_empty() {
                if self.state.status == RunStatus::AwaitingApproval {
                    self.set_run(RunStatus::Running, None);
                }
                self.wait_control(idle);
                continue;
            }
            if !self.state.approvals.is_empty() {
                if self.state.status == RunStatus::Running {
                    self.set_run(RunStatus::AwaitingApproval, None);
                }
                self.wait_control(idle * 2);
                continue;
            }
            if self.state.status == RunStatus::AwaitingApproval {
                self.set_run(RunStatus::Running, None);
            }
            // Nothing runs, waits or is ready, yet the root did not finish.
            if self.state.status.is_active() {
                self.set_run(RunStatus::Failed, Some(Reason::new(FLOW_RUN_STUCK)));
            }
            break;
        }
        self.checkpoint();
        self.state.status
    }

    /// Settles pending nodes, advances loops / sub-flows and finishes
    /// scopes until nothing changes.
    fn advance(&mut self) {
        for _ in 0..10_000 {
            if !self.state.status.is_active() {
                return;
            }
            let before = self.state.seq;
            for prefix in self.live_scopes() {
                if !self.scope_running(&prefix) {
                    continue;
                }
                self.resolve_pending(&prefix);
                self.progress_composites(&prefix);
                self.check_scope(&prefix);
            }
            if self.state.seq == before {
                return;
            }
        }
    }

    /// Settles pending nodes of a scope whose incoming forward edges are all
    /// resolved: `ready`, or `skipped` (no taken edge, or `when` false).
    fn resolve_pending(&mut self, prefix: &str) {
        for id in self.ids(prefix) {
            let key = self.state.current_key(prefix, &id);
            if self.node(&key).status != NodeStatus::Pending || !self.state.status.is_active() {
                continue;
            }
            let incoming: Vec<(String, String)> = self
                .graph_of(prefix)
                .map(|g| {
                    g.forward()
                        .filter(|e| e.to == id)
                        .map(|e| (e.from.clone(), e.port().to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let mut unresolved = false;
            let mut taken = incoming.is_empty();
            for (from, port) in &incoming {
                let source = self.node(&self.state.current_key(prefix, from));
                if !source.status.is_terminal() {
                    unresolved = true;
                    break;
                }
                if source.port.as_deref() == Some(port.as_str()) {
                    taken = true;
                }
            }
            if unresolved {
                continue;
            }
            if !taken {
                self.set_node(&key, NodeStatus::Skipped, 0, None, None);
                continue;
            }
            let (when, approval_first) = match self.graph_of(prefix).and_then(|g| g.node(&id)) {
                Some(node) => (
                    node.when.clone(),
                    match &node.kind {
                        NodeKind::Approval(a) => a.effective_options().first().cloned(),
                        _ => None,
                    },
                ),
                None => continue,
            };
            let holds = match &when {
                Some(condition) => self.evaluate(prefix, condition, None),
                None => Ok(true),
            };
            match holds {
                Ok(true) => {
                    self.set_node(&key, NodeStatus::Ready, 0, None, None);
                }
                Ok(false) => {
                    // A `when`-skipped node lets the flow continue (spec 8.1).
                    let port = approval_first.unwrap_or_else(|| PORT_SUCCESS.to_string());
                    self.set_node(&key, NodeStatus::Skipped, 0, None, Some(port));
                }
                Err(reason) => {
                    self.set_node(&key, NodeStatus::Ready, 0, None, None);
                    self.set_node(&key, NodeStatus::Running, 1, None, None);
                    self.fail_node(&key, 1, reason);
                }
            }
        }
    }

    /// Finishes a scope whose current instances are all settled.
    fn check_scope(&mut self, prefix: &str) {
        if !self.scope_running(prefix) || !self.state.status.is_active() {
            return;
        }
        let mut done = true;
        for id in self.ids(prefix) {
            let key = self.state.current_key(prefix, &id);
            let node = self.node(&key);
            match node.status {
                NodeStatus::Succeeded | NodeStatus::Skipped => {}
                NodeStatus::Failed if self.has_failure_edge(&key) => {}
                _ => {
                    done = false;
                    break;
                }
            }
        }
        if !done {
            return;
        }
        let outputs = self.render_outputs(prefix);
        if prefix.is_empty() {
            if self.state.status == RunStatus::AwaitingApproval {
                self.set_run(RunStatus::Running, None);
            }
            self.emit(
                None,
                EventBody::ScopeFinished {
                    prefix: String::new(),
                    status: ScopeStatus::Completed,
                    outputs,
                },
            );
            self.set_run(RunStatus::Completed, None);
        } else {
            self.emit(
                None,
                EventBody::ScopeFinished {
                    prefix: prefix.to_string(),
                    status: ScopeStatus::Completed,
                    outputs,
                },
            );
        }
    }

    /// A scope's `outputs` rendered in the scope (unresolved ones are left out).
    fn render_outputs(&mut self, prefix: &str) -> BTreeMap<String, Value> {
        let templates: BTreeMap<String, String> = self
            .graph_of(prefix)
            .map(|g| g.outputs.clone())
            .unwrap_or_default();
        let mut out = BTreeMap::new();
        let mut missing = Vec::new();
        for (name, text) in templates {
            match self.with_ctx(prefix, None, None, None, |ctx| ctx.render_value(&text)) {
                Ok(value) => {
                    out.insert(name, value);
                }
                Err(_) => missing.push(name),
            }
        }
        for name in missing {
            self.emit(
                None,
                EventBody::Warning(
                    Reason::new(FLOW_OUTPUT_UNRESOLVED)
                        .with("scope", prefix)
                        .with("output", name),
                ),
            );
        }
        out
    }

    // ------------------------------------------------------ starting nodes

    /// Starts ready nodes (commands up to the limit; other kinds don't take
    /// a slot). Returns true if anything started.
    fn start_ready(&mut self) -> bool {
        if self.budget_pending() {
            return false;
        }
        for prefix in self.live_scopes() {
            for id in self.ids(&prefix) {
                let key = self.state.current_key(&prefix, &id);
                if self.node(&key).status != NodeStatus::Ready {
                    continue;
                }
                let Some(node) = self.graph_of(&prefix).and_then(|g| g.node(&id)).cloned() else {
                    continue;
                };
                if matches!(node.kind, NodeKind::Command(_))
                    && self.running.len() >= MAX_RUNNING_COMMANDS
                {
                    continue;
                }
                if self.state.status == RunStatus::AwaitingApproval {
                    self.set_run(RunStatus::Running, None);
                }
                self.start_node(&prefix, &key, &node);
                return true;
            }
        }
        false
    }

    fn start_node(&mut self, prefix: &str, key: &str, node: &FlowNode) {
        let attempt = self.node(key).attempt + 1;
        self.set_node(key, NodeStatus::Running, attempt, None, None);
        match &node.kind {
            NodeKind::Approval(approval) => {
                let (message, show) = self.with_ctx(prefix, None, None, None, |ctx| {
                    let message = approval
                        .message
                        .as_deref()
                        .map(|m| ctx.render_string(m).unwrap_or_else(|_| m.to_string()));
                    let show: BTreeMap<String, Value> = approval
                        .show
                        .iter()
                        .map(|name| {
                            let value = template::parse_reference(name)
                                .ok()
                                .and_then(|r| ctx.resolve(&r))
                                .unwrap_or(Value::Null);
                            (name.clone(), value)
                        })
                        .collect();
                    (message, show)
                });
                let request = ApprovalRequest {
                    node_key: Some(key.to_string()),
                    options: approval.effective_options(),
                    message,
                    show,
                    reason: Reason::new(FLOW_APPROVAL_NODE),
                };
                self.set_node(key, NodeStatus::AwaitingApproval, attempt, None, None);
                self.emit(Some(key), EventBody::ApprovalRequested(request));
            }
            NodeKind::Branch(branch) => {
                let mut chosen: Result<Option<String>, Reason> = Ok(None);
                for case in &branch.cases {
                    match self.evaluate(prefix, &case.when, None) {
                        Ok(true) => {
                            chosen = Ok(Some(case.port.clone()));
                            break;
                        }
                        Ok(false) => {}
                        Err(reason) => {
                            chosen = Err(reason);
                            break;
                        }
                    }
                }
                match chosen.map(|c| c.or_else(|| branch.default.clone())) {
                    Ok(Some(port)) => self.settle(key, attempt, NodeStatus::Succeeded, &port, None),
                    Ok(None) => self.fail_node(key, attempt, Reason::new(FLOW_BRANCH_NO_MATCH)),
                    Err(reason) => self.fail_node(key, attempt, reason),
                }
            }
            NodeKind::Command(command) => self.launch_command(prefix, key, node, command, attempt),
            NodeKind::Loop(lp) => {
                if lp.mode == LoopMode::Foreach {
                    let items = self.with_ctx(prefix, None, None, None, |ctx| match &lp.items {
                        Some(Value::String(text)) => ctx.render_value(text),
                        Some(other) => ctx.render_json(other),
                        None => Ok(Value::Array(Vec::new())),
                    });
                    match items {
                        Ok(Value::Array(mut items)) => {
                            let max = lp.max_iterations.unwrap_or(0) as usize;
                            let limit_reached = items.len() > max;
                            items.truncate(max);
                            self.emit(
                                Some(key),
                                EventBody::LoopItems {
                                    items,
                                    limit_reached,
                                },
                            );
                        }
                        Ok(_) => {
                            return self.fail_node(
                                key,
                                attempt,
                                Reason::new(FLOW_LOOP_ITEMS_INVALID),
                            );
                        }
                        Err(reason) => return self.fail_node(key, attempt, reason),
                    }
                }
                // Iterations start in `progress_composites`.
            }
            NodeKind::Subflow(sub) => {
                let given = self.with_ctx(prefix, None, None, None, |ctx| {
                    ctx.render_json(&Value::Object(sub.params.clone().into_iter().collect()))
                });
                match given {
                    Ok(Value::Object(given)) => {
                        let given: BTreeMap<String, Value> = given.into_iter().collect();
                        if let Err(reason) = self.open_file_scope(
                            prefix,
                            key,
                            &sub.flow,
                            &subflow_prefix(key),
                            &given,
                            None,
                        ) {
                            self.fail_node(key, attempt, reason);
                        }
                    }
                    Ok(_) => {}
                    Err(reason) => self.fail_node(key, attempt, reason),
                }
            }
            other => {
                self.fail_node(
                    key,
                    attempt,
                    Reason::new("FLOW_RUN_UNSUPPORTED").with("feature", other.name()),
                );
            }
        }
    }

    /// Opens a child scope running another flow file (sub-flow or file loop body).
    fn open_file_scope(
        &mut self,
        prefix: &str,
        owner: &str,
        reference: &str,
        child: &str,
        given: &BTreeMap<String, Value>,
        iteration: Option<(Value, usize)>,
    ) -> Result<(), Reason> {
        let owner_file = self
            .scope_init(prefix)
            .map(|i| i.graph.file)
            .unwrap_or_default();
        let resolved = self
            .meta
            .refs
            .get(&ref_key(&owner_file, reference))
            .cloned()
            .ok_or_else(|| Reason::new(FLOW_SUBFLOW_MISSING).with("ref", reference))?;
        let flow = scope::flow_of(&self.meta, &resolved)
            .cloned()
            .ok_or_else(|| Reason::new(FLOW_SUBFLOW_MISSING).with("ref", reference))?;
        let params = prepare_params(&flow, given).map_err(|problems| {
            problems
                .into_iter()
                .next()
                .unwrap_or_else(|| Reason::new("FLOW_PARAM_INVALID"))
        })?;
        let (item, index) = match iteration {
            Some((item, index)) => (Some(item), Some(index)),
            None => (None, None),
        };
        let init = ScopeInit {
            owner: Some(owner.to_string()),
            parent: Some(prefix.to_string()),
            inherits: false,
            graph: GraphLoc {
                file: resolved,
                path: Vec::new(),
            },
            params,
            var: None,
            item,
            index,
        };
        let nodes = flow.nodes.iter().map(|n| n.id.clone()).collect();
        self.emit(
            Some(owner),
            EventBody::ScopeStarted {
                prefix: child.to_string(),
                init,
                nodes,
            },
        );
        Ok(())
    }

    /// Advances running loops and sub-flows of a scope.
    fn progress_composites(&mut self, prefix: &str) {
        for id in self.ids(prefix) {
            let key = self.state.current_key(prefix, &id);
            if self.node(&key).status != NodeStatus::Running {
                continue;
            }
            let Some(node) = self.graph_of(prefix).and_then(|g| g.node(&id)).cloned() else {
                continue;
            };
            match &node.kind {
                NodeKind::Loop(lp) => self.progress_loop(prefix, &key, &node, lp),
                NodeKind::Subflow(_) => self.progress_subflow(&key),
                _ => {}
            }
            if !self.state.status.is_active() {
                return;
            }
        }
    }

    fn progress_subflow(&mut self, key: &str) {
        let child = subflow_prefix(key);
        let Some(scope) = self.state.scopes.get(&child).cloned() else {
            return;
        };
        let attempt = self.node(key).attempt;
        match scope.status {
            ScopeStatus::Running => {}
            ScopeStatus::Completed => {
                for (name, value) in scope.outputs {
                    self.emit(Some(key), EventBody::NodeOutput { key: name, value });
                }
                self.settle(key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None);
            }
            ScopeStatus::Failed => {
                self.fail_node(key, attempt, Reason::new(FLOW_SUBFLOW_FAILED));
            }
        }
    }

    /// Iteration scopes of a loop instance, by index.
    fn iterations(&self, key: &str) -> Vec<(String, ScopeRecord)> {
        let mut out: Vec<(String, ScopeRecord)> = self
            .state
            .scopes
            .iter()
            .filter(|(_, s)| s.init.owner.as_deref() == Some(key) && s.init.index.is_some())
            .map(|(p, s)| (p.clone(), s.clone()))
            .collect();
        out.sort_by_key(|(_, s)| s.init.index);
        out
    }

    fn progress_loop(&mut self, prefix: &str, key: &str, node: &FlowNode, lp: &LoopNode) {
        let attempt = self.node(key).attempt;
        let children = self.iterations(key);
        let active = children
            .iter()
            .filter(|(_, s)| s.status == ScopeStatus::Running)
            .count();
        let failed: Vec<usize> = children
            .iter()
            .filter(|(_, s)| s.status == ScopeStatus::Failed)
            .filter_map(|(_, s)| s.init.index)
            .collect();
        let stop_on_failure = lp.on_item_failure != Some(OnItemFailure::Continue);
        if stop_on_failure && !failed.is_empty() {
            if active == 0 {
                self.fail_node(
                    key,
                    attempt,
                    Reason::new(FLOW_LOOP_ITERATION_FAILED).with("index", failed[0]),
                );
            }
            return;
        }
        if active > 0 || self.stop_requested {
            return;
        }
        let max = lp.max_iterations.unwrap_or(0) as usize;
        match lp.mode {
            LoopMode::Foreach => {
                let record = self.state.loops.get(key).cloned().unwrap_or(LoopRecord {
                    items: Vec::new(),
                    limit_reached: false,
                });
                if children.len() < record.items.len() {
                    let index = children.len();
                    let item = record.items[index].clone();
                    self.start_iteration(prefix, key, node, lp, index, item);
                } else {
                    self.finish_loop(key, attempt, &children, record.limit_reached);
                }
            }
            LoopMode::While => {
                if let Some((_, last)) = children.last() {
                    let iteration = last.outputs.clone();
                    let until = lp.until.clone().expect("validated: while has until");
                    match self.evaluate(prefix, &until, Some(&iteration)) {
                        Ok(true) => return self.finish_loop(key, attempt, &children, false),
                        Ok(false) => {}
                        Err(reason) => return self.fail_node(key, attempt, reason),
                    }
                    if children.len() >= max {
                        return self.finish_loop(key, attempt, &children, true);
                    }
                }
                let index = children.len();
                self.start_iteration(prefix, key, node, lp, index, Value::from(index));
            }
        }
    }

    fn start_iteration(
        &mut self,
        prefix: &str,
        key: &str,
        node: &FlowNode,
        lp: &LoopNode,
        index: usize,
        item: Value,
    ) {
        let child = iteration_prefix(key, index);
        let var = lp.loop_var().to_string();
        match &lp.body {
            LoopBody::Inline(body) => {
                let Some(init) = self.scope_init(prefix) else {
                    return;
                };
                let mut path = init.graph.path.clone();
                path.push(node.id.clone());
                let scope = ScopeInit {
                    owner: Some(key.to_string()),
                    parent: Some(prefix.to_string()),
                    inherits: true,
                    graph: GraphLoc {
                        file: init.graph.file.clone(),
                        path,
                    },
                    params: init.params.clone(),
                    var: Some(var),
                    item: Some(item),
                    index: Some(index),
                };
                let nodes = body.nodes.iter().map(|n| n.id.clone()).collect();
                self.emit(
                    Some(key),
                    EventBody::ScopeStarted {
                        prefix: child,
                        init: scope,
                        nodes,
                    },
                );
            }
            LoopBody::File(file) => {
                let loop_var = LoopVar {
                    name: var,
                    item: item.clone(),
                    index,
                };
                let given = self.with_ctx(prefix, Some(loop_var), None, None, |ctx| {
                    ctx.render_json(&Value::Object(lp.params.clone().into_iter().collect()))
                });
                let attempt = self.node(key).attempt;
                match given {
                    Ok(Value::Object(given)) => {
                        let given: BTreeMap<String, Value> = given.into_iter().collect();
                        if let Err(reason) = self.open_file_scope(
                            prefix,
                            key,
                            file,
                            &child,
                            &given,
                            Some((item, index)),
                        ) {
                            self.fail_node(key, attempt, reason);
                        }
                    }
                    Ok(_) => {}
                    Err(reason) => self.fail_node(key, attempt, reason),
                }
            }
        }
    }

    fn finish_loop(
        &mut self,
        key: &str,
        attempt: u32,
        children: &[(String, ScopeRecord)],
        limit_reached: bool,
    ) {
        let failed = children
            .iter()
            .filter(|(_, s)| s.status == ScopeStatus::Failed)
            .count();
        let results: Vec<Value> = children
            .iter()
            .map(|(_, s)| Value::Object(s.outputs.clone().into_iter().collect()))
            .collect();
        let outputs = [
            ("iterations", Value::from(children.len())),
            ("failedIterations", Value::from(failed)),
            ("limitReached", Value::from(limit_reached)),
            ("results", Value::Array(results)),
        ];
        for (name, value) in outputs {
            self.emit(
                Some(key),
                EventBody::NodeOutput {
                    key: name.to_string(),
                    value,
                },
            );
        }
        self.settle(key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None);
    }

    // ------------------------------------------------------------ commands

    fn retry_policy(&self, prefix: &str, node: &FlowNode) -> Option<RetryPolicy> {
        node.retry
            .clone()
            .or_else(|| self.file_flow(prefix).defaults.retry.clone())
    }

    fn node_timeout(&self, prefix: &str, node: &FlowNode) -> Option<Duration> {
        node.timeout
            .as_deref()
            .or(self.file_flow(prefix).defaults.timeout.as_deref())
            .and_then(parse_duration)
    }

    fn launch_command(
        &mut self,
        prefix: &str,
        key: &str,
        node: &FlowNode,
        command: &CommandNode,
        attempt: u32,
    ) {
        let dir = match self.store.node_attempt_dir(&self.run_id, key, attempt) {
            Ok(dir) => dir,
            Err(err) => {
                return self.fail_node(
                    key,
                    attempt,
                    Reason::new(FLOW_COMMAND_SPAWN_FAILED).with("message", err.to_string()),
                )
            }
        };
        let spec = match self.prepare_launch(prefix, key, command, &dir) {
            Ok(spec) => spec,
            Err(reason) => return self.fail_node(key, attempt, reason),
        };
        let detached = command.detach.unwrap_or(true);
        let launcher = match (&self.env.detached, detached) {
            (Some(launcher), true) => launcher.clone(),
            _ => self.env.launcher.clone(),
        };
        let handle = match launcher.launch(&spec) {
            Ok(handle) => handle,
            Err(err) => {
                return self.fail_node(
                    key,
                    attempt,
                    Reason::new(FLOW_COMMAND_SPAWN_FAILED).with("message", err.to_string()),
                )
            }
        };
        self.emit(
            Some(key),
            EventBody::Process {
                pid: handle.pid(),
                // The OS creation time when known (detached), else the launch time.
                started_at: handle.identity().unwrap_or_else(fsutil::now),
                exit_file: handle.exit_file().map(|p| p.to_string_lossy().into_owned()),
            },
        );
        self.track(
            prefix,
            key,
            node,
            command,
            attempt,
            dir,
            handle,
            Instant::now(),
        );
    }

    /// Adds a started (or reconnected) command to the monitored set.
    #[allow(clippy::too_many_arguments)]
    fn track(
        &mut self,
        prefix: &str,
        key: &str,
        node: &FlowNode,
        command: &CommandNode,
        attempt: u32,
        dir: PathBuf,
        handle: Box<dyn ProcessHandle>,
        started: Instant,
    ) {
        let saved = ProtocolCursor::load(&dir);
        let reader = (command.protocol == CommandProtocol::MdiumV1)
            .then(|| ProtocolReader::resume(&dir.join("events.jsonl"), saved.offset, saved.lines));
        self.running.push(RunningCommand {
            key: key.to_string(),
            attempt,
            dir,
            success_codes: command.success_codes.clone().unwrap_or_else(|| vec![0]),
            handle,
            reader,
            outcome: saved.outcome,
            started,
            timeout: self.node_timeout(prefix, node),
            grace_deadline: None,
            last_progress: None,
            pending_progress: None,
        });
    }

    /// Polls every running command once and settles the finished ones.
    fn poll_running(&mut self) {
        let mut running = std::mem::take(&mut self.running);
        let mut finished = Vec::new();
        let mut i = 0;
        while i < running.len() {
            match self.poll_one(&mut running[i]) {
                Some(finish) => finished.push((running.remove(i), finish)),
                None => i += 1,
            }
        }
        self.running = running;
        for (command, finish) in finished {
            self.finish_command(command, finish);
        }
    }

    fn poll_one(&mut self, command: &mut RunningCommand) -> Option<Finish> {
        if let Some(reader) = command.reader.as_mut() {
            let items = reader.poll(false);
            if !items.is_empty() {
                let key = command.key.clone();
                for item in items {
                    self.protocol_item(&key, item, command);
                }
                if let Some(reader) = command.reader.as_ref() {
                    ProtocolCursor {
                        offset: reader.committed_offset(),
                        lines: reader.lines(),
                        outcome: command.outcome.clone(),
                    }
                    .save(&command.dir);
                }
            }
        }
        match command.handle.try_wait() {
            Ok(Some(code)) => return Some(Finish::Exited(code)),
            Ok(None) => {}
            Err(_) => return Some(Finish::Exited(-1)),
        }
        if command.grace_deadline.is_some_and(|d| Instant::now() >= d) {
            command.handle.kill_tree();
            return Some(Finish::GraceKilled);
        }
        if command
            .timeout
            .is_some_and(|t| command.started.elapsed() >= t)
        {
            command.handle.kill_tree();
            return Some(Finish::Timeout);
        }
        None
    }

    fn finish_command(&mut self, mut command: RunningCommand, finish: Finish) {
        let key = command.key.clone();
        if let Some(mut reader) = command.reader.take() {
            for item in reader.poll(true) {
                self.protocol_item(&key, item, &mut command);
            }
        }
        if let Some((text, fraction)) = command.pending_progress.take() {
            self.emit(Some(&key), EventBody::NodeProgress { text, fraction });
        }
        let _ = std::fs::write(
            command.dir.join("outputs.json"),
            serde_json::to_vec_pretty(&self.node(&key).outputs).unwrap_or_default(),
        );
        let attempt = command.attempt;
        let result = match finish {
            Finish::Exited(code) => decide(command.outcome.as_ref(), code, &command.success_codes),
            Finish::Timeout => CommandResult::Failed {
                code: FLOW_NODE_TIMEOUT,
                detail: None,
            },
            Finish::GraceKilled => {
                self.set_node(
                    &key,
                    NodeStatus::Ready,
                    attempt,
                    Some(Reason::new(FLOW_STOP_GRACE_EXCEEDED)),
                    None,
                );
                return;
            }
        };
        match result {
            CommandResult::Succeeded => {
                self.settle(&key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None)
            }
            CommandResult::Stopped => {
                self.set_node(
                    &key,
                    NodeStatus::Ready,
                    attempt,
                    Some(Reason::new(FLOW_NODE_STOPPED)),
                    None,
                );
            }
            CommandResult::NeedsApproval(message) => {
                self.set_node(&key, NodeStatus::AwaitingApproval, attempt, None, None);
                let request = ApprovalRequest {
                    node_key: Some(key.clone()),
                    options: COMMAND_APPROVAL_OPTIONS
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                    message,
                    show: BTreeMap::new(),
                    reason: Reason::new(FLOW_COMMAND_NEEDS_APPROVAL),
                };
                self.emit(Some(&key), EventBody::ApprovalRequested(request));
            }
            CommandResult::Failed { code, detail } => {
                let mut reason = Reason::new(code);
                if let Some(detail) = detail {
                    reason = reason.with("detail", detail);
                }
                self.after_failure(&key, attempt, reason, code == FLOW_NODE_TIMEOUT);
            }
        }
    }

    /// Retries per the node's policy, or fails it.
    fn after_failure(&mut self, key: &str, attempt: u32, reason: Reason, timed_out: bool) {
        if let Some((prefix, node)) = self.def_of(key) {
            if let Some(policy) = self.retry_policy(&prefix, &node) {
                let kind = if timed_out {
                    RetryOn::Timeout
                } else {
                    RetryOn::Failed
                };
                let applies = policy
                    .on
                    .as_ref()
                    .map(|on| on.contains(&kind))
                    .unwrap_or(true);
                if applies && attempt <= policy.max {
                    self.set_node(key, NodeStatus::RetryWait, attempt, Some(reason), None);
                    let backoff = policy
                        .backoff
                        .as_deref()
                        .and_then(parse_duration)
                        .unwrap_or_default();
                    self.retry_at
                        .insert(key.to_string(), Instant::now() + backoff);
                    return;
                }
            }
        }
        self.fail_node(key, attempt, reason);
    }

    /// Nodes whose retry backoff elapsed (or that wait while stopping) become ready.
    fn retry_due(&mut self) {
        let now = Instant::now();
        let due: Vec<String> = self
            .retry_at
            .iter()
            .filter(|(_, at)| **at <= now || self.stop_requested)
            .map(|(k, _)| k.clone())
            .collect();
        for key in due {
            self.retry_at.remove(&key);
            let attempt = self.node(&key).attempt;
            if self.node(&key).status == NodeStatus::RetryWait {
                self.set_node(&key, NodeStatus::Ready, attempt, None, None);
            }
        }
    }

    fn prepare_launch(
        &self,
        prefix: &str,
        key: &str,
        command: &CommandNode,
        dir: &Path,
    ) -> Result<LaunchSpec, Reason> {
        let spawn_err = |e: std::io::Error| {
            Reason::new(FLOW_COMMAND_SPAWN_FAILED).with("message", e.to_string())
        };
        std::fs::create_dir_all(dir).map_err(spawn_err)?;
        let events = dir.join("events.jsonl");
        let inputs = dir.join("inputs.json");
        std::fs::File::create(&events).map_err(spawn_err)?;
        let input = match self.vars(prefix).last() {
            Some(var) => serde_json::json!({ "item": var.item, "index": var.index }),
            None => match self.scope_init(prefix) {
                Some(ScopeInit {
                    item: Some(item),
                    index: Some(index),
                    ..
                }) => serde_json::json!({ "item": item, "index": index }),
                _ => serde_json::json!({}),
            },
        };
        std::fs::write(&inputs, input.to_string()).map_err(spawn_err)?;
        let flow = self.file_flow(prefix).clone();
        let stop_file = self
            .store
            .stop_file(&self.run_id)
            .map_err(|e| Reason::new(FLOW_COMMAND_SPAWN_FAILED).with("message", e.to_string()))?;
        let root = self.store.project_root().to_path_buf();
        self.with_ctx(prefix, None, Some(dir), None, |ctx| {
            let argv = match &command.run {
                CommandRun::Argv(argv) => argv
                    .iter()
                    .map(|a| ctx.render_string(a))
                    .collect::<Result<Vec<_>, _>>()?,
                CommandRun::Shell(text) => vec![text.clone()],
            };
            let working_dir = match command
                .working_dir
                .as_deref()
                .or(flow.defaults.working_dir.as_deref())
            {
                Some(dir) => {
                    let rendered = PathBuf::from(ctx.render_string(dir)?);
                    if rendered.is_absolute() {
                        rendered
                    } else {
                        root.join(rendered)
                    }
                }
                None => root.clone(),
            };
            let mut env: Vec<(String, String)> = Vec::new();
            for (name, value) in flow.env.iter().chain(command.env.iter()) {
                env.push((name.clone(), ctx.render_string(value)?));
            }
            let s = |p: &Path| p.to_string_lossy().into_owned();
            env.extend([
                ("MDIUM_FLOW_RUN_ID".to_string(), self.run_id.clone()),
                ("MDIUM_FLOW_NODE_KEY".to_string(), key.to_string()),
                ("MDIUM_FLOW_NODE_DIR".to_string(), s(dir)),
                ("MDIUM_FLOW_EVENTS_FILE".to_string(), s(&events)),
                ("MDIUM_FLOW_STOP_FILE".to_string(), s(&stop_file)),
                ("MDIUM_FLOW_INPUTS_FILE".to_string(), s(&inputs)),
            ]);
            Ok(LaunchSpec {
                argv,
                shell: command.shell,
                working_dir,
                env,
                stdout: dir.join("stdout.log"),
                stderr: dir.join("stderr.log"),
                node_dir: dir.to_path_buf(),
                new_group: true,
            })
        })
    }

    fn protocol_item(&mut self, key: &str, item: ProtocolItem, command: &mut RunningCommand) {
        match item {
            ProtocolItem::Progress { text, fraction } => {
                // At most one persisted progress event per second; the latest wins.
                if command
                    .last_progress
                    .is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL)
                {
                    command.last_progress = Some(Instant::now());
                    command.pending_progress = None;
                    self.emit(Some(key), EventBody::NodeProgress { text, fraction });
                } else {
                    command.pending_progress = Some((text, fraction));
                }
            }
            ProtocolItem::Cost {
                usd,
                estimated,
                provider,
                model,
                units,
            } => {
                let kind = if estimated {
                    CostKind::Estimated
                } else {
                    CostKind::Actual
                };
                self.emit(
                    Some(key),
                    EventBody::Cost {
                        usd,
                        kind,
                        provider,
                        model,
                        units,
                    },
                );
            }
            ProtocolItem::Output { key: name, value } => {
                self.emit(Some(key), EventBody::NodeOutput { key: name, value });
            }
            ProtocolItem::Artifact { path, label } => {
                self.emit(Some(key), EventBody::NodeArtifact { path, label });
            }
            ProtocolItem::Outcome(o) => command.outcome = Some(o),
            ProtocolItem::Warning { reason, line } => {
                self.emit(
                    Some(key),
                    EventBody::Warning(
                        Reason::new(FLOW_PROTOCOL_WARNING)
                            .with("reason", reason)
                            .with("line", line),
                    ),
                );
            }
        }
    }

    // --------------------------------------------- stop / cancel / exit

    fn begin_stop(&mut self) {
        if matches!(
            self.state.status,
            RunStatus::Running | RunStatus::AwaitingApproval
        ) {
            self.set_run(RunStatus::Stopping, Some(Reason::new(FLOW_STOP_REQUESTED)));
        }
        let _ = self
            .store
            .stop_file(&self.run_id)
            .map(|p| std::fs::write(p, b""));
        let grace = self
            .meta
            .flow
            .limits
            .stop_grace
            .as_deref()
            .and_then(parse_duration);
        for command in &mut self.running {
            if command.grace_deadline.is_none() {
                command.grace_deadline =
                    Some(grace.map(|g| Instant::now() + g).unwrap_or_else(far_future));
            }
        }
    }

    fn cancel_all(&mut self) {
        let running = std::mem::take(&mut self.running);
        for mut command in running {
            command.handle.kill_tree();
            self.set_node(
                &command.key,
                NodeStatus::Cancelled,
                command.attempt,
                Some(Reason::new(FLOW_RUN_CANCELLED)),
                None,
            );
        }
        self.set_run(RunStatus::Cancelled, Some(Reason::new(FLOW_RUN_CANCELLED)));
    }

    /// App exit: detached commands keep running (reconnected later); attached
    /// ones are killed and, with the run, become `interrupted`.
    fn shutdown(&mut self) {
        let running = std::mem::take(&mut self.running);
        let mut interrupted = false;
        for mut command in running {
            if command.handle.survives_app_exit() {
                continue;
            }
            command.handle.kill_tree();
            self.set_node(
                &command.key,
                NodeStatus::Interrupted,
                command.attempt,
                Some(Reason::new(FLOW_APP_EXITED)),
                None,
            );
            interrupted = true;
        }
        if interrupted {
            self.set_run(RunStatus::Interrupted, Some(Reason::new(FLOW_APP_EXITED)));
        }
    }

    /// After a restart: follow detached commands that are still running (or
    /// left their exit record); other running commands are interrupted.
    fn reconnect_running(&mut self) {
        let running: Vec<(String, NodeState)> = self
            .state
            .nodes
            .iter()
            .filter(|(k, n)| {
                n.status == NodeStatus::Running && !self.running.iter().any(|r| &r.key == *k)
            })
            .map(|(k, n)| (k.clone(), n.clone()))
            .collect();
        for (key, state) in running {
            let Some((prefix, node)) = self.def_of(&key) else {
                continue;
            };
            let NodeKind::Command(command) = &node.kind else {
                // Loops and sub-flows stay running; their scopes carry on.
                continue;
            };
            let handle = state.process.as_ref().and_then(|p| {
                let exit_file = PathBuf::from(p.exit_file.as_ref()?);
                DetachedProcess::reconnect(p.pid, &p.started_at, &exit_file)
            });
            let dir = self
                .store
                .node_attempt_dir(&self.run_id, &key, state.attempt);
            match (handle, dir) {
                (Some(handle), Ok(dir)) => {
                    let started = Instant::now() - elapsed_since(state.started_at.as_deref());
                    self.track(
                        &prefix,
                        &key,
                        &node,
                        command,
                        state.attempt,
                        dir,
                        Box::new(handle),
                        started,
                    );
                }
                _ => {
                    self.set_node(
                        &key,
                        NodeStatus::Interrupted,
                        state.attempt,
                        Some(Reason::new(FLOW_PROCESS_LOST)),
                        None,
                    );
                }
            }
        }
    }

    /// Opens a new pass for one node (re-running a loop or sub-flow).
    pub fn new_pass(&mut self, key: &str) {
        let (prefix, id, _) = split_key(key);
        let (prefix, id) = (prefix.to_string(), id.to_string());
        self.close_children(key);
        self.emit(
            None,
            EventBody::NewPass {
                scope: prefix,
                ids: vec![id],
            },
        );
    }
}

/// Persisted reading position of a command's protocol file, so a
/// reconnect neither re-applies nor loses events (`protocol.json`).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolCursor {
    offset: u64,
    lines: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<ProtocolOutcome>,
}

impl ProtocolCursor {
    fn load(dir: &Path) -> Self {
        std::fs::read(dir.join("protocol.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save(&self, dir: &Path) {
        if let Ok(json) = serde_json::to_vec(self) {
            let _ = fsutil::atomic_write(&dir.join("protocol.json"), &json);
        }
    }
}

/// Time since an RFC 3339 timestamp (zero when unknown or in the future).
fn elapsed_since(ts: Option<&str>) -> Duration {
    ts.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .and_then(|t| {
            (chrono::Utc::now() - t.with_timezone(&chrono::Utc))
                .to_std()
                .ok()
        })
        .unwrap_or_default()
}

fn far_future() -> Instant {
    Instant::now() + Duration::from_secs(60 * 60 * 24 * 365)
}

/// Offline edits of a run that has no driver (user operations on paused,
/// interrupted or failed runs; recovery after a crash). Uses the same
/// event path as the driver.
pub struct Editor {
    driver: Driver,
}

impl Editor {
    pub fn open(store: RunStore, run_id: &str, env: DriverEnv) -> Result<Self, String> {
        let (_tx, rx) = std::sync::mpsc::channel();
        Ok(Self {
            driver: Driver::open(store, run_id, rx, env)?,
        })
    }

    pub fn state(&self) -> &RunState {
        self.driver.state()
    }

    pub fn meta(&self) -> &RunMeta {
        &self.driver.meta
    }

    pub fn has_failure_edge(&self, key: &str) -> bool {
        self.driver.has_failure_edge(key)
    }

    /// The instance counts: it is its node's current pass in a live scope.
    pub fn is_live_instance(&self, key: &str) -> bool {
        self.driver.is_current(key) && self.driver.in_live_scope(key)
    }

    pub fn is_composite(&self, key: &str) -> bool {
        self.driver.is_composite(key)
    }

    pub fn set_node(
        &mut self,
        key: &str,
        to: NodeStatus,
        reason: Option<Reason>,
        port: Option<String>,
    ) -> bool {
        let attempt = self.driver.node(key).attempt;
        self.driver.set_node(key, to, attempt, reason, port)
    }

    /// Marks a failed node succeeded through `success` (follows back-edges).
    pub fn mark_succeeded(&mut self, key: &str) {
        let attempt = self.driver.node(key).attempt;
        self.driver
            .settle(key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None);
    }

    pub fn new_pass(&mut self, key: &str) {
        self.driver.new_pass(key);
    }

    pub fn set_run(&mut self, to: RunStatus, reason: Option<Reason>) -> bool {
        self.driver.set_run(to, reason)
    }

    pub fn approve(
        &mut self,
        node_key: Option<&str>,
        choice: &str,
        comment: Option<String>,
        by: &str,
    ) -> bool {
        self.driver.apply_approval(node_key, choice, comment, by)
    }

    pub fn finish(mut self) {
        self.driver.checkpoint();
    }
}

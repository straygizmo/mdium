//! The run driver (spec 4.2–4.8): one thread per run that owns the run's
//! event log. Each tick it polls running commands, applies controls,
//! settles pending nodes in every live scope (joins, `when`, skipped
//! propagation), advances loops and sub-flows, follows back-edges into new
//! passes, and starts ready nodes. State only ever changes by appending an
//! event and applying it (see [`Driver::emit`]).
//!
//! PR 4a: scopes (loops, sub-flows), branches and back-edges. Commands run
//! one at a time; concurrency limits are PR 4b.

mod action;
mod agent;
mod command;
mod composite;
mod lifecycle;
mod python;

use self::action::RunningAction;
use self::agent::RunningAgent;
use self::command::RunningCommand;
use self::python::{LiveWorker, RunningCall};
use crate::condition::Condition;
use crate::forge::ForgeCli;
use crate::fsutil;
use crate::gitops;
use crate::integrity::{self, IntegritySnapshot};
use crate::issues::{
    FLOW_PROVIDER_UNAVAILABLE, FLOW_RUNTIME_UNKNOWN, FLOW_SUBFLOW_INVALID,
    FLOW_SUBFLOW_PARAMS_INVALID, FLOW_SUBFLOW_ROOT_INVALID,
};
use crate::load;
use crate::model::{
    parse_duration, ActionNode, AgentNode, AgentPermission, CommandNode, CommandProtocol, CommandRun, FlowDef, FlowNode,
    LoopBody, LoopMode, LoopNode, NodeKind, OnItemFailure, OutputContract, PythonNode, RetryOn,
    RetryPolicy, SubflowNode, PORT_ATTENTION, PORT_FAILURE, PORT_SUCCESS,
};
use crate::outcome::{parse_outcome, StageOutcomeKind};
use crate::project::{MetricDef, RuntimeDef};
use crate::prompts::{self, PreviousTurn};
use crate::run::actions::{
    run_action, ActionContext, ActionEnd, FLOW_ACTION_APPROVAL, FLOW_ACTION_FAILED,
};
use crate::run::agent::{AgentRunner, AgentTurnEvent, AgentTurnHandle, AgentTurnRequest};
use crate::run::artifacts;
use crate::run::engine::{load_bundle_at, sha256_hex, Bundle};
use crate::run::model::*;
use crate::run::prepare::{
    check_runnable, command_summaries, prepare_params, stage_summaries, ArtifactsOf, LoopVar,
    NodeOutputs, TemplateContext,
};
use crate::run::process::{
    decide, CommandResult, LaunchSpec, Launcher, ProcessHandle, ProtocolItem, ProtocolOutcome,
    ProtocolReader, MAX_LINES,
};
use crate::run::scope::{
    self, iteration_prefix, ref_key, split_key, subflow_prefix, Graph, GraphLoc,
};
use crate::screening;
use crate::run::store::{node_dir_name, EventLog, RunMeta, RunStore, CHECKPOINT_EVERY};
use crate::run::supervise::DetachedProcess;
use crate::run::worker::{
    bad_manifest_message, bound_over_long_line, truncate_text, MAX_OVER_LONG_TEXT, call_request, cancel_request, describe_request,
    exited_before_describe, parse_worker_line, shutdown_request, validate_inputs,
    with_stderr_tail, worker_spec, CallContext, Manifest, WorkerEvent, WorkerHandle,
    WorkerLauncher, WorkerMessage, FLOW_PYTHON_ENTRY_UNKNOWN, FLOW_PYTHON_INPUT_INVALID,
    FLOW_PYTHON_PROTOCOL, FLOW_PYTHON_WORKER_EXITED, FLOW_RUNTIME_START_FAILED,
};
use crate::provider::ProviderRef;
use crate::template::{self, Reference};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::sync::atomic::{AtomicBool, Ordering};
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
pub const FLOW_ARTIFACT_OUTSIDE_PROJECT: &str = "FLOW_ARTIFACT_OUTSIDE_PROJECT";
/// The attempt's `artifacts.json` could not be written (the events still hold the artifact).
pub const FLOW_ARTIFACT_WRITE_FAILED: &str = "FLOW_ARTIFACT_WRITE_FAILED";
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
/// Approval request of a sub-flow opened with `projectRoot` whose child flow
/// in the worktree differs from the confirmed definition (`root`; `show` =
/// the worktree's `commands`, `stages` and `runtimes`).
pub const FLOW_SUBFLOW_ROOT_DIFFERS: &str = "FLOW_SUBFLOW_ROOT_DIFFERS";
/// A node instance was retired because a back-edge opened a new pass.
pub const FLOW_PASS_RESET: &str = "FLOW_PASS_RESET";
/// No node can make progress (should not happen; reported instead of hanging).
pub const FLOW_RUN_STUCK: &str = "FLOW_RUN_STUCK";
/// A scope output could not be rendered (warning; the output is left out).
pub const FLOW_OUTPUT_UNRESOLVED: &str = "FLOW_OUTPUT_UNRESOLVED";
/// An `outcome` agent's response does not satisfy the output contract
/// (`detail` = the `OUTCOME_*` code).
pub const FLOW_AGENT_OUTPUT_INVALID: &str = "FLOW_AGENT_OUTPUT_INVALID";
/// An agent reported `attention` and the node has no `attention` edge.
pub const FLOW_AGENT_ATTENTION: &str = "FLOW_AGENT_ATTENTION";
/// The agent's turn failed (`code` / `message` from the runner).
pub const FLOW_AGENT_TURN_FAILED: &str = "FLOW_AGENT_TURN_FAILED";
/// The runner's guard blocked the turn (`rule` / `summary`).
pub const FLOW_AGENT_GUARD_BLOCKED: &str = "FLOW_AGENT_GUARD_BLOCKED";
/// The agent runner process went away during the turn.
pub const FLOW_AGENT_RUNNER_EXITED: &str = "FLOW_AGENT_RUNNER_EXITED";
/// The turn could not be started (`message`).
pub const FLOW_AGENT_START_FAILED: &str = "FLOW_AGENT_START_FAILED";
/// The agent's instructions could not be loaded or rendered.
pub const FLOW_AGENT_PROMPT_INVALID: &str = "FLOW_AGENT_PROMPT_INVALID";
/// Approval request before a `full-access` turn whose inputs or instructions
/// look like a prompt injection (`show.findings` = `{ code, line, excerpt }`).
pub const FLOW_AGENT_SCREENING: &str = "FLOW_AGENT_SCREENING";
/// Approval request carrying an agent's `awaiting_user` question (`message`).
pub const FLOW_AGENT_QUESTION: &str = "FLOW_AGENT_QUESTION";
/// The project repository changed behind MDium's back during a `full-access`
/// turn (`changes` = the `INTEGRITY_*` codes).
pub const FLOW_AGENT_INTEGRITY_CHANGED: &str = "FLOW_AGENT_INTEGRITY_CHANGED";
/// Warning: the project root is not a git repository, so a `full-access`
/// turn runs without the integrity check.
pub const FLOW_AGENT_INTEGRITY_SKIPPED: &str = "FLOW_AGENT_INTEGRITY_SKIPPED";

/// `FLOW_ACTION_FAILED` code: the action's node dir or thread could not be set up.
pub const FLOW_ACTION_IO_FAILED: &str = "FLOW_ACTION_IO_FAILED";
/// `FLOW_ACTION_FAILED` code: the action's thread ended without a result (a panic).
pub const FLOW_ACTION_PANICKED: &str = "FLOW_ACTION_PANICKED";
/// `FLOW_ACTION_FAILED` code: the action ended on a cancel nobody asked for.
pub const FLOW_ACTION_CANCELLED: &str = "FLOW_ACTION_CANCELLED";

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
    /// Starts the resident Python workers of `python` nodes.
    pub worker_launcher: Arc<dyn WorkerLauncher>,
    /// Runs the turns of `agent` nodes.
    pub agent_runner: Arc<dyn AgentRunner>,
    /// The forge CLI (`gh` / `glab`) of the issue actions.
    pub forge: Arc<dyn ForgeCli>,
    /// Base directory of the worktrees made by `mdium/git-worktree-create`.
    pub worktree_base: PathBuf,
}

/// Minimum interval between persisted progress events of one node.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
/// Commands running at once in a run (PR 4b makes this configurable).
const MAX_RUNNING_COMMANDS: usize = 1;

/// How long a new worker may take to answer `describe` (the driver blocks).
const WORKER_READY_TIMEOUT: Duration = Duration::from_secs(30);
/// Grace after a call's `cancel` (timeout or user cancel) when
/// `limits.stopGrace` is unset.
const DEFAULT_CANCEL_GRACE: Duration = Duration::from_secs(5);
/// How long workers may take to exit after `shutdown` at run end when
/// `limits.stopGrace` is unset.
const WORKER_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
/// Ticks to wait for a worker's exit code once it was seen exiting.
const WORKER_EXIT_TICKS: u32 = 10;

/// Protocol state of one node attempt (commands and python calls).
#[derive(Default)]
struct ItemState {
    outcome: Option<ProtocolOutcome>,
    last_progress: Option<Instant>,
    pending_progress: Option<(String, Option<f64>)>,
}

/// The resident worker of one runtime (spec 3.2), shared by the run's calls.
/// Workers are per runtime and working root: a sub-flow opened in a
/// worktree gets its own worker of the same runtime.
type WorkerKey = (String, PathBuf);

/// How a command's (or call's) monitoring ended.
enum Finish {
    Exited(i32),
    Timeout,
    GraceKilled,
    /// The python worker running the call is gone (exit code when known).
    WorkerExited(Option<i32>),
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
    workers: BTreeMap<WorkerKey, LiveWorker>,
    calls: Vec<RunningCall>,
    agents: Vec<RunningAgent>,
    actions: Vec<RunningAction>,
    /// Action nodes whose `NeedsApproval` the user approved, with the `show`
    /// of that request: their rerun is acknowledged with it.
    action_ack: BTreeMap<String, BTreeMap<String, Value>>,
    /// Ids handed to started workers.
    worker_seq: u64,
    /// Screening text the user approved, per agent node key.
    screening_ack: BTreeMap<String, String>,
    /// Pending `awaiting_user` questions: node key -> (question, response body).
    agent_questions: BTreeMap<String, (String, String)>,
    /// Opened by an `Editor`: no loop runs turns, so a screening approval
    /// leaves the node `Ready` for the next resume instead.
    offline: bool,
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
            workers: BTreeMap::new(),
            calls: Vec::new(),
            agents: Vec::new(),
            actions: Vec::new(),
            action_ack: BTreeMap::new(),
            worker_seq: 0,
            screening_ack: BTreeMap::new(),
            agent_questions: BTreeMap::new(),
            offline: false,
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
            project_root: None,
        }
    }

    /// The working root of a scope: the worktree a sub-flow was opened in
    /// with `projectRoot` (inherited by everything inside it), else the
    /// project root. Run and node dirs always stay under the project.
    fn scope_root(&self, prefix: &str) -> PathBuf {
        scope::recorded_root(&self.state, prefix)
            .unwrap_or_else(|| self.store.project_root().to_path_buf())
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

    /// The instance of node `id` of scope `prefix` that templates read: the
    /// current pass's instance once it ran, else the latest earlier pass that
    /// ran (a forward reference inside a cycle). `None` when the node was
    /// skipped or has not run in any pass (spec 2026-10-10, 8.2). The
    /// instance being started or running does not count; its previous pass
    /// (if any) does, so a node that references its own outputs reads them
    /// as not run on its first pass and as the previous pass's afterwards.
    fn template_instance(&self, prefix: &str, id: &str) -> Option<String> {
        for pass in (1..=self.state.pass(prefix, id)).rev() {
            let key = scope::instance_key(prefix, id, pass);
            match self.state.nodes.get(&key).map(|n| n.status) {
                Some(NodeStatus::Skipped) => return None,
                None
                | Some(NodeStatus::Pending)
                | Some(NodeStatus::Ready)
                | Some(NodeStatus::Running) => continue,
                Some(_) => return Some(key),
            }
        }
        None
    }

    /// Outputs of node `id` as seen from a scope (inline bodies see outward).
    /// A failed instance without outputs reads as not run (lenient rendering
    /// gives `""`; strict conditions and flow outputs still see it as
    /// unresolved); a failed instance that emitted outputs keeps them.
    fn outputs_seen(&self, prefix: &str, id: &str) -> Option<NodeOutputs> {
        let mut current = prefix.to_string();
        loop {
            if self.graph_of(&current)?.node(id).is_some() {
                return Some(
                    match self
                        .template_instance(&current, id)
                        .and_then(|key| self.state.nodes.get(&key))
                    {
                        Some(n) if n.status == NodeStatus::Failed && n.outputs.is_empty() => {
                            NodeOutputs::NotRun
                        }
                        Some(n) => NodeOutputs::Ran(n.outputs.clone()),
                        None => NodeOutputs::NotRun,
                    },
                );
            }
            let init = self.scope_init(&current)?;
            match (init.inherits, init.parent) {
                (true, Some(parent)) => current = parent,
                _ => return None,
            }
        }
    }

    /// The resolved params of the child scope that the sub-flow node `id`
    /// (visible from `prefix`, current pass) opened; `NotRun` before it
    /// opened one, `None` when no such node is visible.
    fn scope_params_seen(&self, prefix: &str, id: &str) -> Option<NodeOutputs> {
        let mut current = prefix.to_string();
        loop {
            if self.graph_of(&current)?.node(id).is_some() {
                let child = self
                    .template_instance(&current, id)
                    .map(|key| scope::subflow_prefix(&key))
                    .and_then(|child| self.state.scopes.get(&child));
                return Some(match child {
                    Some(scope) => NodeOutputs::Ran(scope.init.params.clone()),
                    None => NodeOutputs::NotRun,
                });
            }
            let init = self.scope_init(&current)?;
            match (init.inherits, init.parent) {
                (true, Some(parent)) => current = parent,
                _ => return None,
            }
        }
    }

    /// Actual + estimated cost of node `id` of `prefix` and of everything
    /// under it (loop iterations, sub-flow scopes).
    fn cost_seen(&self, prefix: &str, id: &str) -> Option<f64> {
        let key = self.state.current_key(prefix, id);
        let mut total = 0.0;
        let mut seen = false;
        for (k, n) in &self.state.nodes {
            // Children are keyed `<key>[i]/...` (loop iterations) or `<key>/...` (sub-flows).
            let under = k.strip_prefix(key.as_str()).is_some_and(|rest| {
                rest.is_empty() || rest.starts_with('[') || rest.starts_with('/')
            });
            if under {
                if n.cost_reported {
                    seen = true;
                }
                total += n.cost.actual + n.cost.estimated;
            }
        }
        seen.then_some(total)
    }

    /// Artifacts of node `id` as seen from a scope (same walk as `outputs_seen`).
    fn artifacts_seen(&self, prefix: &str, id: &str) -> Option<ArtifactsOf> {
        let mut current = prefix.to_string();
        loop {
            if self.graph_of(&current)?.node(id).is_some() {
                let Some(key) = self.template_instance(&current, id) else {
                    return Some(ArtifactsOf {
                        node_key: self.state.current_key(&current, id),
                        attempt: 0,
                        artifacts: Vec::new(),
                        ran: false,
                    });
                };
                return self.state.nodes.get(&key).map(|n| ArtifactsOf {
                    node_key: key.clone(),
                    attempt: n.attempt,
                    artifacts: n.artifacts.clone(),
                    ran: true,
                });
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
        let project_root = self.scope_root(prefix);
        let metrics: &[MetricDef] = self
            .meta
            .project
            .as_ref()
            .map(|p| p.metrics.as_slice())
            .unwrap_or(&[]);
        let lookup = |id: &str| self.outputs_seen(prefix, id);
        let artifacts = |id: &str| self.artifacts_seen(prefix, id);
        let costs = |id: &str| self.cost_seen(prefix, id);
        let scope_params = |id: &str| self.scope_params_seen(prefix, id);
        let ctx = TemplateContext {
            params: &params,
            outputs: &lookup,
            artifacts: &artifacts,
            costs: &costs,
            scope_params: &scope_params,
            vars: &vars,
            iteration,
            run_id: &self.run_id,
            run_dir: &run_dir,
            node_dir,
            project_root: &project_root,
            metrics,
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
        if !request.options.iter().any(|o| o.name == choice) {
            return false;
        }
        let node_comment = comment.clone().unwrap_or_default();
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
                if request.reason.code == FLOW_AGENT_SCREENING {
                    self.agent_screening_decided(key, attempt, &request, choice);
                    return true;
                }
                if request.reason.code == FLOW_AGENT_QUESTION {
                    self.agent_question_answered(key, attempt, &request, choice, node_comment);
                    return true;
                }
                if request.reason.code == FLOW_ACTION_APPROVAL {
                    self.action_approval_decided(key, attempt, &request, choice);
                    return true;
                }
                if request.reason.code == FLOW_SUBFLOW_ROOT_DIFFERS {
                    self.subflow_root_decided(key, attempt, &request, choice);
                    return true;
                }
                let is_approval_node = matches!(
                    self.def_of(key).map(|(_, n)| n.kind),
                    Some(NodeKind::Approval(_))
                );
                if is_approval_node {
                    self.emit(
                        Some(key),
                        EventBody::NodeOutput {
                            key: "choice".into(),
                            value: Value::String(choice.to_string()),
                        },
                    );
                    self.emit(
                        Some(key),
                        EventBody::NodeOutput {
                            key: "comment".into(),
                            value: Value::String(node_comment),
                        },
                    );
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
                if let Some(pos) = self.calls.iter().position(|c| c.key == key) {
                    let call = self.calls.remove(pos);
                    self.drop_worker(&call.worker_key(), call.worker);
                }
                if let Some(pos) = self.agents.iter().position(|a| a.key == key) {
                    let mut agent = self.agents.remove(pos);
                    agent.handle.cancel();
                    self.warn_integrity(&agent);
                }
                // The action thread is asked to end; its end is dropped.
                if let Some(pos) = self.actions.iter().position(|a| a.key == key) {
                    let action = self.actions.remove(pos);
                    action.cancel.store(true, Ordering::SeqCst);
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
                .map(|r| &r.key)
                .chain(self.calls.iter().map(|c| &c.key))
                .chain(self.agents.iter().map(|a| &a.key))
                .chain(self.actions.iter().map(|a| &a.key))
                .filter(|k| k.starts_with(&prefix))
                .cloned()
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
            options: BUDGET_OPTIONS.iter().map(|s| RequestOption::plain(*s)).collect(),
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
            self.poll_calls();
            self.poll_agents();
            self.poll_actions();
            self.retry_due();
            if !self.state.status.is_active() {
                if !self.in_flight() {
                    break;
                }
                self.wait_control(idle);
                continue;
            }
            if self.stop_requested {
                if !self.in_flight() {
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
            if self.in_flight() || !self.retry_at.is_empty() {
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
        self.shutdown_workers();
        self.checkpoint();
        self.state.status
    }

    /// Commands, python calls, agent turns or actions are running.
    fn in_flight(&self) -> bool {
        !self.running.is_empty()
            || !self.calls.is_empty()
            || !self.agents.is_empty()
            || !self.actions.is_empty()
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
                        NodeKind::Approval(a) => a.effective_options().first().map(|o| o.name.clone()),
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
            // A skipped or not-yet-run node leaves the output out (with a warning).
            match self.with_ctx(prefix, None, None, None, |ctx| ctx.render_value_strict(&text)) {
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
                if matches!(
                    node.kind,
                    NodeKind::Command(_)
                        | NodeKind::Python(_)
                        | NodeKind::Agent(_)
                        | NodeKind::Action(_)
                ) && self.running.len() + self.calls.len() + self.agents.len() + self.actions.len()
                    >= MAX_RUNNING_COMMANDS
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
                    let show: BTreeMap<String, ShowValue> = approval
                        .show
                        .iter()
                        .map(|name| (name.clone(), show_value(ctx, name)))
                        .collect();
                    (message, show)
                });
                let request = ApprovalRequest {
                    node_key: Some(key.to_string()),
                    options: approval.effective_options().iter().map(RequestOption::from).collect(),
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
            NodeKind::Python(py) => self.launch_call(prefix, key, node, py, attempt),
            NodeKind::Agent(agent) => self.launch_agent(prefix, key, node, agent, attempt),
            NodeKind::Action(action) => self.launch_action(prefix, key, node, action, attempt),
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
            NodeKind::Subflow(sub) => self.start_subflow(prefix, key, sub, attempt, None),
        }
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

    /// A command or call reported `needs_approval`.
    fn request_node_approval(&mut self, key: &str, attempt: u32, message: Option<String>) {
        self.set_node(key, NodeStatus::AwaitingApproval, attempt, None, None);
        let request = ApprovalRequest {
            node_key: Some(key.to_string()),
            options: COMMAND_APPROVAL_OPTIONS
                .iter()
                .map(|s| RequestOption::plain(*s))
                .collect(),
            message,
            show: BTreeMap::new(),
            reason: Reason::new(FLOW_COMMAND_NEEDS_APPROVAL),
        };
        self.emit(Some(key), EventBody::ApprovalRequested(request));
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

    /// Applies one protocol item of a command or call.
    fn apply_item(&mut self, key: &str, item: ProtocolItem, st: &mut ItemState, node_dir: &Path) {
        match item {
            ProtocolItem::Progress { text, fraction } => {
                // At most one persisted progress event per second; the latest wins.
                if st
                    .last_progress
                    .is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL)
                {
                    st.last_progress = Some(Instant::now());
                    st.pending_progress = None;
                    self.emit(Some(key), EventBody::NodeProgress { text, fraction });
                } else {
                    st.pending_progress = Some((text, fraction));
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
            ProtocolItem::Artifact {
                path,
                label,
                media_type,
            } => self.record_artifact(key, node_dir, path, label, media_type),
            ProtocolItem::Outcome(o) => st.outcome = Some(o),
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

    /// Persists the progress the throttle held back.
    fn flush_progress(&mut self, key: &str, st: &mut ItemState) {
        if let Some((text, fraction)) = st.pending_progress.take() {
            self.emit(Some(key), EventBody::NodeProgress { text, fraction });
        }
    }

    /// Records one reported artifact (spec 5.1): path inside the project,
    /// media type guessed when absent, index within the attempt, and the
    /// attempt's `artifacts.json` rewritten. An outside path is a warning.
    fn record_artifact(
        &mut self,
        key: &str,
        node_dir: &Path,
        raw: String,
        label: Option<String>,
        media_type: Option<String>,
    ) {
        // Accepted under the project, or under the scope's worktree root.
        let scope_root = self.scope_root(split_key(key).0);
        let resolved = artifacts::resolve_artifact_path(self.store.project_root(), node_dir, &raw)
            .or_else(|reason| {
                if scope_root == self.store.project_root() {
                    Err(reason)
                } else {
                    artifacts::resolve_artifact_path(&scope_root, node_dir, &raw)
                }
            });
        let resolved =
            match resolved {
                Ok(p) => p,
                Err(reason) => {
                    let warning = Reason::new(FLOW_ARTIFACT_OUTSIDE_PROJECT)
                        .with("path", raw.clone())
                        .with("reason", reason);
                    append_line(
                        &node_dir.join("stdout.log"),
                        &format!("[mdium] {FLOW_ARTIFACT_OUTSIDE_PROJECT}: {raw}"),
                    );
                    self.emit(Some(key), EventBody::Warning(warning));
                    return;
                }
            };
        let path = resolved.to_string_lossy().into_owned();
        let media_type =
            media_type.unwrap_or_else(|| artifacts::guess_media_type(&path).to_string());
        let bytes = std::fs::metadata(&resolved)
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len());
        let index = self.node(key).artifacts.len() as u32;
        self.emit(
            Some(key),
            EventBody::NodeArtifact {
                index,
                path,
                label,
                media_type,
                bytes,
                recorded_at: fsutil::now(),
            },
        );
        let list = self.node(key).artifacts.clone();
        if let Err(err) = artifacts::write_artifacts_json(node_dir, &list) {
            let warning = Reason::new(FLOW_ARTIFACT_WRITE_FAILED).with("message", err.to_string());
            self.emit(Some(key), EventBody::Warning(warning));
        }
    }

    fn protocol_warning(&mut self, key: Option<&str>, reason: &str, extra: Vec<(&str, Value)>) {
        let mut warning = Reason::new(FLOW_PROTOCOL_WARNING).with("reason", reason);
        for (name, value) in extra {
            warning = warning.with(name, value);
        }
        self.emit(key, EventBody::Warning(warning));
    }

    /// Writes the node's current outputs to the attempt's `outputs.json`.
    fn write_outputs(&self, key: &str, dir: &Path) {
        let _ = std::fs::write(
            dir.join("outputs.json"),
            serde_json::to_vec_pretty(&self.node(key).outputs).unwrap_or_default(),
        );
    }

    fn emit_outputs(&mut self, key: &str, outputs: BTreeMap<String, Value>) {
        for (name, value) in outputs {
            self.emit(Some(key), EventBody::NodeOutput { key: name, value });
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

/// Resolves one `show` entry; artifact references keep their typed form.
fn show_value(ctx: &TemplateContext, name: &str) -> ShowValue {
    let artifacts = |node: &str, label: Option<&str>| {
        let Some(seen) = (ctx.artifacts)(node).filter(|seen| seen.ran) else {
            return ShowValue::Value(Value::Null);
        };
        let mut artifacts = seen.artifacts;
        if let Some(label) = label {
            artifacts.retain(|a| a.label.as_deref() == Some(label));
            if artifacts.is_empty() {
                return ShowValue::Value(Value::Null);
            }
        }
        ShowValue::Artifacts(ShowArtifacts {
            kind: ShowKind::Artifacts,
            node_key: seen.node_key,
            attempt: seen.attempt,
            artifacts,
        })
    };
    match template::parse_reference(name) {
        Ok(Reference::NodeArtifacts { node }) => artifacts(&node, None),
        Ok(Reference::NodeArtifact { node, label }) => artifacts(&node, Some(&label)),
        Ok(reference) => ctx
            .resolve(&reference)
            .map_or(ShowValue::Value(Value::Null), ShowValue::Value),
        Err(_) => ShowValue::Value(Value::Null),
    }
}

/// The manifest's `runtimes` and `setup` as compared for a sub-flow opened
/// in a worktree (no manifest: both empty).
fn runtimes_and_setup(project: Option<&crate::project::ProjectDef>) -> Value {
    let runtimes = project
        .and_then(|p| serde_json::to_value(&p.runtimes).ok())
        .unwrap_or_else(|| Value::Object(Default::default()));
    let setup = project
        .and_then(|p| serde_json::to_value(&p.setup).ok())
        .unwrap_or_else(|| Value::Array(Vec::new()));
    serde_json::json!({ "runtimes": runtimes, "setup": setup })
}

/// Resolves a node's (or the flow default's) `workingDir` against the
/// project root; without one the node runs in the project root. Rendering is
/// strict: a skipped or not-yet-run node's reference is unresolved instead of
/// `""`, and a template that renders empty is `empty(template)`; either would
/// otherwise silently run the node in the project root (or at `/`).
fn resolve_working_dir(
    ctx: &TemplateContext,
    root: &Path,
    dir: Option<&str>,
    empty: impl Fn(&str) -> Reason,
) -> Result<PathBuf, Reason> {
    Ok(match dir.filter(|dir| !dir.trim().is_empty()) {
        Some(dir) => {
            let rendered = ctx.render_string_strict(dir)?;
            if rendered.trim().is_empty() {
                return Err(empty(dir));
            }
            let rendered = PathBuf::from(rendered);
            if rendered.is_absolute() {
                rendered
            } else {
                root.join(rendered)
            }
        }
        None => root.to_path_buf(),
    })
}

/// Appends one line to a log file (best effort).
fn append_line(path: &Path, line: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
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
        let mut driver = Driver::open(store, run_id, rx, env)?;
        driver.offline = true;
        Ok(Self { driver })
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

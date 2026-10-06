//! The serial run driver (spec 4.2–4.8, PR 3 subset): one thread per run
//! that owns the run's event log. It resolves joins and `when`, runs
//! command nodes, pauses on approvals and budget, honours stop / cancel /
//! timeouts, and records everything as events. State only ever changes by
//! appending an event and applying it (see [`Driver::emit`]).

use crate::flow::condition::Condition;
use crate::flow::model::{
    parse_duration, CommandNode, CommandProtocol, CommandRun, FlowDef, FlowNode, NodeKind, RetryOn,
    RetryPolicy, PORT_FAILURE, PORT_SUCCESS,
};
use crate::flow::run::model::*;
use crate::flow::run::prepare::TemplateContext;
use crate::flow::run::process::{
    decide, ensure_parent, CommandResult, LaunchSpec, Launcher, ProcessHandle, ProtocolItem,
    ProtocolOutcome, ProtocolReader,
};
use crate::flow::run::store::{EventLog, RunMeta, RunStore, CHECKPOINT_EVERY};
use crate::flow::template::{self, Reference};
use crate::workflow::fsutil;
use serde_json::Value;
use std::collections::BTreeMap;
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
pub const FLOW_BUDGET_EXCEEDED: &str = "FLOW_BUDGET_EXCEEDED";
pub const FLOW_APPROVAL_NODE: &str = "FLOW_APPROVAL_NODE";
pub const FLOW_COMMAND_NEEDS_APPROVAL: &str = "FLOW_COMMAND_NEEDS_APPROVAL";
pub const FLOW_COMMAND_SPAWN_FAILED: &str = "FLOW_COMMAND_SPAWN_FAILED";
pub const FLOW_CONDITION_TYPE: &str = "FLOW_CONDITION_TYPE";
pub const FLOW_APPROVAL_REJECTED: &str = "FLOW_APPROVAL_REJECTED";
pub const FLOW_PROTOCOL_WARNING: &str = "FLOW_PROTOCOL_WARNING";
pub const FLOW_RESUMED: &str = "FLOW_RESUMED";

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
    /// App exit: kill running processes, mark them and the run interrupted.
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
    pub sink: Arc<dyn EventSink>,
    pub notifiers: Arc<Vec<Arc<dyn ApprovalNotifier>>>,
    /// Process environment visible to `env.*` templates (passthrough filtered per flow).
    pub process_env: Arc<BTreeMap<String, String>>,
    /// How often running processes and the STOP file are polled.
    pub poll: Duration,
}

/// Minimum interval between persisted progress events of one node.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);

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
}

/// How a command's monitoring ended.
enum Ended {
    Exited(i32),
    Timeout,
    GraceKilled,
    Cancelled,
    Shutdown,
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
        })
    }

    pub fn state(&self) -> &RunState {
        &self.state
    }

    fn flow(&self) -> &FlowDef {
        &self.meta.flow
    }

    fn node_def(&self, key: &str) -> Option<&FlowNode> {
        self.meta.flow.nodes.iter().find(|n| n.id == key)
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
    fn wait_control(&mut self) {
        match self
            .ctrl
            .recv_timeout(self.env.poll.max(Duration::from_millis(20)) * 2)
        {
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
                    let base = self.flow().limits.budget_usd.unwrap_or(0.0);
                    let current = self
                        .state
                        .budget_limit_usd
                        .or(self.flow().limits.budget_usd)
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
                    self.node_def(key).map(|n| &n.kind),
                    Some(NodeKind::Approval(_))
                );
                if is_approval_node {
                    self.set_node(
                        key,
                        NodeStatus::Succeeded,
                        attempt,
                        None,
                        Some(choice.to_string()),
                    );
                } else if choice == "approve" {
                    self.set_node(
                        key,
                        NodeStatus::Succeeded,
                        attempt,
                        None,
                        Some(PORT_SUCCESS.into()),
                    );
                } else {
                    let reason = Reason::new(FLOW_APPROVAL_REJECTED);
                    self.fail_node(key, attempt, reason);
                }
            }
        }
        true
    }

    // ------------------------------------------------------------- graph

    fn has_failure_edge(&self, key: &str) -> bool {
        self.flow()
            .edges
            .iter()
            .any(|e| e.from == key && e.port() == PORT_FAILURE)
    }

    /// Marks a node failed (port `failure`); without a failure edge the run fails.
    fn fail_node(&mut self, key: &str, attempt: u32, reason: Reason) {
        self.set_node(
            key,
            NodeStatus::Failed,
            attempt,
            Some(reason.clone()),
            Some(PORT_FAILURE.into()),
        );
        if !self.has_failure_edge(key) {
            self.ensure_running();
            self.set_run(
                RunStatus::Failed,
                Some(
                    Reason::new(FLOW_NODE_FAILED)
                        .with("node", key)
                        .with("cause", reason.code),
                ),
            );
        }
    }

    /// Leaves `awaiting_approval` before a transition that needs `running`.
    fn ensure_running(&mut self) {
        if self.state.status == RunStatus::AwaitingApproval {
            self.set_run(RunStatus::Running, None);
        }
    }

    fn resolver<'a>(
        &'a self,
        node_dir: Option<&'a Path>,
        run_dir: &'a Path,
        env: &'a BTreeMap<String, String>,
    ) -> TemplateContext<'a> {
        TemplateContext {
            params: &self.meta.params,
            state: &self.state,
            run_id: &self.run_id,
            run_dir,
            node_dir,
            project_root: self.store.project_root(),
            env,
        }
    }

    fn passthrough_env(&self) -> BTreeMap<String, String> {
        self.flow()
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

    /// Settles pending nodes whose incoming edges are all resolved:
    /// `ready`, or `skipped` (no taken edge, or `when` false). Repeats until
    /// nothing changes so skips propagate.
    fn resolve_pending(&mut self) {
        loop {
            let mut changed = false;
            let keys: Vec<String> = self.flow().nodes.iter().map(|n| n.id.clone()).collect();
            for key in keys {
                if self.node(&key).status != NodeStatus::Pending
                    || self.state.status.is_finished()
                    || self.state.status == RunStatus::Failed
                {
                    continue;
                }
                let incoming: Vec<(String, String)> = self
                    .flow()
                    .edges
                    .iter()
                    .filter(|e| e.to == key)
                    .map(|e| (e.from.clone(), e.port().to_string()))
                    .collect();
                let mut unresolved = false;
                let mut taken = incoming.is_empty();
                for (from, port) in &incoming {
                    let source = self.node(from);
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
                changed = true;
                if !taken {
                    self.set_node(&key, NodeStatus::Skipped, 0, None, None);
                    continue;
                }
                match self.when_holds(&key) {
                    Ok(true) => {
                        self.set_node(&key, NodeStatus::Ready, 0, None, None);
                    }
                    Ok(false) => {
                        // A `when`-skipped node lets the flow continue (spec 8.1).
                        let port = match self.node_def(&key).map(|n| &n.kind) {
                            Some(NodeKind::Approval(a)) => a.effective_options().first().cloned(),
                            _ => Some(PORT_SUCCESS.to_string()),
                        };
                        self.set_node(&key, NodeStatus::Skipped, 0, None, port);
                    }
                    Err(reason) => {
                        self.set_node(&key, NodeStatus::Ready, 0, None, None);
                        self.set_node(&key, NodeStatus::Running, 1, None, None);
                        self.fail_node(&key, 1, reason);
                    }
                }
            }
            if !changed {
                break;
            }
        }
    }

    fn when_holds(&self, key: &str) -> Result<bool, Reason> {
        let Some(condition) = self.node_def(key).and_then(|n| n.when.clone()) else {
            return Ok(true);
        };
        self.evaluate(&condition)
    }

    fn evaluate(&self, condition: &Condition) -> Result<bool, Reason> {
        let run_dir = self.run_dir();
        let env = self.passthrough_env();
        let ctx = self.resolver(None, &run_dir, &env);
        condition
            .evaluate(&|r: &Reference| ctx.resolve(r))
            .map_err(|e| {
                Reason::new(FLOW_CONDITION_TYPE)
                    .with("ref", e.reference)
                    .with("op", e.op)
            })
    }

    fn next_ready(&self) -> Option<String> {
        self.flow()
            .nodes
            .iter()
            .find(|n| self.node(&n.id).status == NodeStatus::Ready)
            .map(|n| n.id.clone())
    }

    fn has_awaiting(&self) -> bool {
        !self.state.approvals.is_empty()
    }

    // ------------------------------------------------------------ budget

    fn budget_limit(&self) -> Option<f64> {
        self.state
            .budget_limit_usd
            .or(self.flow().limits.budget_usd)
    }

    /// Requests a budget approval when spending passed the limit.
    fn check_budget(&mut self) {
        let Some(limit) = self.budget_limit() else {
            return;
        };
        let spent = self.state.cost.total();
        if spent <= limit || self.state.approvals.iter().any(|a| a.node_key.is_none()) {
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
        // Nodes waiting for a retry when the run was stopped start over.
        let waiting: Vec<(String, u32)> = self
            .state
            .nodes
            .iter()
            .filter(|(_, n)| n.status == NodeStatus::RetryWait)
            .map(|(k, n)| (k.clone(), n.attempt))
            .collect();
        match self.state.status {
            RunStatus::Pending | RunStatus::Paused | RunStatus::Interrupted | RunStatus::Failed => {
                self.set_run(RunStatus::Running, resume_reason);
            }
            _ => {}
        }
        for (key, attempt) in waiting {
            self.set_node(&key, NodeStatus::Ready, attempt, None, None);
        }
        loop {
            self.drain_controls();
            if self.shutdown_requested {
                // No process is running here: leave the status as it is
                // (approvals survive restarts; a `running` run without a
                // running node is recovered as `interrupted`).
                break;
            }
            if self.cancel_requested {
                self.set_run(RunStatus::Cancelled, Some(Reason::new(FLOW_RUN_CANCELLED)));
                break;
            }
            let status = self.state.status;
            if !status.is_active() {
                break;
            }
            if self.stop_requested {
                self.set_run(RunStatus::Stopping, Some(Reason::new(FLOW_STOP_REQUESTED)));
                self.set_run(RunStatus::Paused, Some(Reason::new(FLOW_STOP_REQUESTED)));
                break;
            }
            if status == RunStatus::AwaitingApproval && !self.has_awaiting() {
                self.set_run(RunStatus::Running, None);
                continue;
            }
            self.check_budget();
            self.resolve_pending();
            if !self.state.status.is_active() {
                continue;
            }
            if !self.budget_pending() {
                if let Some(key) = self.next_ready() {
                    self.ensure_running();
                    self.execute(&key);
                    continue;
                }
            }
            if self.has_awaiting() {
                if self.state.status == RunStatus::Running {
                    self.set_run(RunStatus::AwaitingApproval, None);
                }
                self.wait_control();
                continue;
            }
            // Nothing pending, ready or waiting: the run is over.
            self.set_run(RunStatus::Completed, None);
            break;
        }
        self.checkpoint();
        self.state.status
    }

    /// App exit: running nodes and the run become `interrupted`.
    fn interrupt(&mut self, running: Option<(&str, u32)>) {
        if let Some((key, attempt)) = running {
            self.set_node(
                key,
                NodeStatus::Interrupted,
                attempt,
                Some(Reason::new(FLOW_APP_EXITED)),
                None,
            );
        }
        self.set_run(RunStatus::Interrupted, Some(Reason::new(FLOW_APP_EXITED)));
    }

    fn execute(&mut self, key: &str) {
        let Some(node) = self.node_def(key).cloned() else {
            return;
        };
        let attempt = self.node(key).attempt + 1;
        match &node.kind {
            NodeKind::Approval(approval) => {
                self.set_node(key, NodeStatus::Running, attempt, None, None);
                let run_dir = self.run_dir();
                let env = self.passthrough_env();
                let ctx = self.resolver(None, &run_dir, &env);
                let message = approval
                    .message
                    .as_deref()
                    .map(|m| ctx.render_string(m).unwrap_or_else(|_| m.to_string()));
                let show = approval
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
            NodeKind::Command(command) => self.execute_command(key, &node, command, attempt),
            // Rejected before the run started (prepare::check_runnable).
            other => {
                self.set_node(key, NodeStatus::Running, attempt, None, None);
                self.fail_node(
                    key,
                    attempt,
                    Reason::new("FLOW_RUN_UNSUPPORTED").with("feature", other.name()),
                );
            }
        }
    }

    fn retry_policy(&self, node: &FlowNode) -> Option<RetryPolicy> {
        node.retry
            .clone()
            .or_else(|| self.flow().defaults.retry.clone())
    }

    fn node_timeout(&self, node: &FlowNode) -> Option<Duration> {
        node.timeout
            .as_deref()
            .or(self.flow().defaults.timeout.as_deref())
            .and_then(parse_duration)
    }

    fn execute_command(&mut self, key: &str, node: &FlowNode, command: &CommandNode, attempt: u32) {
        self.set_node(key, NodeStatus::Running, attempt, None, None);
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
        let spec = match self.prepare_launch(node, command, &dir) {
            Ok(spec) => spec,
            Err(reason) => return self.fail_node(key, attempt, reason),
        };
        let mut handle = match self.env.launcher.launch(&spec) {
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
                started_at: fsutil::now(),
                exit_file: None,
            },
        );
        let reader = (command.protocol == CommandProtocol::MdiumV1)
            .then(|| ProtocolReader::new(&dir.join("events.jsonl")));
        let (ended, outcome) = self.monitor(key, node, handle.as_mut(), reader);
        let _ = std::fs::write(
            dir.join("outputs.json"),
            serde_json::to_vec_pretty(&self.node(key).outputs).unwrap_or_default(),
        );
        let result = match ended {
            Ended::Exited(code) => {
                let success = command.success_codes.clone().unwrap_or_else(|| vec![0]);
                decide(outcome.as_ref(), code, &success)
            }
            Ended::Timeout => CommandResult::Failed {
                code: FLOW_NODE_TIMEOUT,
                detail: None,
            },
            Ended::GraceKilled => {
                self.set_node(
                    key,
                    NodeStatus::Ready,
                    attempt,
                    Some(Reason::new(FLOW_STOP_GRACE_EXCEEDED)),
                    None,
                );
                return;
            }
            Ended::Cancelled => {
                self.set_node(
                    key,
                    NodeStatus::Cancelled,
                    attempt,
                    Some(Reason::new(FLOW_RUN_CANCELLED)),
                    None,
                );
                return;
            }
            Ended::Shutdown => {
                self.interrupt(Some((key, attempt)));
                return;
            }
        };
        match result {
            CommandResult::Succeeded => {
                self.set_node(
                    key,
                    NodeStatus::Succeeded,
                    attempt,
                    None,
                    Some(PORT_SUCCESS.into()),
                );
            }
            CommandResult::Stopped => {
                self.set_node(
                    key,
                    NodeStatus::Ready,
                    attempt,
                    Some(Reason::new(FLOW_NODE_STOPPED)),
                    None,
                );
            }
            CommandResult::NeedsApproval(message) => {
                self.set_node(key, NodeStatus::AwaitingApproval, attempt, None, None);
                let request = ApprovalRequest {
                    node_key: Some(key.to_string()),
                    options: COMMAND_APPROVAL_OPTIONS
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                    message,
                    show: BTreeMap::new(),
                    reason: Reason::new(FLOW_COMMAND_NEEDS_APPROVAL),
                };
                self.emit(Some(key), EventBody::ApprovalRequested(request));
            }
            CommandResult::Failed { code, detail } => {
                let mut reason = Reason::new(code);
                if let Some(detail) = detail {
                    reason = reason.with("detail", detail);
                }
                self.after_failure(key, node, attempt, reason, code == FLOW_NODE_TIMEOUT);
            }
        }
    }

    /// Retries per the node's policy, or fails it.
    fn after_failure(
        &mut self,
        key: &str,
        node: &FlowNode,
        attempt: u32,
        reason: Reason,
        timed_out: bool,
    ) {
        if let Some(policy) = self.retry_policy(node) {
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
                let until = Instant::now() + backoff;
                while Instant::now() < until
                    && !self.stop_requested
                    && !self.cancel_requested
                    && !self.shutdown_requested
                {
                    self.wait_control();
                }
                if self.cancel_requested || self.shutdown_requested {
                    // Leave it in retry_wait; it becomes ready when the run resumes.
                    return;
                }
                self.set_node(key, NodeStatus::Ready, attempt, None, None);
                return;
            }
        }
        self.fail_node(key, attempt, reason);
    }

    fn prepare_launch(
        &self,
        node: &FlowNode,
        command: &CommandNode,
        dir: &Path,
    ) -> Result<LaunchSpec, Reason> {
        let spawn_err = |e: std::io::Error| {
            Reason::new(FLOW_COMMAND_SPAWN_FAILED).with("message", e.to_string())
        };
        std::fs::create_dir_all(dir).map_err(spawn_err)?;
        let events = dir.join("events.jsonl");
        let inputs = dir.join("inputs.json");
        ensure_parent(&events).map_err(spawn_err)?;
        std::fs::File::create(&events).map_err(spawn_err)?;
        std::fs::write(&inputs, b"{}").map_err(spawn_err)?;
        let run_dir = self.run_dir();
        let passthrough = self.passthrough_env();
        let ctx = self.resolver(Some(dir), &run_dir, &passthrough);
        let argv = match &command.run {
            CommandRun::Argv(argv) => argv
                .iter()
                .map(|a| ctx.render_string(a))
                .collect::<Result<Vec<_>, _>>()?,
            CommandRun::Shell(text) => vec![text.clone()],
        };
        let root = self.store.project_root();
        let working_dir = match command.working_dir.as_deref().or(self
            .flow()
            .defaults
            .working_dir
            .as_deref())
        {
            Some(dir) => {
                let rendered = PathBuf::from(ctx.render_string(dir)?);
                if rendered.is_absolute() {
                    rendered
                } else {
                    root.join(rendered)
                }
            }
            None => root.to_path_buf(),
        };
        let mut env: Vec<(String, String)> = Vec::new();
        for (name, value) in self.flow().env.iter().chain(command.env.iter()) {
            env.push((name.clone(), ctx.render_string(value)?));
        }
        let stop_file = self
            .store
            .stop_file(&self.run_id)
            .map_err(|e| Reason::new(FLOW_COMMAND_SPAWN_FAILED).with("message", e.to_string()))?;
        let s = |p: &Path| p.to_string_lossy().into_owned();
        env.extend([
            ("MDIUM_FLOW_RUN_ID".to_string(), self.run_id.clone()),
            ("MDIUM_FLOW_NODE_KEY".to_string(), node.id.clone()),
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
        })
    }

    /// Watches a running command until it exits, times out, or a control ends it.
    fn monitor(
        &mut self,
        key: &str,
        node: &FlowNode,
        handle: &mut dyn ProcessHandle,
        mut reader: Option<ProtocolReader>,
    ) -> (Ended, Option<ProtocolOutcome>) {
        let started = Instant::now();
        let timeout = self.node_timeout(node);
        let grace = self
            .flow()
            .limits
            .stop_grace
            .as_deref()
            .and_then(parse_duration);
        let mut grace_deadline: Option<Instant> = None;
        let mut outcome: Option<ProtocolOutcome> = None;
        let mut last_progress: Option<Instant> = None;
        let mut pending_progress: Option<(String, Option<f64>)> = None;
        let ended = loop {
            if let Some(reader) = reader.as_mut() {
                for item in reader.poll(false) {
                    self.protocol_item(
                        key,
                        item,
                        &mut outcome,
                        &mut last_progress,
                        &mut pending_progress,
                    );
                }
            }
            match handle.try_wait() {
                Ok(Some(code)) => break Ended::Exited(code),
                Ok(None) => {}
                Err(_) => break Ended::Exited(-1),
            }
            self.drain_controls_while_running();
            if self.shutdown_requested {
                handle.kill_tree();
                break Ended::Shutdown;
            }
            if self.cancel_requested {
                handle.kill_tree();
                break Ended::Cancelled;
            }
            if self.stop_requested && grace_deadline.is_none() {
                self.set_run(RunStatus::Stopping, Some(Reason::new(FLOW_STOP_REQUESTED)));
                let _ = self
                    .store
                    .stop_file(&self.run_id)
                    .map(|p| std::fs::write(p, b""));
                grace_deadline = Some(grace.map(|g| Instant::now() + g).unwrap_or_else(far_future));
            }
            if grace_deadline.is_some_and(|d| Instant::now() >= d) {
                handle.kill_tree();
                break Ended::GraceKilled;
            }
            if timeout.is_some_and(|t| started.elapsed() >= t) {
                handle.kill_tree();
                break Ended::Timeout;
            }
            std::thread::sleep(self.env.poll);
        };
        if let Some(reader) = reader.as_mut() {
            for item in reader.poll(true) {
                self.protocol_item(
                    key,
                    item,
                    &mut outcome,
                    &mut last_progress,
                    &mut pending_progress,
                );
            }
        }
        if let Some((text, fraction)) = pending_progress.take() {
            self.emit(Some(key), EventBody::NodeProgress { text, fraction });
        }
        (ended, outcome)
    }

    /// Controls while a command runs: approvals for other nodes apply now.
    fn drain_controls_while_running(&mut self) {
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

    fn protocol_item(
        &mut self,
        key: &str,
        item: ProtocolItem,
        outcome: &mut Option<ProtocolOutcome>,
        last_progress: &mut Option<Instant>,
        pending_progress: &mut Option<(String, Option<f64>)>,
    ) {
        match item {
            ProtocolItem::Progress { text, fraction } => {
                // At most one persisted progress event per second; the latest wins.
                if last_progress.is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL) {
                    *last_progress = Some(Instant::now());
                    *pending_progress = None;
                    self.emit(Some(key), EventBody::NodeProgress { text, fraction });
                } else {
                    *pending_progress = Some((text, fraction));
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
            ProtocolItem::Outcome(o) => *outcome = Some(o),
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

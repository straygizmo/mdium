//! Driver: `agent` nodes, from the prepared prompt through the runner turn
//! (guards, integrity, cost) to the outcome contract.

use super::*;

/// Reason param of a screening request: SHA-256 of the screened text.
pub(super) const SCREENED_SHA256: &str = "screenedSha256";

/// An agent turn in flight.
pub(super) struct RunningAgent {
    pub(super) key: String,
    pub(super) attempt: u32,
    pub(super) dir: PathBuf,
    pub(super) handle: Box<dyn AgentTurnHandle>,
    pub(super) contract: OutputContract,
    /// `stdout.log`, open for appending.
    pub(super) log: Option<std::fs::File>,
    pub(super) items: ItemState,
    pub(super) started: Instant,
    pub(super) timeout: Option<Duration>,
    pub(super) grace_deadline: Option<Instant>,
    pub(super) cancel_sent: bool,
    /// The timeout's cancel was sent: any ending counts as a timeout.
    pub(super) timed_out: bool,
    /// The first guard violation of the turn (`rule`, `summary`).
    pub(super) violation: Option<(String, String)>,
    pub(super) estimate_usd: Option<f64>,
    /// The turn's working directory: the base of relative artifact paths.
    pub(super) working_dir: PathBuf,
    /// Integrity snapshot of the project repo taken right before a
    /// `full-access` turn (`None`: read-only, or not a git repo).
    pub(super) baseline: Option<IntegritySnapshot>,
}

/// Inputs and prompt of an agent attempt, written to its node dir.
pub(super) struct PreparedAgent {
    pub(super) dir: PathBuf,
    /// The node's provider (a templated one rendered in the node's scope).
    pub(super) provider: crate::provider::Provider,
    pub(super) prompt: String,
    pub(super) working_dir: PathBuf,
    /// The untrusted text screened before a `full-access` turn: the rendered
    /// `with` strings plus non-built-in instructions.
    pub(super) screening: String,
}

/// How an agent turn's monitoring ended.
pub(super) enum AgentFinish {
    Turn(AgentTurnEvent),
    /// The stop grace passed before the turn ended.
    GraceKilled,
}

/// The text screened before a `full-access` turn: every string in the
/// rendered inputs, then the instructions (when not built in).
fn screening_text(inputs: &BTreeMap<String, Value>, instructions: Option<&str>) -> String {
    fn strings<'v>(value: &'v Value, out: &mut Vec<&'v str>) {
        match value {
            Value::String(s) => out.push(s),
            Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
            Value::Object(map) => map.values().for_each(|v| strings(v, out)),
            _ => {}
        }
    }
    let mut parts = Vec::new();
    for value in inputs.values() {
        strings(value, &mut parts);
    }
    parts.extend(instructions);
    parts.join("\n\n")
}

/// An integrity snapshot failed: the turn cannot be verified.
fn integrity_snapshot_failed(err: &integrity::IntegrityError) -> Reason {
    Reason::new(FLOW_AGENT_INTEGRITY_CHANGED)
        .with(
            "changes",
            Value::Array(vec![Value::String("INTEGRITY_SNAPSHOT_FAILED".into())]),
        )
        .with("detail", err.to_string())
}

/// The question and answer saved in an attempt dir's `answer.json`.
fn read_answer(dir: &Path) -> Option<PreviousTurn> {
    let saved: Value = serde_json::from_slice(&std::fs::read(dir.join("answer.json")).ok()?).ok()?;
    let field = |name: &str| saved.get(name).and_then(Value::as_str).map(str::to_string);
    Some(PreviousTurn {
        question: field("question")?,
        body: field("body")?,
        answer: field("answer")?,
    })
}

impl Driver {
    // ------------------------------------------------------- agent nodes

    /// Starts one turn of an `agent` node.
    pub(super) fn launch_agent(
        &mut self,
        prefix: &str,
        key: &str,
        node: &FlowNode,
        agent: &AgentNode,
        attempt: u32,
    ) {
        let previous = self.previous_turn(key, attempt);
        let prepared = match self.prepare_agent(prefix, key, agent, attempt, previous.as_ref()) {
            Ok(prepared) => prepared,
            Err(reason) => return self.fail_node(key, attempt, reason),
        };
        if agent.permission == AgentPermission::FullAccess
            && self.screening_ack.get(key) != Some(&prepared.screening)
        {
            let findings = screening::screen(&prepared.screening);
            if !findings.is_empty() {
                // `prompt.md` is written already, so the user can inspect it.
                return self.request_agent_screening(key, attempt, &findings, &prepared.screening);
            }
        }
        self.start_agent_turn(prefix, key, node, agent, attempt, prepared);
    }

    /// Asks the user before a `full-access` turn whose inputs look suspicious.
    /// The reason carries the screened text's SHA-256 (`screenedSha256`), so
    /// the approval covers exactly that text.
    fn request_agent_screening(
        &mut self,
        key: &str,
        attempt: u32,
        findings: &[screening::Finding],
        screened: &str,
    ) {
        let findings: Vec<Value> = findings
            .iter()
            .map(|f| serde_json::json!({ "code": f.kind.code(), "line": f.line, "excerpt": f.excerpt }))
            .collect();
        self.set_node(key, NodeStatus::AwaitingApproval, attempt, None, None);
        let request = ApprovalRequest {
            node_key: Some(key.to_string()),
            options: COMMAND_APPROVAL_OPTIONS
                .iter()
                .map(|s| RequestOption::plain(*s))
                .collect(),
            // The UI explains the request from its reason code.
            message: None,
            show: BTreeMap::from([(
                "findings".to_string(),
                ShowValue::Value(Value::Array(findings)),
            )]),
            reason: Reason::new(FLOW_AGENT_SCREENING)
                .with(SCREENED_SHA256, sha256_hex(screened.as_bytes())),
        };
        self.emit(Some(key), EventBody::ApprovalRequested(request));
    }

    /// The user decided on a screening request: `approve` starts the turn in
    /// the same attempt, anything else fails the node. The inputs are
    /// rendered again; when they are no longer the text the user saw (a
    /// referenced node ran in between), they are screened again and the user
    /// is asked again instead of starting.
    pub(super) fn agent_screening_decided(
        &mut self,
        key: &str,
        attempt: u32,
        request: &ApprovalRequest,
        choice: &str,
    ) {
        if choice != "approve" {
            return self.fail_node(key, attempt, Reason::new(FLOW_APPROVAL_REJECTED));
        }
        let Some((prefix, node)) = self.def_of(key) else {
            return;
        };
        let NodeKind::Agent(agent) = &node.kind else {
            return;
        };
        if self.offline {
            // Resuming starts (and screens) a new attempt.
            self.set_node(key, NodeStatus::Ready, attempt, None, None);
            return;
        }
        self.set_node(key, NodeStatus::Running, attempt, None, None);
        let previous = self.previous_turn(key, attempt);
        let prepared = match self.prepare_agent(&prefix, key, agent, attempt, previous.as_ref()) {
            Ok(prepared) => prepared,
            Err(reason) => return self.fail_node(key, attempt, reason),
        };
        let approved = request
            .reason
            .params
            .get(SCREENED_SHA256)
            .and_then(Value::as_str);
        if approved != Some(sha256_hex(prepared.screening.as_bytes()).as_str()) {
            let findings = screening::screen(&prepared.screening);
            if !findings.is_empty() {
                return self.request_agent_screening(key, attempt, &findings, &prepared.screening);
            }
        }
        self.screening_ack
            .insert(key.to_string(), prepared.screening.clone());
        self.start_agent_turn(&prefix, key, &node, agent, attempt, prepared);
    }

    /// The question and answer that feed `attempt`: the most recent
    /// `answer.json` of an earlier attempt that no started turn consumed yet.
    /// A started turn leaves `stdout.log` in its attempt dir (attempts that
    /// were only prepared, screened or never started have none).
    fn previous_turn(&self, key: &str, attempt: u32) -> Option<PreviousTurn> {
        for earlier in (1..attempt).rev() {
            let dir = self.store.node_attempt_dir(&self.run_id, key, earlier).ok()?;
            if let Some(turn) = read_answer(&dir) {
                return Some(turn);
            }
            if dir.join("stdout.log").exists() {
                return None;
            }
        }
        None
    }

    /// An agent answered `awaiting_user`: ask the user its question.
    fn request_agent_question(&mut self, key: &str, attempt: u32, question: String, body: String) {
        self.agent_questions
            .insert(key.to_string(), (question.clone(), body));
        self.set_node(key, NodeStatus::AwaitingApproval, attempt, None, None);
        let request = ApprovalRequest {
            node_key: Some(key.to_string()),
            options: vec![
                RequestOption {
                    name: "answer".into(),
                    comment_required: true,
                },
                RequestOption::plain("reject"),
            ],
            message: Some(question),
            show: BTreeMap::new(),
            reason: Reason::new(FLOW_AGENT_QUESTION),
        };
        self.emit(Some(key), EventBody::ApprovalRequested(request));
    }

    /// The user answered (or rejected) an agent's question: `answer` reruns
    /// the agent in a new attempt whose prompt carries the question, the
    /// previous response body and the answer.
    pub(super) fn agent_question_answered(
        &mut self,
        key: &str,
        attempt: u32,
        request: &ApprovalRequest,
        choice: &str,
        answer: String,
    ) {
        let asked = self.agent_questions.remove(key);
        if choice != "answer" {
            return self.fail_node(key, attempt, Reason::new(FLOW_APPROVAL_REJECTED));
        }
        // After a restart the question lives only in the request and the node dir.
        let (question, body) = asked.unwrap_or_else(|| {
            let response = self
                .store
                .node_attempt_dir(&self.run_id, key, attempt)
                .ok()
                .and_then(|dir| std::fs::read_to_string(dir.join("response.md")).ok())
                .unwrap_or_default();
            let body = parse_outcome(&response)
                .map(|o| o.body)
                .unwrap_or(response);
            (request.message.clone().unwrap_or_default(), body)
        });
        // Saved in the asking attempt's dir: the next started attempt reads
        // it, even after a stop, a restart or an offline answer.
        let saved = serde_json::json!({
            "attempt": attempt,
            "question": question,
            "body": body,
            "answer": answer,
        });
        let written = self
            .store
            .node_attempt_dir(&self.run_id, key, attempt)
            .map_err(|e| e.to_string())
            .and_then(|dir| {
                std::fs::write(
                    dir.join("answer.json"),
                    serde_json::to_vec_pretty(&saved).unwrap_or_default(),
                )
                .map_err(|e| e.to_string())
            });
        if let Err(message) = written {
            return self.fail_node(
                key,
                attempt,
                Reason::new(FLOW_AGENT_START_FAILED).with("message", message),
            );
        }
        // The node starts its next attempt like any ready node.
        self.set_node(key, NodeStatus::Ready, attempt, None, None);
    }

    /// Renders the inputs and the prompt of an attempt and writes
    /// `inputs.json` and `prompt.md` to its node dir.
    fn prepare_agent(
        &self,
        prefix: &str,
        key: &str,
        agent: &AgentNode,
        attempt: u32,
        previous: Option<&PreviousTurn>,
    ) -> Result<PreparedAgent, Reason> {
        let io_failed =
            |message: String| Reason::new(FLOW_AGENT_START_FAILED).with("message", message);
        let dir = self
            .store
            .node_attempt_dir(&self.run_id, key, attempt)
            .map_err(|e| io_failed(e.to_string()))?;
        std::fs::create_dir_all(&dir).map_err(|e| io_failed(e.to_string()))?;
        // Inside a worktree scope the working dir default and `promptRef`
        // resolve against the worktree.
        let root = self.scope_root(prefix);
        // The owner flow file's directory is the base of a relative `promptRef`.
        let base_dir = self
            .scope_init(prefix)
            .and_then(|init| {
                root.join(scope::unrooted_file(&init.graph.file))
                    .parent()
                    .map(Path::to_path_buf)
            })
            .unwrap_or_else(|| root.clone());
        let default_dir = self.file_flow(prefix).defaults.working_dir.clone();
        let (provider, inputs, instructions, builtin, working_dir) =
            self.with_ctx(prefix, None, Some(&dir), None, |ctx| {
                let provider = match &agent.provider {
                    ProviderRef::Fixed(provider) => *provider,
                    ProviderRef::Template(text) => {
                        let name = ctx.render_string(text)?;
                        crate::provider::Provider::from_name(name.trim()).ok_or_else(|| {
                            Reason::new(FLOW_PROVIDER_UNAVAILABLE).with("provider", name)
                        })?
                    }
                };
                let inputs = match ctx
                    .render_json(&Value::Object(agent.with_args.clone().into_iter().collect()))?
                {
                    Value::Object(map) => map.into_iter().collect::<BTreeMap<String, Value>>(),
                    _ => BTreeMap::new(),
                };
                let instructions = match (&agent.prompt, &agent.prompt_ref) {
                    (Some(text), _) => ctx.render_string(text)?,
                    (None, Some(reference)) => match reference.strip_prefix("builtin:") {
                        Some(name) => prompts::builtin(name)
                            .ok_or_else(|| {
                                Reason::new(FLOW_AGENT_PROMPT_INVALID)
                                    .with("ref", reference.clone())
                                    .with("detail", "unknown-builtin")
                            })?
                            .to_string(),
                        None => {
                            let invalid = |detail: String| {
                                Reason::new(FLOW_AGENT_PROMPT_INVALID)
                                    .with("ref", reference.clone())
                                    .with("detail", detail)
                            };
                            let path = load::resolve_in_project(&root, &base_dir, reference)
                                .map_err(|problem| {
                                    invalid(match problem {
                                        load::PathProblem::Outside(why) => why.to_string(),
                                        load::PathProblem::NotFound => "not-found".to_string(),
                                    })
                                })?;
                            let text = std::fs::read_to_string(&path)
                                .map_err(|e| invalid(e.to_string()))?;
                            ctx.render_string(&text).map_err(|r| invalid(r.code))?
                        }
                    },
                    (None, None) => {
                        return Err(Reason::new(FLOW_AGENT_PROMPT_INVALID)
                            .with("detail", "missing"))
                    }
                };
                let builtin = agent.prompt.is_none()
                    && agent
                        .prompt_ref
                        .as_deref()
                        .is_some_and(|r| r.starts_with("builtin:"));
                let working_dir = resolve_working_dir(
                    ctx,
                    &root,
                    agent.working_dir.as_deref().or(default_dir.as_deref()),
                    |template| {
                        Reason::new(FLOW_AGENT_PROMPT_INVALID)
                            .with("detail", "working-dir-empty")
                            .with("workingDir", template)
                    },
                )?;
                Ok((provider, inputs, instructions, builtin, working_dir))
            })?;
        std::fs::write(
            dir.join("inputs.json"),
            serde_json::to_vec_pretty(&inputs).unwrap_or_default(),
        )
        .map_err(|e| io_failed(e.to_string()))?;
        let prompt = prompts::compose(&instructions, &inputs, agent.output_contract, previous);
        std::fs::write(dir.join("prompt.md"), &prompt).map_err(|e| io_failed(e.to_string()))?;
        // Built-in prompts are trusted; everything else may carry injected text.
        let screening = screening_text(&inputs, (!builtin).then_some(instructions.as_str()));
        Ok(PreparedAgent {
            dir,
            provider,
            prompt,
            working_dir,
            screening,
        })
    }

    /// Starts the turn of a prepared attempt and tracks it.
    fn start_agent_turn(
        &mut self,
        prefix: &str,
        key: &str,
        node: &FlowNode,
        agent: &AgentNode,
        attempt: u32,
        prepared: PreparedAgent,
    ) {
        let timeout = self.node_timeout(prefix, node);
        let working_dir = prepared.working_dir.clone();
        let Ok(baseline) = self.take_integrity_baseline(key, attempt, agent) else {
            return;
        };
        let request = AgentTurnRequest {
            session_id: format!("flow-{}-{}-{attempt}", self.run_id, node_dir_name(key)),
            provider: prepared.provider,
            model: agent.model.clone(),
            permission: agent.permission,
            working_dir: prepared.working_dir,
            prompt: prepared.prompt,
            timeout,
        };
        let handle = match self.env.agent_runner.start(request) {
            Ok(handle) => handle,
            Err(message) => {
                return self.fail_node(
                    key,
                    attempt,
                    Reason::new(FLOW_AGENT_START_FAILED).with("message", message),
                )
            }
        };
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(prepared.dir.join("stdout.log"))
            .ok();
        self.agents.push(RunningAgent {
            key: key.to_string(),
            attempt,
            dir: prepared.dir,
            handle,
            contract: agent.output_contract,
            log,
            items: ItemState::default(),
            started: Instant::now(),
            timeout,
            grace_deadline: None,
            cancel_sent: false,
            timed_out: false,
            violation: None,
            estimate_usd: node.cost.as_ref().and_then(|c| c.estimate_usd),
            working_dir,
            baseline,
        });
        self.emit(
            Some(key),
            EventBody::NodeProgress {
                text: "agent turn".into(),
                fraction: None,
            },
        );
    }

    /// Snapshots the project repo before a `full-access` turn. Not a git
    /// repo: warns and skips the check. A failed snapshot fails the node,
    /// since the turn could not be verified afterwards (`Err`).
    fn take_integrity_baseline(
        &mut self,
        key: &str,
        attempt: u32,
        agent: &AgentNode,
    ) -> Result<Option<IntegritySnapshot>, ()> {
        if agent.permission != AgentPermission::FullAccess {
            return Ok(None);
        }
        let root = self.store.project_root().to_path_buf();
        if !gitops::is_git_repo(&root) {
            self.emit(
                Some(key),
                EventBody::Warning(Reason::new(FLOW_AGENT_INTEGRITY_SKIPPED)),
            );
            return Ok(None);
        }
        match integrity::snapshot(&root, None) {
            Ok(snapshot) => Ok(Some(snapshot)),
            Err(err) => {
                self.fail_node(key, attempt, integrity_snapshot_failed(&err));
                Err(())
            }
        }
    }

    /// Compares the repo with the turn's baseline: the
    /// `FLOW_AGENT_INTEGRITY_CHANGED` reason on any change (or a failed
    /// snapshot), `None` when nothing changed or nothing was snapshotted.
    fn integrity_violation(&self, agent: &RunningAgent) -> Option<Reason> {
        let before = agent.baseline.as_ref()?;
        Some(match integrity::snapshot(self.store.project_root(), None) {
            Ok(after) => {
                let changes = integrity::compare(before, &after);
                if changes.is_empty() {
                    return None;
                }
                let detail = changes
                    .iter()
                    .filter(|c| !c.detail.is_empty())
                    .map(|c| format!("{}: {}", c.code, c.detail))
                    .collect::<Vec<_>>()
                    .join("; ");
                let codes: Vec<Value> = changes.into_iter().map(|c| Value::String(c.code)).collect();
                Reason::new(FLOW_AGENT_INTEGRITY_CHANGED)
                    .with("changes", Value::Array(codes))
                    .with("detail", detail)
            }
            Err(err) => integrity_snapshot_failed(&err),
        })
    }

    /// The post-turn integrity check of a turn removed without settling
    /// (cancel, app exit, a new pass): any change is reported as a warning.
    /// Best-effort: a failed snapshot is itself only a warning.
    pub(super) fn warn_integrity(&mut self, agent: &RunningAgent) {
        if let Some(violation) = self.integrity_violation(agent) {
            self.emit(Some(&agent.key), EventBody::Warning(violation));
        }
    }

    /// Drains every turn's events and settles the turns that ended.
    pub(super) fn poll_agents(&mut self) {
        let mut agents = std::mem::take(&mut self.agents);
        let mut finished = Vec::new();
        let mut i = 0;
        while i < agents.len() {
            match self.poll_agent(&mut agents[i]) {
                Some(finish) => finished.push((agents.remove(i), finish)),
                None => i += 1,
            }
        }
        self.agents = agents;
        for (agent, finish) in finished {
            self.finish_agent(agent, finish);
        }
    }

    fn poll_agent(&mut self, agent: &mut RunningAgent) -> Option<AgentFinish> {
        while let Some(event) = agent.handle.try_recv() {
            match event {
                AgentTurnEvent::Log(line) => {
                    if let Some(file) = agent.log.as_mut() {
                        let _ = writeln!(file, "{line}");
                    }
                }
                AgentTurnEvent::Progress(text) => {
                    let key = agent.key.clone();
                    self.apply_item(
                        &key,
                        ProtocolItem::Progress {
                            text,
                            fraction: None,
                        },
                        &mut agent.items,
                        &agent.dir,
                    );
                }
                AgentTurnEvent::GuardViolation { rule, summary } => {
                    if agent.violation.is_none() {
                        agent.violation = Some((rule, summary));
                    }
                }
                end => return Some(AgentFinish::Turn(end)),
            }
        }
        if agent.grace_deadline.is_some_and(|d| Instant::now() >= d) {
            // The turn did not end in time; its thread closes the session.
            agent.handle.cancel();
            return Some(if agent.timed_out {
                AgentFinish::Turn(AgentTurnEvent::Cancelled)
            } else {
                AgentFinish::GraceKilled
            });
        }
        if !agent.cancel_sent && agent.timeout.is_some_and(|t| agent.started.elapsed() >= t) {
            agent.handle.cancel();
            agent.cancel_sent = true;
            agent.timed_out = true;
            let deadline =
                Instant::now() + self.stop_grace().unwrap_or(DEFAULT_CANCEL_GRACE);
            agent.grace_deadline = Some(agent.grace_deadline.map_or(deadline, |d| d.min(deadline)));
        }
        None
    }

    /// Settles an agent node from how its turn ended.
    fn finish_agent(&mut self, mut agent: RunningAgent, finish: AgentFinish) {
        let key = agent.key.clone();
        let attempt = agent.attempt;
        self.flush_progress(&key, &mut agent.items);
        agent.log = None;
        if let AgentFinish::Turn(AgentTurnEvent::Completed { final_response, .. }) = &finish {
            if let Err(err) = std::fs::write(agent.dir.join("response.md"), final_response) {
                append_line(
                    &agent.dir.join("stdout.log"),
                    &format!("[mdium] response.md: {err}"),
                );
            }
        }
        // A reported cost replaces the node's estimate; without one the
        // estimate stands in for every end of the turn.
        let reported = match &finish {
            AgentFinish::Turn(AgentTurnEvent::Completed { cost_usd, .. }) => *cost_usd,
            _ => None,
        };
        let cost = match reported {
            Some(usd) => Some((usd, CostKind::Actual)),
            None => agent.estimate_usd.map(|usd| (usd, CostKind::Estimated)),
        };
        if let Some((usd, kind)) = cost {
            self.emit(
                Some(&key),
                EventBody::Cost {
                    usd,
                    kind,
                    provider: None,
                    model: None,
                    units: None,
                },
            );
        }
        // The post-turn check runs after every end of a `full-access` turn.
        // Only a completed turn fails for it; any other end keeps its own
        // reason and reports the changes as a warning.
        if let Some(violation) = self.integrity_violation(&agent) {
            let completed = !agent.timed_out
                && matches!(
                    finish,
                    AgentFinish::Turn(AgentTurnEvent::Completed { .. })
                );
            if completed {
                return self.fail_node(&key, attempt, violation);
            }
            self.emit(Some(&key), EventBody::Warning(violation));
        }
        let end = match finish {
            AgentFinish::GraceKilled => {
                self.set_node(
                    &key,
                    NodeStatus::Ready,
                    attempt,
                    Some(Reason::new(FLOW_STOP_GRACE_EXCEEDED)),
                    None,
                );
                return;
            }
            AgentFinish::Turn(end) => end,
        };
        if agent.timed_out {
            return self.after_failure(&key, attempt, Reason::new(FLOW_NODE_TIMEOUT), true);
        }
        match end {
            AgentTurnEvent::Completed { final_response, .. } => {
                self.agent_completed(&agent, final_response)
            }
            AgentTurnEvent::Failed { code, message } => match agent.violation.take() {
                Some((rule, summary)) => self.fail_node(
                    &key,
                    attempt,
                    Reason::new(FLOW_AGENT_GUARD_BLOCKED)
                        .with("rule", rule)
                        .with("summary", summary),
                ),
                None => self.after_failure(
                    &key,
                    attempt,
                    Reason::new(FLOW_AGENT_TURN_FAILED)
                        .with("code", code)
                        .with("message", message),
                    false,
                ),
            },
            AgentTurnEvent::Cancelled if self.cancel_requested => {
                self.set_node(
                    &key,
                    NodeStatus::Cancelled,
                    attempt,
                    Some(Reason::new(FLOW_RUN_CANCELLED)),
                    None,
                );
            }
            // Stopped: the node runs again on resume.
            AgentTurnEvent::Cancelled if self.stop_requested => {
                self.set_node(
                    &key,
                    NodeStatus::Ready,
                    attempt,
                    Some(Reason::new(FLOW_NODE_STOPPED)),
                    None,
                );
            }
            // Nobody asked for this cancel: the turn did not do its work.
            AgentTurnEvent::Cancelled => self.after_failure(
                &key,
                attempt,
                Reason::new(FLOW_AGENT_TURN_FAILED).with("code", "RUNNER_TURN_CANCELLED"),
                false,
            ),
            AgentTurnEvent::Exited => {
                self.after_failure(&key, attempt, Reason::new(FLOW_AGENT_RUNNER_EXITED), false)
            }
            // Not end events; `poll_agent` never finishes on them.
            AgentTurnEvent::Log(_)
            | AgentTurnEvent::Progress(_)
            | AgentTurnEvent::GuardViolation { .. } => {}
        }
    }

    /// Maps a completed turn's response to outputs, artifacts and a port.
    fn agent_completed(&mut self, agent: &RunningAgent, response: String) {
        let key = agent.key.as_str();
        let attempt = agent.attempt;
        if agent.contract == OutputContract::Free {
            self.emit(
                Some(key),
                EventBody::NodeOutput {
                    key: "response".into(),
                    value: Value::String(response),
                },
            );
            self.write_outputs(key, &agent.dir);
            return self.settle(key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None);
        }
        let outcome = match parse_outcome(&response) {
            Ok(outcome) => outcome,
            Err(err) => {
                return self.fail_node(
                    key,
                    attempt,
                    Reason::new(FLOW_AGENT_OUTPUT_INVALID)
                        .with("detail", err.code())
                        .with("message", err.to_string()),
                )
            }
        };
        let reason = outcome.reason.clone().unwrap_or_default();
        let body = outcome.body.clone();
        // `body` and `reason` are the node's own outputs; declared ones never replace them.
        for (name, value) in outcome.outputs {
            if name != "body" && name != "reason" {
                self.emit(Some(key), EventBody::NodeOutput { key: name, value });
            }
        }
        self.emit(
            Some(key),
            EventBody::NodeOutput {
                key: "body".into(),
                value: Value::String(outcome.body),
            },
        );
        self.emit(
            Some(key),
            EventBody::NodeOutput {
                key: "reason".into(),
                value: Value::String(reason.clone()),
            },
        );
        for path in outcome.artifacts {
            // The agent writes files in its working directory, so relative
            // paths resolve there (not in the attempt dir, as for commands).
            let path = if Path::new(&path).is_relative() && !path.trim().is_empty() {
                agent.working_dir.join(&path).to_string_lossy().into_owned()
            } else {
                path
            };
            self.record_artifact(key, &agent.dir, path, None, None);
        }
        self.write_outputs(key, &agent.dir);
        match outcome.kind {
            StageOutcomeKind::Completed => {
                self.settle(key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None)
            }
            StageOutcomeKind::Attention => {
                let (prefix, id, _) = split_key(key);
                let routed = self
                    .graph_of(prefix)
                    .is_some_and(|g| g.has_edge_from(id, PORT_ATTENTION));
                if routed {
                    self.settle(key, attempt, NodeStatus::Succeeded, PORT_ATTENTION, None)
                } else {
                    self.fail_node(
                        key,
                        attempt,
                        Reason::new(FLOW_AGENT_ATTENTION).with("reason", reason),
                    )
                }
            }
            StageOutcomeKind::AwaitingUser => {
                let question = outcome.question.clone().unwrap_or(reason);
                self.request_agent_question(key, attempt, question, body)
            }
        }
    }
}

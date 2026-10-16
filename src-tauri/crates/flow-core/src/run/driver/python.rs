//! Driver: `python` nodes and the resident workers they run on, one per
//! (runtime, root), including the worker protocol.

use super::*;

pub(super) struct LiveWorker {
    /// Distinguishes a restarted worker of the same runtime.
    pub(super) id: u64,
    pub(super) runtime: String,
    pub(super) handle: Box<dyn WorkerHandle>,
    pub(super) manifest: Manifest,
    pub(super) next_request: u64,
    pub(super) stdout_log: PathBuf,
    /// Its stdout closed (`WorkerEvent::Exited`).
    pub(super) eof: bool,
    /// The exit code, once `try_wait` reported one.
    pub(super) exit_code: Option<i32>,
    /// Ticks since it was seen exiting (bounded wait for the exit code).
    pub(super) dying_ticks: u32,
}

/// A stage call in flight on a worker.
pub(super) struct RunningCall {
    pub(super) key: String,
    pub(super) attempt: u32,
    pub(super) dir: PathBuf,
    pub(super) runtime: String,
    /// The working root of the call's scope (the worker's root).
    pub(super) root: PathBuf,
    /// `LiveWorker::id` of the worker the call was sent to.
    pub(super) worker: u64,
    /// The stage called (`entry` of the node).
    pub(super) entry: String,
    pub(super) call_id: String,
    pub(super) request_id: String,
    pub(super) items: ItemState,
    pub(super) started: Instant,
    pub(super) timeout: Option<Duration>,
    pub(super) grace_deadline: Option<Instant>,
    pub(super) cancel_sent: bool,
    /// The timeout's `cancel` was sent: any ending counts as a timeout.
    pub(super) timed_out: bool,
    pub(super) lines: usize,
    pub(super) limit_warned: bool,
    /// `events.jsonl`, open for appending.
    pub(super) events: Option<std::fs::File>,
    /// The `code` of an `error` answering the call request.
    pub(super) error_code: Option<String>,
    /// Outputs the stage declares (others are accepted with a warning).
    pub(super) declared_outputs: BTreeSet<String>,
}

impl RunningCall {
    /// The key of the worker the call runs on.
    pub(super) fn worker_key(&self) -> WorkerKey {
        (self.runtime.clone(), self.root.clone())
    }

    fn is_on(&self, worker_key: &WorkerKey) -> bool {
        self.runtime == worker_key.0 && self.root == worker_key.1
    }
}

/// Why a runtime's worker did not become ready.
pub(super) enum WorkerStartError {
    /// `FLOW_RUNTIME_START_FAILED` (or a resolution failure).
    Failed(Reason),
    /// A cancel or app exit arrived while it started; it was killed.
    Aborted,
}

/// The reason of a call that failed: its `outcome` (`FLOW_NODE_FAILED`) or
/// an `error` the worker answered with. Other worker codes than the input
/// and entry ones become `FLOW_PYTHON_PROTOCOL` with the worker's code in
/// `code`, so every reason has a translation.
fn call_failure_reason(error_code: Option<&str>, detail: Option<String>, entry: &str) -> Reason {
    let mut reason = match error_code {
        None => Reason::new(FLOW_NODE_FAILED),
        Some(code @ (FLOW_PYTHON_INPUT_INVALID | FLOW_PYTHON_ENTRY_UNKNOWN)) => {
            Reason::new(code).with("entry", entry)
        }
        Some(code) => Reason::new(FLOW_PYTHON_PROTOCOL).with("code", code),
    };
    if let Some(detail) = detail {
        reason = reason.with("detail", detail);
    }
    reason
}

impl Driver {
    // ------------------------------------------------------- python nodes

    /// Starts a stage call on the runtime's resident worker (spec 3.1–3.4).
    pub(super) fn launch_call(
        &mut self,
        prefix: &str,
        key: &str,
        node: &FlowNode,
        py: &PythonNode,
        attempt: u32,
    ) {
        let runtime = py.runtime.clone();
        let Some(def) = self
            .meta
            .project
            .as_ref()
            .and_then(|p| p.runtimes.get(&runtime))
            .cloned()
        else {
            // Validation normally prevents this.
            return self.fail_node(
                key,
                attempt,
                Reason::new(FLOW_RUNTIME_UNKNOWN).with("runtime", runtime),
            );
        };
        let worker_key: WorkerKey = (runtime.clone(), self.scope_root(prefix));
        if let Err(err) = self.ensure_worker(&worker_key, &def) {
            return self.worker_start_error(key, attempt, err);
        }
        if !self.still_starting(key, attempt) {
            return;
        }
        let Some(stage) = self
            .workers
            .get(&worker_key)
            .and_then(|w| w.manifest.stage(&py.entry))
            .cloned()
        else {
            return self.fail_node(
                key,
                attempt,
                Reason::new(FLOW_PYTHON_ENTRY_UNKNOWN)
                    .with("runtime", runtime)
                    .with("entry", py.entry.clone()),
            );
        };
        let io_failed =
            |message: String| Reason::new(FLOW_COMMAND_SPAWN_FAILED).with("message", message);
        let dir = match self
            .store
            .node_attempt_dir(&self.run_id, key, attempt)
            .map_err(|e| e.to_string())
            .and_then(|dir| {
                std::fs::create_dir_all(&dir)
                    .map(|_| dir)
                    .map_err(|e| e.to_string())
            }) {
            Ok(dir) => dir,
            Err(message) => return self.fail_node(key, attempt, io_failed(message)),
        };
        let rendered = self.with_ctx(prefix, None, Some(&dir), None, |ctx| {
            ctx.render_json(&Value::Object(py.with_args.clone().into_iter().collect()))
        });
        let given = match rendered {
            Ok(Value::Object(given)) => given,
            Ok(_) => {
                return self.fail_node(
                    key,
                    attempt,
                    Reason::new(FLOW_PYTHON_INPUT_INVALID).with("reason", "not-an-object"),
                )
            }
            Err(reason) => return self.fail_node(key, attempt, reason),
        };
        let inputs_file = dir.join("inputs.json");
        let inputs = match validate_inputs(&stage, &given) {
            Ok(inputs) => inputs,
            Err(errors) => {
                // Fails before the call: the worker stays alive (Review Focus 5).
                let _ = std::fs::write(&inputs_file, Value::Object(given).to_string());
                let details = serde_json::to_value(&errors).unwrap_or(Value::Null);
                let reason = errors
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| Reason::new(FLOW_PYTHON_INPUT_INVALID))
                    .with("details", details);
                return self.fail_node(key, attempt, reason);
            }
        };
        let prepared = std::fs::write(&inputs_file, Value::Object(inputs.clone()).to_string())
            .and_then(|_| std::fs::File::create(dir.join("events.jsonl")).map(|_| ()))
            .and_then(|_| std::fs::File::create(dir.join("stdout.log")).map(|_| ()));
        if let Err(err) = prepared {
            return self.fail_node(key, attempt, io_failed(err.to_string()));
        }
        let call_id = format!("{key}#{attempt}");
        let context = CallContext {
            run_id: self.run_id.clone(),
            node_key: key.to_string(),
            node_dir: dir.to_string_lossy().into_owned(),
            project_root: worker_key.1.to_string_lossy().into_owned(),
            stop_file: self
                .store
                .stop_file(&self.run_id)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            attempt,
        };
        let timeout = self.node_timeout(prefix, node);
        // A worker that died between ticks fails the send: retry once on a
        // fresh worker (spec 3.2) before failing the node.
        let mut retried = false;
        let (worker_id, request_id) = loop {
            let Some(worker) = self.workers.get_mut(&worker_key) else {
                return self.fail_node(
                    key,
                    attempt,
                    Reason::new(FLOW_PYTHON_WORKER_EXITED).with("runtime", runtime),
                );
            };
            let worker_id = worker.id;
            let request_id = worker.next_request.to_string();
            worker.next_request += 1;
            let request = call_request(&request_id, &call_id, &py.entry, &inputs, &context);
            let err = match worker.handle.send(&request) {
                Ok(()) => break (worker_id, request_id),
                Err(err) => err,
            };
            self.drop_worker(&worker_key, worker_id);
            if retried {
                return self.fail_node(
                    key,
                    attempt,
                    Reason::new(FLOW_PYTHON_WORKER_EXITED)
                        .with("runtime", runtime)
                        .with("message", err.to_string()),
                );
            }
            retried = true;
            if let Err(err) = self.ensure_worker(&worker_key, &def) {
                return self.worker_start_error(key, attempt, err);
            }
            if !self.still_starting(key, attempt) {
                return;
            }
        };
        let events = std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join("events.jsonl"))
            .ok();
        self.calls.push(RunningCall {
            key: key.to_string(),
            attempt,
            dir,
            runtime,
            root: worker_key.1,
            worker: worker_id,
            entry: py.entry.clone(),
            call_id,
            request_id,
            items: ItemState::default(),
            started: Instant::now(),
            timeout,
            grace_deadline: None,
            cancel_sent: false,
            timed_out: false,
            lines: 0,
            limit_warned: false,
            events,
            error_code: None,
            declared_outputs: stage.outputs.keys().cloned().collect(),
        });
    }

    /// The node is still `running` at `attempt` after a worker start. While
    /// a worker starts, `await_manifest` applies controls (an approval may
    /// open a new pass and retire this instance); then the call is dropped.
    fn still_starting(&self, key: &str, attempt: u32) -> bool {
        let node = self.node(key);
        node.status == NodeStatus::Running && node.attempt == attempt
    }

    /// Ends a node whose worker did not start: failed, or (when a cancel or
    /// app exit interrupted the start) cancelled / interrupted like a
    /// running node.
    fn worker_start_error(&mut self, key: &str, attempt: u32, err: WorkerStartError) {
        if !self.still_starting(key, attempt) {
            return;
        }
        match err {
            WorkerStartError::Failed(reason) => self.fail_node(key, attempt, reason),
            WorkerStartError::Aborted if self.shutdown_requested => {
                self.set_node(
                    key,
                    NodeStatus::Interrupted,
                    attempt,
                    Some(Reason::new(FLOW_APP_EXITED)),
                    None,
                );
                self.set_run(RunStatus::Interrupted, Some(Reason::new(FLOW_APP_EXITED)));
            }
            // `cancel_all` (next loop turn) ends the run.
            WorkerStartError::Aborted => {
                self.set_node(
                    key,
                    NodeStatus::Cancelled,
                    attempt,
                    Some(Reason::new(FLOW_RUN_CANCELLED)),
                    None,
                );
            }
        }
    }

    /// Starts the worker of a runtime and working root unless it runs, and
    /// waits (blocking, but watching for cancel and app exit) for its
    /// manifest. The runtime's `python` and `cwd` resolve against the root.
    fn ensure_worker(&mut self, worker_key: &WorkerKey, def: &RuntimeDef) -> Result<(), WorkerStartError> {
        let (runtime, root) = (worker_key.0.as_str(), worker_key.1.as_path());
        match self.workers.get(worker_key) {
            Some(w) if !w.eof && w.exit_code.is_none() => return Ok(()),
            Some(_) => {
                // Exiting: start a fresh one (its calls end as orphans).
                if let Some(mut dying) = self.workers.remove(worker_key) {
                    if dying.exit_code.is_none() {
                        dying.handle.kill_tree();
                    }
                }
            }
            None => {}
        }
        let start_failed = |message: String| {
            Reason::new(FLOW_RUNTIME_START_FAILED)
                .with("runtime", runtime)
                .with("message", message)
        };
        let failed = |message: String| WorkerStartError::Failed(start_failed(message));
        let stop_file = self
            .store
            .stop_file(&self.run_id)
            .map_err(|e| failed(e.to_string()))?;
        let extra_env = [
            ("MDIUM_FLOW_RUN_ID".to_string(), self.run_id.clone()),
            (
                "MDIUM_FLOW_STOP_FILE".to_string(),
                stop_file.to_string_lossy().into_owned(),
            ),
        ];
        let mut spec = worker_spec(root, runtime, def, &self.run_dir(), &extra_env)
            .map_err(WorkerStartError::Failed)?;
        if root != self.store.project_root() {
            // A worker of another root keeps its own logs.
            let digest = sha256_hex(root.to_string_lossy().as_bytes());
            let logs = self
                .run_dir()
                .join("runtimes")
                .join(format!("{runtime}@{}", &digest[..8]));
            std::fs::create_dir_all(&logs).map_err(|e| failed(e.to_string()))?;
            spec.stderr = logs.join("stderr.log");
            spec.stdout_log = logs.join("stdout.log");
        }
        let mut handle = self
            .env
            .worker_launcher
            .launch(&spec)
            .map_err(|e| failed(e.to_string()))?;
        match self.await_manifest(handle.as_mut(), &spec.stdout_log) {
            Ok(manifest) => {
                self.worker_seq += 1;
                self.workers.insert(
                    worker_key.clone(),
                    LiveWorker {
                        id: self.worker_seq,
                        runtime: runtime.to_string(),
                        handle,
                        manifest,
                        next_request: 2,
                        stdout_log: spec.stdout_log,
                        eof: false,
                        exit_code: None,
                        dying_ticks: 0,
                    },
                );
                Ok(())
            }
            Err(None) => {
                handle.kill_tree();
                Err(WorkerStartError::Aborted)
            }
            Err(Some(message)) => {
                handle.kill_tree();
                // Read once the worker is gone: the cause usually is in its stderr.
                Err(WorkerStartError::Failed(with_stderr_tail(
                    start_failed(message),
                    &spec.stderr,
                )))
            }
        }
    }

    /// Sends `describe` (request id `1`) and waits for the manifest; other
    /// output meanwhile goes to the worker's stdout log. `Err(None)` when a
    /// cancel or app exit arrived meanwhile (M5), `Err(Some(message))` when
    /// the worker failed to start.
    fn await_manifest(
        &mut self,
        handle: &mut dyn WorkerHandle,
        stdout_log: &Path,
    ) -> Result<Manifest, Option<String>> {
        handle
            .send(&describe_request("1"))
            .map_err(|e| Some(e.to_string()))?;
        let deadline = Instant::now() + WORKER_READY_TIMEOUT;
        let pause = self.env.poll.max(Duration::from_millis(5));
        let mut next_controls = Instant::now();
        loop {
            // Checked on every iteration: a worker that keeps printing must
            // not defeat the cap or hold up a cancel.
            let now = Instant::now();
            if now >= deadline {
                return Err(Some("timed out waiting for the manifest".to_string()));
            }
            if now >= next_controls {
                next_controls = now + pause;
                self.drain_controls();
                if self.shutdown_requested || self.cancel_requested {
                    return Err(None);
                }
            }
            match handle.try_recv() {
                Some(WorkerEvent::Line(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match parse_worker_line(&line) {
                        WorkerMessage::Manifest {
                            request_id,
                            manifest,
                        } if request_id == "1" => return Ok(manifest),
                        WorkerMessage::BadManifest { request_id, error }
                            if request_id.as_deref().is_none_or(|id| id == "1") =>
                        {
                            return Err(Some(bad_manifest_message(&error)))
                        }
                        WorkerMessage::Error { message, .. } => return Err(Some(message)),
                        WorkerMessage::Log { level, text, .. } => {
                            append_line(stdout_log, &format!("[{level}] {text}"))
                        }
                        _ => append_line(stdout_log, &line),
                    }
                }
                // An over-long line still counts when it answers `describe`
                // (a large manifest, or an error, bounded); otherwise dropped.
                Some(WorkerEvent::OverLong(line)) => match parse_worker_line(&line) {
                    WorkerMessage::Manifest {
                        request_id,
                        manifest,
                    } if request_id == "1" => return Ok(manifest),
                    WorkerMessage::BadManifest { request_id, error }
                        if request_id.as_deref().is_none_or(|id| id == "1") =>
                    {
                        return Err(Some(bad_manifest_message(&error)))
                    }
                    WorkerMessage::Error { message, .. } => {
                        return Err(Some(truncate_text(&message, MAX_OVER_LONG_TEXT)))
                    }
                    _ => {}
                },
                Some(WorkerEvent::TooLong) => {}
                Some(WorkerEvent::Exited(_)) => return Err(Some(exited_before_describe(handle))),
                None => std::thread::sleep(pause),
            }
        }
    }

    /// Kills a runtime's worker and forgets it (its calls end next tick) —
    /// only while it still is worker `id`, never a restarted one.
    pub(super) fn drop_worker(&mut self, worker_key: &WorkerKey, id: u64) {
        if self.workers.get(worker_key).is_some_and(|w| w.id == id) {
            if let Some(mut worker) = self.workers.remove(worker_key) {
                worker.handle.kill_tree();
            }
        }
    }

    pub(super) fn kill_workers(&mut self) {
        for (_, mut worker) in std::mem::take(&mut self.workers) {
            worker.handle.kill_tree();
        }
    }

    /// Run end: asks every worker to exit, then kills the ones that did not.
    pub(super) fn shutdown_workers(&mut self) {
        let mut pending: Vec<LiveWorker> =
            std::mem::take(&mut self.workers).into_values().collect();
        for worker in &mut pending {
            let _ = worker.handle.send(&shutdown_request());
        }
        let deadline = Instant::now() + self.stop_grace().unwrap_or(WORKER_SHUTDOWN_GRACE);
        let pause = self.env.poll.max(Duration::from_millis(5));
        loop {
            pending.retain_mut(|w| !matches!(w.handle.try_wait(), Ok(Some(_))));
            if pending.is_empty() || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(pause);
        }
        for worker in &mut pending {
            eprintln!(
                "[flow] worker of runtime {} did not exit after shutdown; killing it",
                worker.runtime
            );
            worker.handle.kill_tree();
        }
    }

    /// Drains every worker's output, then settles calls that ended, kills
    /// workers whose grace passed and sends `cancel` on timeouts.
    pub(super) fn poll_calls(&mut self) {
        let workers: Vec<(WorkerKey, u64)> = self
            .workers
            .iter()
            .map(|(worker_key, w)| (worker_key.clone(), w.id))
            .collect();
        let mut exited: BTreeMap<u64, Option<i32>> = BTreeMap::new();
        for (worker_key, id) in workers {
            if let Some(code) = self.poll_worker(&worker_key) {
                exited.insert(id, code);
            }
        }
        let cancel_grace = self.stop_grace().unwrap_or(DEFAULT_CANCEL_GRACE);
        let mut calls = std::mem::take(&mut self.calls);
        let mut finished = Vec::new();
        let mut i = 0;
        while i < calls.len() {
            let call = &mut calls[i];
            let finish = if call.items.outcome.is_some() {
                // An outcome after the timeout's `cancel` still is a timeout.
                Some(if call.timed_out {
                    Finish::Timeout
                } else {
                    Finish::Exited(0)
                })
            } else if !self.worker_alive(call) {
                Some(if call.timed_out {
                    Finish::Timeout
                } else {
                    Finish::WorkerExited(exited.get(&call.worker).copied().flatten())
                })
            } else if call.grace_deadline.is_some_and(|d| Instant::now() >= d) {
                self.drop_worker(&call.worker_key(), call.worker);
                Some(if call.timed_out {
                    Finish::Timeout
                } else {
                    Finish::GraceKilled
                })
            } else {
                if !call.cancel_sent && call.timeout.is_some_and(|t| call.started.elapsed() >= t) {
                    if let Some(worker) = self.workers.get_mut(&call.worker_key()) {
                        // A failed send shows up as the worker's exit.
                        let _ = worker.handle.send(&cancel_request(&call.call_id));
                    }
                    call.cancel_sent = true;
                    call.timed_out = true;
                    let deadline = Instant::now() + cancel_grace;
                    call.grace_deadline =
                        Some(call.grace_deadline.map_or(deadline, |d| d.min(deadline)));
                }
                None
            };
            match finish {
                Some(finish) => finished.push((calls.remove(i), finish)),
                None => i += 1,
            }
        }
        self.calls = calls;
        for (call, finish) in finished {
            self.finish_call(call, finish);
        }
    }

    /// The worker the call was sent to still runs.
    fn worker_alive(&self, call: &RunningCall) -> bool {
        self.workers
            .get(&call.worker_key())
            .is_some_and(|w| w.id == call.worker)
    }

    /// Handles a worker's pending output. Returns `Some(exit code)` once the
    /// worker is gone (it is then removed).
    fn poll_worker(&mut self, worker_key: &WorkerKey) -> Option<Option<i32>> {
        let mut events = Vec::new();
        {
            let worker = self.workers.get_mut(worker_key)?;
            while let Some(event) = worker.handle.try_recv() {
                events.push(event);
            }
        }
        for event in events {
            match event {
                WorkerEvent::Line(line) => self.worker_line(worker_key, &line),
                WorkerEvent::TooLong => self.worker_line_too_long(worker_key),
                // Dropped like any over-long line, unless it ends a call:
                // then it is applied with its text bounded.
                WorkerEvent::OverLong(line) => match bound_over_long_line(&line) {
                    Some(bounded) => self.worker_line(worker_key, &bounded),
                    None => self.worker_line_too_long(worker_key),
                },
                WorkerEvent::Exited(code) => {
                    if let Some(worker) = self.workers.get_mut(worker_key) {
                        worker.eof = true;
                        worker.exit_code = worker.exit_code.or(code);
                    }
                }
            }
        }
        let worker = self.workers.get_mut(worker_key)?;
        if worker.exit_code.is_none() {
            match worker.handle.try_wait() {
                Ok(code) => worker.exit_code = code,
                Err(_) => worker.eof = true,
            }
        }
        if !worker.eof && worker.exit_code.is_none() {
            return None;
        }
        // Exiting: wait a few ticks for the rest of its output and its exit
        // code, never blocking.
        worker.dying_ticks += 1;
        if !(worker.eof && worker.exit_code.is_some()) && worker.dying_ticks <= WORKER_EXIT_TICKS {
            return None;
        }
        let mut worker = self.workers.remove(worker_key)?;
        let code = worker.exit_code;
        if code.is_none() {
            // Still running as far as we know (its stdout closed): end it.
            worker.handle.kill_tree();
        }
        Some(code)
    }

    /// One line of a worker's stdout (spec 3.3).
    fn worker_line(&mut self, worker_key: &WorkerKey, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        let Some((stdout_log, worker)) = self
            .workers
            .get(worker_key)
            .map(|w| (w.stdout_log.clone(), w.id))
        else {
            return;
        };
        let mine = |c: &RunningCall| c.is_on(worker_key) && c.worker == worker;
        // The call in flight on this worker (one that has no outcome yet).
        let active = self.active_call(worker_key);
        let find =
            |calls: &[RunningCall], id: &str| calls.iter().position(|c| mine(c) && c.call_id == id);
        let message = match parse_worker_line(line) {
            // Only `describe` expects a manifest; here it is stray output.
            WorkerMessage::BadManifest { .. } => WorkerMessage::Invalid {
                reason: "bad-manifest",
            },
            message => message,
        };
        match message {
            WorkerMessage::Item {
                call_id,
                item,
                line: clean,
            } => {
                let known = call_id.as_deref().and_then(|id| find(&self.calls, id));
                match known.filter(|&i| self.calls[i].items.outcome.is_none()) {
                    Some(idx) => self.call_item(idx, item, &clean),
                    None => {
                        let key = known.or(active).map(|i| self.calls[i].key.clone());
                        self.protocol_warning(key.as_deref(), "unexpected-call-id", Vec::new());
                    }
                }
            }
            WorkerMessage::Log {
                call_id,
                level,
                text,
            } => {
                let text = format!("[{level}] {text}");
                match call_id.as_deref().and_then(|id| find(&self.calls, id)) {
                    // Inside a call: counted, dropped past the limit.
                    Some(idx) => {
                        if self.count_line(idx).is_some() {
                            append_line(&self.calls[idx].dir.join("stdout.log"), &text);
                        }
                    }
                    None => append_line(&stdout_log, &text),
                }
            }
            WorkerMessage::Error {
                request_id,
                code,
                message,
            } => {
                let target = request_id.as_deref().and_then(|id| {
                    self.calls
                        .iter()
                        .position(|c| mine(c) && c.request_id == id && c.items.outcome.is_none())
                });
                match target {
                    Some(idx) => {
                        // Counted like an outcome: it ends the call even
                        // past the limit.
                        let _ = self.count_line(idx);
                        let call = &mut self.calls[idx];
                        call.items.outcome = Some(ProtocolOutcome::Fail(Some(message)));
                        call.error_code = Some(code);
                    }
                    None => append_line(&stdout_log, line),
                }
            }
            // Stray output (e.g. `print`): a warning inside a call (the text
            // goes to the attempt's stdout.log), logged outside.
            WorkerMessage::Invalid { reason } => match active {
                Some(idx) => {
                    if let Some(number) = self.count_line(idx) {
                        let key = self.calls[idx].key.clone();
                        append_line(&self.calls[idx].dir.join("stdout.log"), line);
                        self.protocol_warning(Some(&key), reason, vec![("line", number.into())]);
                    }
                }
                None => append_line(&stdout_log, line),
            },
            WorkerMessage::Manifest { .. } | WorkerMessage::BadManifest { .. } => {}
        }
    }

    /// The call in flight on the runtime's current worker (no outcome yet).
    fn active_call(&self, worker_key: &WorkerKey) -> Option<usize> {
        let worker = self.workers.get(worker_key)?.id;
        self.calls.iter().position(|c| {
            c.is_on(worker_key) && c.worker == worker && c.items.outcome.is_none()
        })
    }

    /// A dropped line: over `MAX_LINE_BYTES_HARD` (the reader discarded it),
    /// or over `MAX_LINE_BYTES` without ending a call. A counted warning
    /// inside a call, ignored outside.
    fn worker_line_too_long(&mut self, worker_key: &WorkerKey) {
        if let Some(idx) = self.active_call(worker_key) {
            if let Some(line) = self.count_line(idx) {
                let key = self.calls[idx].key.clone();
                self.protocol_warning(Some(&key), "line-too-long", vec![("line", line.into())]);
            }
        }
    }

    /// Counts one line of a call against `MAX_LINES`: `Some(line number)`
    /// while within the limit; past it, one `too-many-lines` warning and `None`.
    fn count_line(&mut self, idx: usize) -> Option<usize> {
        let call = &mut self.calls[idx];
        call.lines += 1;
        let line = call.lines;
        if line <= MAX_LINES {
            return Some(line);
        }
        if !call.limit_warned {
            call.limit_warned = true;
            let key = call.key.clone();
            self.protocol_warning(Some(&key), "too-many-lines", vec![("line", line.into())]);
        }
        None
    }

    /// Records and applies one protocol item of a running call. An outcome
    /// is applied even past `MAX_LINES` (only its record is dropped), so the
    /// call always ends. Of the over-long lines only a call-ending `outcome`
    /// gets here, in its bounded form (`bound_over_long_line`).
    fn call_item(&mut self, idx: usize, item: ProtocolItem, clean: &str) {
        let key = self.calls[idx].key.clone();
        let is_outcome = matches!(item, ProtocolItem::Outcome(_));
        let Some(line) = self.count_line(idx) else {
            if is_outcome {
                let mut items = std::mem::take(&mut self.calls[idx].items);
                let dir = self.calls[idx].dir.clone();
                self.apply_item(&key, item, &mut items, &dir);
                self.calls[idx].items = items;
            }
            return;
        };
        let call = &mut self.calls[idx];
        match call.events.as_mut() {
            Some(file) => {
                let _ = writeln!(file, "{clean}");
            }
            None => append_line(&call.dir.join("events.jsonl"), clean),
        }
        if let ProtocolItem::Output { key: name, .. } = &item {
            if !call.declared_outputs.contains(name) {
                let name = name.clone();
                self.protocol_warning(
                    Some(&key),
                    "undeclared-output",
                    vec![("key", name.into()), ("line", line.into())],
                );
            }
        }
        let mut items = std::mem::take(&mut self.calls[idx].items);
        let dir = self.calls[idx].dir.clone();
        self.apply_item(&key, item, &mut items, &dir);
        self.calls[idx].items = items;
    }

    /// Settles a call like a command (spec 3.5).
    fn finish_call(&mut self, mut call: RunningCall, finish: Finish) {
        let key = call.key.clone();
        let attempt = call.attempt;
        self.flush_progress(&key, &mut call.items);
        let _ = std::fs::write(
            call.dir.join("outputs.json"),
            serde_json::to_vec_pretty(&self.node(&key).outputs).unwrap_or_default(),
        );
        let exit_code = match finish {
            Finish::Timeout => {
                return self.after_failure(&key, attempt, Reason::new(FLOW_NODE_TIMEOUT), true)
            }
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
            Finish::Exited(_) => None,
            Finish::WorkerExited(code) => code,
        };
        match call.items.outcome.take() {
            Some(ProtocolOutcome::Ok) => {
                self.settle(&key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None)
            }
            Some(ProtocolOutcome::Fail(detail)) => {
                let reason = call_failure_reason(call.error_code.as_deref(), detail, &call.entry);
                self.after_failure(&key, attempt, reason, false);
            }
            Some(ProtocolOutcome::NeedsApproval(message)) => {
                self.request_node_approval(&key, attempt, message)
            }
            Some(ProtocolOutcome::Stopped) => {
                self.set_node(
                    &key,
                    NodeStatus::Ready,
                    attempt,
                    Some(Reason::new(FLOW_NODE_STOPPED)),
                    None,
                );
            }
            None => {
                let mut reason =
                    Reason::new(FLOW_PYTHON_WORKER_EXITED).with("runtime", call.runtime.clone());
                if let Some(code) = exit_code {
                    reason = reason.with("code", code);
                }
                self.after_failure(&key, attempt, reason, false);
            }
        }
    }

    /// User cancel (spec 3.2): sends `cancel` for every call in flight, then
    /// waits (bounded by `limits.stopGrace`) until each call has its outcome
    /// or its worker is gone. The caller kills what is left.
    pub(super) fn cancel_calls(&mut self) {
        if self.calls.is_empty() {
            return;
        }
        for call in &self.calls {
            if let Some(worker) = self.workers.get_mut(&call.worker_key()) {
                if worker.id == call.worker && call.items.outcome.is_none() {
                    // A failed send shows up as the worker's exit.
                    let _ = worker.handle.send(&cancel_request(&call.call_id));
                }
            }
        }
        let deadline = Instant::now() + self.stop_grace().unwrap_or(DEFAULT_CANCEL_GRACE);
        let pause = self.env.poll.max(Duration::from_millis(5));
        loop {
            let worker_keys: Vec<WorkerKey> = self.workers.keys().cloned().collect();
            for worker_key in worker_keys {
                self.poll_worker(&worker_key);
            }
            let settled = self
                .calls
                .iter()
                .all(|c| c.items.outcome.is_some() || !self.worker_alive(c));
            if settled || Instant::now() >= deadline {
                return;
            }
            std::thread::sleep(pause);
        }
    }
}

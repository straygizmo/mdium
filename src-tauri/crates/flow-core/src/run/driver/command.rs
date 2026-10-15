//! Driver: `command` nodes, their protocol reader, exit decision and
//! detached-process reconnect.

use super::*;

/// A command being monitored.
pub(super) struct RunningCommand {
    pub(super) key: String,
    pub(super) attempt: u32,
    pub(super) dir: PathBuf,
    pub(super) success_codes: Vec<i32>,
    pub(super) handle: Box<dyn ProcessHandle>,
    pub(super) reader: Option<ProtocolReader>,
    pub(super) items: ItemState,
    pub(super) started: Instant,
    pub(super) timeout: Option<Duration>,
    pub(super) grace_deadline: Option<Instant>,
}

impl Driver {
    pub(super) fn launch_command(
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
    pub(super) fn track(
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
            items: ItemState {
                outcome: saved.outcome,
                ..ItemState::default()
            },
            started,
            timeout: self.node_timeout(prefix, node),
            grace_deadline: None,
        });
    }

    /// Polls every running command once and settles the finished ones.
    pub(super) fn poll_running(&mut self) {
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
                    self.apply_item(&key, item, &mut command.items, &command.dir);
                }
                if let Some(reader) = command.reader.as_ref() {
                    ProtocolCursor {
                        offset: reader.committed_offset(),
                        lines: reader.lines(),
                        outcome: command.items.outcome.clone(),
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
                self.apply_item(&key, item, &mut command.items, &command.dir);
            }
        }
        self.flush_progress(&key, &mut command.items);
        let _ = std::fs::write(
            command.dir.join("outputs.json"),
            serde_json::to_vec_pretty(&self.node(&key).outputs).unwrap_or_default(),
        );
        let attempt = command.attempt;
        let result = match finish {
            Finish::Exited(code) => {
                decide(command.items.outcome.as_ref(), code, &command.success_codes)
            }
            // Not produced for commands; treated like an unknown exit code.
            Finish::WorkerExited(code) => decide(
                command.items.outcome.as_ref(),
                code.unwrap_or(-1),
                &command.success_codes,
            ),
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
                self.request_node_approval(&key, attempt, message)
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
        let root = self.scope_root(prefix);
        self.with_ctx(prefix, None, Some(dir), None, |ctx| {
            let argv = match &command.run {
                CommandRun::Argv(argv) => argv
                    .iter()
                    .map(|a| ctx.render_string(a))
                    .collect::<Result<Vec<_>, _>>()?,
                CommandRun::Shell(text) => vec![text.clone()],
            };
            let working_dir = resolve_working_dir(
                ctx,
                &root,
                command
                    .working_dir
                    .as_deref()
                    .or(flow.defaults.working_dir.as_deref()),
                |template| {
                    Reason::new(FLOW_COMMAND_SPAWN_FAILED)
                        .with("message", format!("workingDir {template:?} rendered empty"))
                },
            )?;
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
}

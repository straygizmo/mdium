//! Driver: action.

use super::*;

/// A built-in action running on its own thread.
pub(super) struct RunningAction {
    pub(super) key: String,
    pub(super) attempt: u32,
    /// The built-in action (`mdium/<name>`), named in its approval reason.
    pub(super) uses: String,
    /// Asks the action thread to end early (stop, cancel, exit, new pass).
    pub(super) cancel: Arc<AtomicBool>,
    /// Stop requested: the action must end by then.
    pub(super) grace_deadline: Option<Instant>,
    pub(super) dir: PathBuf,
    /// The action's one end.
    pub(super) rx: Receiver<ActionEnd>,
    /// Progress lines reported by the action.
    pub(super) progress_rx: Receiver<String>,
    pub(super) started: Instant,
    pub(super) timeout: Option<Duration>,
}

/// How an action's monitoring ended.
pub(super) enum ActionFinish {
    End(ActionEnd),
    /// The thread ended without an end (it panicked).
    Lost,
    /// The node's timeout passed (the thread is asked to end and left behind).
    Timeout,
    /// A stop's grace period passed before the action ended.
    GraceKilled,
}

impl Driver {
    // ------------------------------------------------------ action nodes

    /// Starts an `action` node's built-in action on its own thread.
    pub(super) fn launch_action(
        &mut self,
        prefix: &str,
        key: &str,
        node: &FlowNode,
        action: &ActionNode,
        attempt: u32,
    ) {
        // Consumed by this launch whatever happens, so a later attempt is never
        // acknowledged by an earlier approval.
        let acknowledged = self.action_ack.remove(key);
        let io_failed = |message: String| {
            Reason::new(FLOW_ACTION_FAILED)
                .with("code", FLOW_ACTION_IO_FAILED)
                .with("message", message)
        };
        let dir = match self
            .store
            .node_attempt_dir(&self.run_id, key, attempt)
            .map_err(|e| e.to_string())
            .and_then(|dir| std::fs::create_dir_all(&dir).map(|_| dir).map_err(|e| e.to_string()))
        {
            Ok(dir) => dir,
            Err(message) => return self.fail_node(key, attempt, io_failed(message)),
        };
        let rendered = self.with_ctx(prefix, None, Some(&dir), None, |ctx| {
            ctx.render_json(&Value::Object(action.with_args.clone().into_iter().collect()))
        });
        let with: BTreeMap<String, Value> = match rendered {
            Ok(Value::Object(map)) => map.into_iter().collect(),
            Ok(_) => BTreeMap::new(),
            Err(reason) => return self.fail_node(key, attempt, reason),
        };
        if let Err(err) = std::fs::write(
            dir.join("inputs.json"),
            serde_json::to_vec_pretty(&with).unwrap_or_default(),
        ) {
            return self.fail_node(key, attempt, io_failed(err.to_string()));
        }
        let (tx, rx) = mpsc::channel();
        let (progress_tx, progress_rx) = mpsc::channel::<String>();
        let cancel = Arc::new(AtomicBool::new(false));
        let ctx = ActionContext {
            cancel: cancel.clone(),
            project_root: self.scope_root(prefix),
            store_root: self.store.project_root().to_path_buf(),
            run_id: self.run_id.clone(),
            run_dir: self.run_dir(),
            node_dir: dir.clone(),
            node_id: node.id.clone(),
            node_key: key.to_string(),
            project: self.meta.project.clone(),
            project_sha256: self.meta.project_sha256.clone(),
            forge: self.env.forge.clone(),
            launcher: self.env.launcher.clone(),
            worktree_base: self.env.worktree_base.clone(),
            poll: self.env.poll,
            acknowledged,
            progress: Box::new(move |line| {
                let _ = progress_tx.send(line);
            }),
        };
        let uses = action.uses.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("flow-action-{key}"))
            .spawn(move || {
                let end = run_action(&uses, &with, &ctx);
                // The driver may have dropped the receiver (timeout, cancel).
                let _ = tx.send(end);
            });
        if let Err(err) = spawned {
            return self.fail_node(key, attempt, io_failed(err.to_string()));
        }
        self.actions.push(RunningAction {
            key: key.to_string(),
            attempt,
            uses: action.uses.clone(),
            cancel,
            grace_deadline: None,
            dir,
            rx,
            progress_rx,
            started: Instant::now(),
            timeout: self.node_timeout(prefix, node),
        });
    }

    /// The user decided on an action's approval request: `approve` runs the
    /// action again in the same attempt, acknowledged with the request's
    /// `show`; anything else fails the node.
    pub(super) fn action_approval_decided(
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
        let NodeKind::Action(action) = &node.kind else {
            return;
        };
        if self.offline {
            // No loop runs actions here: resuming starts (and asks) a new attempt.
            self.set_node(key, NodeStatus::Ready, attempt, None, None);
            return;
        }
        // The action compares what it finds on the rerun with what was approved.
        let show = request
            .show
            .iter()
            .map(|(name, value)| {
                let value = match value {
                    ShowValue::Value(value) => value.clone(),
                    other => serde_json::to_value(other).unwrap_or(Value::Null),
                };
                (name.clone(), value)
            })
            .collect();
        self.action_ack.insert(key.to_string(), show);
        self.set_node(key, NodeStatus::Running, attempt, None, None);
        self.launch_action(&prefix, key, &node, action, attempt);
    }

    pub(super) fn poll_actions(&mut self) {
        let mut actions = std::mem::take(&mut self.actions);
        let mut finished = Vec::new();
        let mut i = 0;
        while i < actions.len() {
            self.action_progress(&actions[i]);
            let action = &actions[i];
            let finish = match action.rx.try_recv() {
                Ok(end) => Some(ActionFinish::End(end)),
                Err(TryRecvError::Disconnected) => Some(ActionFinish::Lost),
                Err(TryRecvError::Empty)
                    if action.grace_deadline.is_some_and(|d| Instant::now() >= d) =>
                {
                    Some(ActionFinish::GraceKilled)
                }
                Err(TryRecvError::Empty) => action
                    .timeout
                    .filter(|t| action.started.elapsed() >= *t)
                    .map(|_| ActionFinish::Timeout),
            };
            match finish {
                Some(finish) => finished.push((actions.remove(i), finish)),
                None => i += 1,
            }
        }
        self.actions = actions;
        for (action, finish) in finished {
            self.finish_action(action, finish);
        }
    }

    /// Emits the progress lines an action reported since the last poll.
    pub(super) fn action_progress(&mut self, action: &RunningAction) {
        while let Ok(text) = action.progress_rx.try_recv() {
            self.emit(
                Some(&action.key),
                EventBody::NodeProgress {
                    text,
                    fraction: None,
                },
            );
        }
    }

    /// Settles an action node from how its action ended.
    pub(super) fn finish_action(&mut self, action: RunningAction, finish: ActionFinish) {
        self.action_progress(&action);
        // Whatever ends the monitoring, a thread left behind must stop too.
        action.cancel.store(true, Ordering::SeqCst);
        let key = action.key.as_str();
        let attempt = action.attempt;
        match finish {
            ActionFinish::End(ActionEnd::Done { outputs, artifacts }) => {
                self.emit_outputs(key, outputs);
                for (path, label) in artifacts {
                    let raw = path.to_string_lossy().into_owned();
                    self.record_artifact(key, &action.dir, raw, Some(label), None);
                }
                self.write_outputs(key, &action.dir);
                self.settle(key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None);
            }
            ActionFinish::End(ActionEnd::NeedsApproval { show, outputs }) => {
                self.emit_outputs(key, outputs);
                self.write_outputs(key, &action.dir);
                self.set_node(key, NodeStatus::AwaitingApproval, attempt, None, None);
                let request = ApprovalRequest {
                    node_key: Some(key.to_string()),
                    options: COMMAND_APPROVAL_OPTIONS
                        .iter()
                        .map(|s| RequestOption::plain(*s))
                        .collect(),
                    // The UI explains the request from its reason.
                    message: None,
                    show: show
                        .into_iter()
                        .map(|(name, value)| (name, ShowValue::Value(value)))
                        .collect(),
                    reason: Reason::new(FLOW_ACTION_APPROVAL).with("uses", action.uses.as_str()),
                };
                self.emit(Some(key), EventBody::ApprovalRequested(request));
            }
            ActionFinish::End(ActionEnd::Failed(reason)) => {
                self.after_failure(key, attempt, reason, false)
            }
            ActionFinish::Lost => self.after_failure(
                key,
                attempt,
                Reason::new(FLOW_ACTION_FAILED).with("code", FLOW_ACTION_PANICKED),
                false,
            ),
            // The thread is asked to end and left behind; retrying could run
            // the same operation twice at once, so a timeout is final.
            ActionFinish::Timeout => self.fail_node(key, attempt, Reason::new(FLOW_NODE_TIMEOUT)),
            ActionFinish::GraceKilled => {
                self.set_node(
                    key,
                    NodeStatus::Ready,
                    attempt,
                    Some(Reason::new(FLOW_STOP_GRACE_EXCEEDED)),
                    None,
                );
            }
            ActionFinish::End(ActionEnd::Cancelled) if self.cancel_requested => {
                self.set_node(
                    key,
                    NodeStatus::Cancelled,
                    attempt,
                    Some(Reason::new(FLOW_RUN_CANCELLED)),
                    None,
                );
            }
            // Stopped: the node runs again on resume.
            ActionFinish::End(ActionEnd::Cancelled) if self.stop_requested => {
                self.set_node(
                    key,
                    NodeStatus::Ready,
                    attempt,
                    Some(Reason::new(FLOW_NODE_STOPPED)),
                    None,
                );
            }
            // Nobody asked for this cancel: the action did not do its work.
            ActionFinish::End(ActionEnd::Cancelled) => self.after_failure(
                key,
                attempt,
                Reason::new(FLOW_ACTION_FAILED).with("code", FLOW_ACTION_CANCELLED),
                false,
            ),
        }
    }

    /// Asks every running action to end, then waits (bounded by
    /// `limits.stopGrace`, else [`DEFAULT_CANCEL_GRACE`]) until their threads
    /// have ended, so the processes they started are gone.
    pub(super) fn end_actions(&mut self) -> Vec<RunningAction> {
        let actions = std::mem::take(&mut self.actions);
        for action in &actions {
            action.cancel.store(true, Ordering::SeqCst);
        }
        let deadline = Instant::now() + self.stop_grace().unwrap_or(DEFAULT_CANCEL_GRACE);
        for action in &actions {
            let left = deadline.saturating_duration_since(Instant::now());
            // Any end, a lost thread or the deadline: the action is over for us.
            let _ = action.rx.recv_timeout(left);
        }
        actions
    }
}

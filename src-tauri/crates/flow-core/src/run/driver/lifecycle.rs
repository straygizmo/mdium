//! Driver: run-level control (pause, resume, cancel, stop grace, budget)
//! and the settlement of a run's final status.

use super::*;

impl Driver {
    // --------------------------------------------- stop / cancel / exit

    pub(super) fn stop_grace(&self) -> Option<Duration> {
        self.meta
            .flow
            .limits
            .stop_grace
            .as_deref()
            .and_then(parse_duration)
    }

    pub(super) fn begin_stop(&mut self) {
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
        let grace = self.stop_grace();
        let deadline = || Some(grace.map(|g| Instant::now() + g).unwrap_or_else(far_future));
        for command in &mut self.running {
            if command.grace_deadline.is_none() {
                command.grace_deadline = deadline();
            }
        }
        // Calls see the STOP file too; no `cancel` is sent.
        for call in &mut self.calls {
            if call.grace_deadline.is_none() {
                call.grace_deadline = deadline();
            }
        }
        // Actions are asked to end; a finished action settles as it ended.
        for action in &mut self.actions {
            if action.grace_deadline.is_none() {
                action.grace_deadline = deadline();
            }
            action.cancel.store(true, Ordering::SeqCst);
        }
        // Agents cannot see the STOP file: their turn is cancelled.
        for agent in &mut self.agents {
            if agent.grace_deadline.is_none() {
                agent.grace_deadline = deadline();
            }
            if !agent.cancel_sent {
                agent.handle.cancel();
                agent.cancel_sent = true;
            }
        }
    }

    pub(super) fn cancel_all(&mut self) {
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
        self.cancel_calls();
        self.kill_workers();
        for call in std::mem::take(&mut self.calls) {
            self.set_node(
                &call.key,
                NodeStatus::Cancelled,
                call.attempt,
                Some(Reason::new(FLOW_RUN_CANCELLED)),
                None,
            );
        }
        // The turn threads cancel and close their sessions on their own.
        for mut agent in std::mem::take(&mut self.agents) {
            agent.handle.cancel();
            self.warn_integrity(&agent);
            self.set_node(
                &agent.key,
                NodeStatus::Cancelled,
                agent.attempt,
                Some(Reason::new(FLOW_RUN_CANCELLED)),
                None,
            );
        }
        // Action threads are asked to end (killing what they started).
        for action in self.end_actions() {
            self.set_node(
                &action.key,
                NodeStatus::Cancelled,
                action.attempt,
                Some(Reason::new(FLOW_RUN_CANCELLED)),
                None,
            );
        }
        self.set_run(RunStatus::Cancelled, Some(Reason::new(FLOW_RUN_CANCELLED)));
    }

    /// App exit: detached commands keep running (reconnected later); attached
    /// ones are killed and, with the run, become `interrupted`.
    pub(super) fn shutdown(&mut self) {
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
        // Workers never survive the app.
        self.kill_workers();
        for call in std::mem::take(&mut self.calls) {
            self.set_node(
                &call.key,
                NodeStatus::Interrupted,
                call.attempt,
                Some(Reason::new(FLOW_APP_EXITED)),
                None,
            );
            interrupted = true;
        }
        // Agent turns never survive the app either.
        for mut agent in std::mem::take(&mut self.agents) {
            agent.handle.cancel();
            self.warn_integrity(&agent);
            self.set_node(
                &agent.key,
                NodeStatus::Interrupted,
                agent.attempt,
                Some(Reason::new(FLOW_APP_EXITED)),
                None,
            );
            interrupted = true;
        }
        // Nor do actions: they are asked to end so their processes go too.
        for action in self.end_actions() {
            self.set_node(
                &action.key,
                NodeStatus::Interrupted,
                action.attempt,
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
    pub(super) fn reconnect_running(&mut self) {
        let running: Vec<(String, NodeState)> = self
            .state
            .nodes
            .iter()
            .filter(|(k, n)| {
                n.status == NodeStatus::Running
                    && !self.running.iter().any(|r| &r.key == *k)
                    && !self.calls.iter().any(|c| &c.key == *k)
                    && !self.agents.iter().any(|a| &a.key == *k)
                    && !self.actions.iter().any(|a| &a.key == *k)
            })
            .map(|(k, n)| (k.clone(), n.clone()))
            .collect();
        for (key, state) in running {
            let Some((prefix, node)) = self.def_of(&key) else {
                continue;
            };
            let command = match &node.kind {
                NodeKind::Command(command) => command,
                // Workers, agent turns and actions never survive a restart:
                // the work is lost.
                NodeKind::Python(_) | NodeKind::Agent(_) | NodeKind::Action(_) => {
                    self.set_node(
                        &key,
                        NodeStatus::Interrupted,
                        state.attempt,
                        Some(Reason::new(FLOW_PROCESS_LOST)),
                        None,
                    );
                    continue;
                }
                // Loops and sub-flows stay running; their scopes carry on.
                _ => continue,
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
}

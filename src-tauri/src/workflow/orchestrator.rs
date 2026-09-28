//! Orchestrator service: attaches projects, dispatches inbox workflow tasks
//! to attempts (respecting each workflow's concurrency limit), runs every
//! attempt on its own thread, cancels attempts on request, reports changes
//! through an [`EventSink`], and shuts everything down on exit.
//!
//! Locking: the project's [`ProjectGuard`](crate::workflow::state::ProjectGuard)
//! is only held for short store work (recovery, starting and finishing an
//! attempt), never while a runner session runs. The orchestrator's own
//! mutex (`inner`) may be taken while holding a project guard, but a
//! project guard is never taken while holding `inner`.

use crate::workflow::attempt::{
    run_attempt, AttemptEnd, CancelReason, CancelToken, ProgressUpdate, CANCEL_GRACE,
};
use crate::workflow::checks::{self, CheckResult};
use crate::workflow::doc_markdown;
use crate::workflow::errors::to_attention;
use crate::workflow::flow::{
    self, begin_attempt, finish_attempt, park_unfinished, recover, BeginResult, FinishInput,
    IssueSyncError, PlannedAttempt, StageResult, WORKFLOW_ISSUE_SYNC_INTERRUPTED,
};
use crate::workflow::forge::ForgeCli;
use crate::workflow::model::{IntakeStatus, RunStatus, Task, TaskStatus, Workflow, WorkflowRun};
use crate::workflow::outcome::parse_outcome;
use crate::workflow::runner_host::RunnerApi;
use crate::workflow::state::{normalize_root, project_key};
use crate::workflow::store::{StoreError, WorkflowStore};
use std::any::Any;
use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How long the app's exit waits for attempts to end after cancelling
/// them: the attempt loop's grace for `TurnCancelled` plus time to close
/// the session, run the post-attempt checks and record the attempt.
pub const SHUTDOWN_WAIT: Duration = Duration::from_secs(CANCEL_GRACE.as_secs() + 2);

/// Code of an attempt whose thread could not be started.
const WORKFLOW_THREAD_SPAWN_FAILED: &str = "WORKFLOW_THREAD_SPAWN_FAILED";
/// Code of an attempt whose thread panicked.
const WORKFLOW_ATTEMPT_PANICKED: &str = "WORKFLOW_ATTEMPT_PANICKED";

/// Receives every task/run change and attempt progress update, plus
/// intake session and workflow definition changes.
pub trait EventSink: Send + Sync {
    fn task_changed(&self, project_root: &Path, task: &Task);
    fn run_changed(&self, project_root: &Path, run: &WorkflowRun);
    fn progress(
        &self,
        project_root: &Path,
        task_id: &str,
        attempt_id: &str,
        update: &ProgressUpdate,
    );
    /// An intake session changed, or one of its agent turns started or
    /// ended (`busy`: a turn is running).
    fn intake_changed(
        &self,
        project_root: &Path,
        intake_id: &str,
        status: IntakeStatus,
        busy: bool,
    );
    /// `workflows.json` was rewritten.
    fn workflows_changed(&self, project_root: &Path);
}

/// One attached project.
struct Project {
    /// The normalized root (letter case preserved) used for its store and
    /// its events.
    root: PathBuf,
    /// A dispatch thread is running for this project.
    dispatching: bool,
    /// A dispatch was requested while one was running: run one more pass.
    dirty: bool,
}

/// An attempt between its start and the end of its thread.
struct ActiveAttempt {
    cancel: CancelToken,
}

#[derive(Default)]
struct Inner {
    /// Attached projects by [`project_key`].
    projects: HashMap<PathBuf, Project>,
    /// Active attempts by task id.
    active: HashMap<String, ActiveAttempt>,
    shut_down: bool,
}

impl Inner {
    fn is_idle(&self) -> bool {
        self.active.is_empty() && self.projects.values().all(|p| !p.dispatching)
    }

    /// Records a dispatch request for project `key`. Returns true when the
    /// caller must start the dispatch thread; a request while one runs only
    /// makes it run one more pass.
    fn request_dispatch(&mut self, key: &Path) -> bool {
        if self.shut_down {
            return false;
        }
        let Some(project) = self.projects.get_mut(key) else {
            return false;
        };
        if project.dispatching {
            project.dirty = true;
            false
        } else {
            project.dispatching = true;
            project.dirty = false;
            true
        }
    }

    /// Called when the dispatch thread of project `key` panicked. Clears
    /// `dispatching`; if a request arrived meanwhile (and no shutdown),
    /// consumes it and sets `dispatching` again. Returns true when the
    /// caller must start a new dispatch thread.
    fn abort_pass(&mut self, key: &Path) -> bool {
        let shut_down = self.shut_down;
        let Some(project) = self.projects.get_mut(key) else {
            return false;
        };
        let respawn = project.dirty && !shut_down;
        project.dirty = false;
        project.dispatching = respawn;
        respawn
    }

    /// Called by the dispatch thread of project `key` after a pass. Returns
    /// true when another pass was requested meanwhile (consuming that
    /// request); otherwise clears `dispatching` in this same critical
    /// section, so a request arriving afterwards starts a new dispatch
    /// thread instead of being lost.
    fn finish_pass(&mut self, key: &Path) -> bool {
        let shut_down = self.shut_down;
        let Some(project) = self.projects.get_mut(key) else {
            return false;
        };
        if project.dirty && !shut_down {
            project.dirty = false;
            true
        } else {
            project.dispatching = false;
            false
        }
    }
}

pub struct Orchestrator {
    runner: Arc<dyn RunnerApi>,
    sink: Arc<dyn EventSink>,
    /// Posts stage results to Issues and closes them after a merge.
    forge: Arc<dyn ForgeCli>,
    worktree_base: PathBuf,
    inner: Mutex<Inner>,
    /// Notified whenever an attempt or a dispatch thread ends.
    idle: Condvar,
}

impl Orchestrator {
    pub fn new(
        runner: Arc<dyn RunnerApi>,
        sink: Arc<dyn EventSink>,
        forge: Arc<dyn ForgeCli>,
        worktree_base: PathBuf,
    ) -> Arc<Self> {
        Arc::new(Orchestrator {
            runner,
            sink,
            forge,
            worktree_base,
            inner: Mutex::new(Inner::default()),
            idle: Condvar::new(),
        })
    }

    /// Locks `inner`. Nothing in it can be left half-updated by a panic,
    /// so a poisoned lock is recovered.
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Attaches `project_root` (any spelling of it) and returns its
    /// normalized key. See [`Self::attach`].
    pub fn attach_project(self: &Arc<Self>, project_root: &Path) -> PathBuf {
        self.attach(project_root).0
    }

    /// Attaches `project_root` (any spelling of it) and returns its
    /// normalized key and whether this call attached it. The first attach
    /// of a key recovers the project as after a restart (running tasks
    /// become `ATTENTION_INTERRUPTED`); a later attach does nothing (every
    /// dispatch pass finishes half-done stage advances), so it is cheap.
    /// Does nothing after [`Self::shutdown`].
    pub fn attach(self: &Arc<Self>, project_root: &Path) -> (PathBuf, bool) {
        let key = project_key(project_root);
        {
            let inner = self.inner();
            if inner.shut_down || inner.projects.contains_key(&key) {
                return (key, false);
            }
        }
        let store = WorkflowStore::new(normalize_root(project_root));
        // Registering under the project guard means no dispatch pass of
        // this project can run before the first recovery is done.
        let guard = store.lock();
        {
            let mut inner = self.inner();
            if inner.shut_down {
                return (key, false);
            }
            match inner.projects.entry(key.clone()) {
                // Another attach registered the project meanwhile (under
                // any spelling) and has already recovered it.
                Entry::Occupied(_) => return (key, false),
                Entry::Vacant(entry) => {
                    entry.insert(Project {
                        root: store.project_root().to_path_buf(),
                        dispatching: false,
                        dirty: false,
                    });
                }
            }
        }
        match recover(&guard, &store, true) {
            Ok(changed) => self.emit_changes(&store, &changed),
            Err(err) => eprintln!(
                "[workflow] recovery of {} failed: {err}",
                store.project_root().display()
            ),
        }
        (key, true)
    }

    /// Requests a dispatch pass for the project (attaching it first if
    /// needed). Requests during a running pass are coalesced into one more
    /// pass. Ignored after [`Self::shutdown`].
    pub fn kick(self: &Arc<Self>, project_root: &Path) {
        let key = project_key(project_root);
        let attached = {
            let inner = self.inner();
            if inner.shut_down {
                return;
            }
            inner.projects.contains_key(&key)
        };
        if !attached {
            self.attach_project(project_root);
        }
        if self.inner().request_dispatch(&key) {
            self.spawn_dispatch(key);
        }
    }

    /// Signals the active attempt of `task_id` to cancel. Returns false if
    /// the task has no active attempt.
    pub fn cancel_task(&self, task_id: &str, reason: CancelReason) -> bool {
        match self.inner().active.get(task_id) {
            Some(attempt) => {
                attempt.cancel.cancel(reason);
                true
            }
            None => false,
        }
    }

    pub fn is_active(&self, task_id: &str) -> bool {
        self.inner().active.contains_key(task_id)
    }

    /// The store of `project_root` (the attached root when the project is
    /// attached under any spelling).
    pub fn store(&self, project_root: &Path) -> WorkflowStore {
        let key = project_key(project_root);
        let root = self.inner().projects.get(&key).map(|p| p.root.clone());
        WorkflowStore::new(root.unwrap_or_else(|| normalize_root(project_root)))
    }

    pub fn sink(&self) -> &Arc<dyn EventSink> {
        &self.sink
    }

    pub fn runner(&self) -> &Arc<dyn RunnerApi> {
        &self.runner
    }

    pub fn forge(&self) -> &Arc<dyn ForgeCli> {
        &self.forge
    }

    /// Base dir the runs' worktrees are created under.
    pub fn worktree_base(&self) -> &Path {
        &self.worktree_base
    }

    /// Cancels every active attempt (`Shutdown`, so the tasks stay running
    /// and are interrupted on the next start), waits up to `wait` for the
    /// attempt and dispatch threads to end, and shuts the runner down.
    /// Later kicks are ignored.
    pub fn shutdown(&self, wait: Duration) {
        {
            let mut inner = self.inner();
            inner.shut_down = true;
            for attempt in inner.active.values() {
                attempt.cancel.cancel(CancelReason::Shutdown);
            }
        }
        if !self.wait_until_idle(wait) {
            eprintln!("[workflow] shutdown: attempts still running after {wait:?}");
        }
        self.runner.shutdown();
    }

    /// Sets the shutdown flag without cancelling anything, as when a
    /// shutdown starts right after an attempt's turn ended.
    #[cfg(test)]
    pub fn mark_shut_down(&self) {
        self.inner().shut_down = true;
    }

    /// Waits until no dispatch pass and no attempt is running.
    #[cfg(test)]
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        self.wait_until_idle(timeout)
    }

    fn wait_until_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now().checked_add(timeout);
        let mut inner = self.inner();
        while !inner.is_idle() {
            let left = match deadline {
                Some(deadline) => deadline.saturating_duration_since(Instant::now()),
                None => Duration::MAX,
            };
            if left.is_zero() {
                return false;
            }
            inner = self
                .idle
                .wait_timeout(inner, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }

    /// Starts the dispatch thread of project `key`, whose `dispatching`
    /// flag the caller has just set.
    fn spawn_dispatch(self: &Arc<Self>, key: PathBuf) {
        let orch = Arc::clone(self);
        let thread_key = key.clone();
        let spawned = std::thread::Builder::new()
            .name("workflow-dispatch".to_string())
            .spawn(move || orch.dispatch_loop(thread_key));
        if let Err(err) = spawned {
            eprintln!("[workflow] failed to start dispatch thread: {err}");
            self.end_dispatch(&key);
        }
    }

    /// Clears the `dispatching` flag of project `key` when its dispatch
    /// thread ends abnormally (it failed to start or panicked). A pending
    /// request (`dirty`) is kept; the next request starts a new thread.
    fn end_dispatch(&self, key: &Path) {
        let mut inner = self.inner();
        if let Some(project) = inner.projects.get_mut(key) {
            project.dispatching = false;
        }
        self.idle.notify_all();
    }

    /// Runs dispatch passes until no further pass was requested.
    fn dispatch_loop(self: Arc<Self>, key: PathBuf) {
        // If a pass panics: clear the flag so later kicks still work, and
        // honour a request that arrived during the pass with one new
        // dispatch thread (one re-spawn per panic, so no tight loop).
        struct Unwind<'a>(&'a Arc<Orchestrator>, &'a Path);
        impl Drop for Unwind<'_> {
            fn drop(&mut self) {
                if !std::thread::panicking() {
                    return;
                }
                let respawn = {
                    let mut inner = self.0.inner();
                    let respawn = inner.abort_pass(self.1);
                    self.0.idle.notify_all();
                    respawn
                };
                if respawn {
                    self.0.spawn_dispatch(self.1.to_path_buf());
                }
            }
        }
        let _unwind = Unwind(&self, &key);
        loop {
            let root = self.inner().projects.get(&key).map(|p| p.root.clone());
            if let Some(root) = root {
                self.dispatch_pass(&key, &root);
            }
            let mut inner = self.inner();
            if !inner.finish_pass(&key) {
                self.idle.notify_all();
                return;
            }
        }
    }

    /// Before a pass takes the project guard: converts the Office/PDF
    /// attachments of every root with an inbox workflow task to Markdown,
    /// so the prompts built under the guard can point agents at readable
    /// versions (see [`doc_markdown`]). Committed attachments never change,
    /// and conversions already done (or rejected) are not repeated.
    fn prepare_renditions(&self, store: &WorkflowStore, root: &Path) {
        let tasks = match store.list_tasks() {
            Ok(list) => list.tasks,
            Err(_) => return, // The pass itself reports listing failures.
        };
        let roots: BTreeSet<&str> = tasks
            .iter()
            .filter(|t| {
                t.meta.status == TaskStatus::Inbox
                    && !t.meta.archived
                    && t.meta.workflow_id.is_some()
            })
            .map(|t| t.meta.root_id.as_str())
            .collect();
        for root_id in roots {
            if self.inner().shut_down {
                return;
            }
            doc_markdown::prepare_root_renditions(root, root_id, self.runner.as_ref());
        }
    }

    /// One dispatch pass: recovers half-done advances, then starts every
    /// startable inbox task (oldest first) within its workflow's
    /// concurrency limit, and spawns one thread per started attempt.
    fn dispatch_pass(self: &Arc<Self>, key: &Path, root: &Path) {
        let store = WorkflowStore::new(root.to_path_buf());
        self.prepare_renditions(&store, root);
        let mut started = Vec::new();
        {
            let guard = store.lock();
            match recover(&guard, &store, false) {
                Ok(changed) => self.emit_changes(&store, &changed),
                Err(err) => eprintln!("[workflow] recovery of {} failed: {err}", root.display()),
            }
            let workflows = match store.load_workflows() {
                Ok(list) => list.workflows,
                Err(err) => {
                    eprintln!(
                        "[workflow] loading workflows of {} failed: {err}",
                        root.display()
                    );
                    return;
                }
            };
            let tasks = match store.list_tasks() {
                Ok(list) => list.tasks,
                Err(err) => {
                    eprintln!(
                        "[workflow] listing tasks of {} failed: {err}",
                        root.display()
                    );
                    return;
                }
            };
            // Counted once per pass; runs started below are added.
            let mut active_runs = active_run_counts(&store);
            // `list_tasks` is sorted by creation time, oldest first.
            for task in tasks
                .iter()
                .filter(|t| t.meta.status == TaskStatus::Inbox && !t.meta.archived)
            {
                if task.meta.workflow_id.is_none() {
                    continue;
                }
                {
                    let inner = self.inner();
                    if inner.shut_down {
                        break;
                    }
                    if inner.active.contains_key(&task.meta.id) {
                        continue;
                    }
                }
                let slot = run_slot(&store, &workflows, task, active_runs.as_ref());
                if slot == RunSlot::Full {
                    continue;
                }
                let begun = begin_attempt(
                    &guard,
                    &store,
                    &workflows,
                    &task.meta.id,
                    &self.worktree_base,
                );
                match begun {
                    Ok(BeginResult::Started(planned)) => {
                        let cancel = CancelToken::default();
                        {
                            // Registered before the guard is released, so no
                            // other pass can start the task again.
                            let mut inner = self.inner();
                            if inner.shut_down {
                                cancel.cancel(CancelReason::Shutdown);
                            }
                            inner.active.insert(
                                task.meta.id.clone(),
                                ActiveAttempt {
                                    cancel: cancel.clone(),
                                },
                            );
                        }
                        if let (RunSlot::Free(workflow_id), Some(counts)) =
                            (slot, active_runs.as_mut())
                        {
                            *counts.entry(workflow_id).or_default() += 1;
                        }
                        self.emit_task(&store, &task.meta.id);
                        self.sink.run_changed(root, &planned.run);
                        started.push((planned, cancel));
                    }
                    Ok(BeginResult::Parked) => self.emit_task_and_run(&store, task),
                    Ok(BeginResult::Skipped) => {}
                    Err(err) => {
                        eprintln!("[workflow] starting task {} failed: {err}", task.meta.id);
                        // The start may have changed the task before failing.
                        self.emit_task_and_run(&store, task);
                    }
                }
            }
        }
        for (planned, cancel) in started {
            self.spawn_attempt(key, root, planned, cancel);
        }
    }

    /// Runs a registered attempt on its own thread.
    fn spawn_attempt(
        self: &Arc<Self>,
        key: &Path,
        root: &Path,
        planned: PlannedAttempt,
        cancel: CancelToken,
    ) {
        let registration = Registration {
            orch: Arc::clone(self),
            key: key.to_path_buf(),
            task_id: planned.request.task_id.clone(),
        };
        let orch = Arc::clone(self);
        let thread_root = root.to_path_buf();
        let thread_planned = planned.clone();
        let spawned = std::thread::Builder::new()
            .name("workflow-attempt".to_string())
            .spawn(move || {
                let _registration = registration;
                orch.attempt_thread(&thread_root, &thread_planned, &cancel);
            });
        if let Err(err) = spawned {
            // The closure (and with it the registration) is gone already;
            // do not leave the task running with nothing behind it.
            let input = FinishInput {
                end: AttemptEnd::Failed {
                    code: WORKFLOW_THREAD_SPAWN_FAILED.to_string(),
                    message: err.to_string(),
                },
                check: CheckResult {
                    after: None,
                    reason: None,
                },
                issue_sync_error: None,
            };
            self.finish(&WorkflowStore::new(root.to_path_buf()), &planned, input);
        }
    }

    /// The body of an attempt thread: integrity baseline, the runner
    /// session, the post-attempt checks, the Issue sync, and the finish.
    fn attempt_thread(&self, root: &Path, planned: &PlannedAttempt, cancel: &CancelToken) {
        let store = WorkflowStore::new(root.to_path_buf());
        let req = &planned.request;
        // A snapshot whose git config or hooks differ from the run's
        // acknowledged baseline counts as a failed baseline: no session
        // starts until the change is accepted (retry with accept_integrity).
        let baseline = catch_unwind(AssertUnwindSafe(|| {
            checks::baseline(&planned.repo_root, &planned.run).and_then(|before| {
                match checks::unacknowledged_config_change(&planned.run, &before) {
                    Some(reason) => Err(reason),
                    None => Ok(before),
                }
            })
        }));
        let input = match baseline {
            // No session was started; the missing baseline fails closed.
            Err(payload) => FinishInput {
                end: panicked(payload),
                check: panicked_check(),
                issue_sync_error: None,
            },
            // No session is started without a baseline (or with an
            // unacknowledged git config or hooks change).
            Ok(Err(reason)) => FinishInput {
                end: AttemptEnd::Failed {
                    code: reason.code.clone(),
                    message: String::new(),
                },
                check: CheckResult {
                    after: None,
                    reason: Some(reason),
                },
                issue_sync_error: None,
            },
            Ok(Ok(before)) => {
                let progress = |update: ProgressUpdate| {
                    self.sink
                        .progress(root, &req.task_id, &req.attempt_id, &update)
                };
                let end = catch_unwind(AssertUnwindSafe(|| {
                    run_attempt(self.runner.as_ref(), &store, req, cancel, &progress)
                }))
                .unwrap_or_else(|payload| {
                    // `run_attempt` did not get to close the session.
                    let closed = catch_unwind(AssertUnwindSafe(|| {
                        self.runner.close_session(&req.session_id)
                    }));
                    match closed {
                        Ok(Ok(())) => {}
                        Ok(Err(err)) => eprintln!(
                            "[workflow] failed to close session {}: {err}",
                            req.session_id
                        ),
                        Err(_) => {
                            eprintln!("[workflow] closing session {} panicked", req.session_id)
                        }
                    }
                    panicked(payload)
                });
                // The checks run after every attempt, also a panicked one;
                // a panicking check fails closed.
                let check = catch_unwind(AssertUnwindSafe(|| {
                    checks::post_attempt(
                        &planned.worktree_base,
                        &planned.repo_root,
                        &planned.run,
                        &before,
                    )
                }))
                .unwrap_or_else(|_| panicked_check());
                FinishInput {
                    end,
                    check,
                    issue_sync_error: None,
                }
            }
        };
        let issue_sync_error = catch_unwind(AssertUnwindSafe(|| {
            self.sync_issue(&store, planned, &input)
        }))
        .unwrap_or_else(|_| {
            Some(IssueSyncError::Local {
                code: WORKFLOW_ATTEMPT_PANICKED,
                detail: String::new(),
            })
        });
        self.finish(
            &store,
            planned,
            FinishInput {
                issue_sync_error,
                ..input
            },
        );
    }

    /// Posts the stage result of an attempt that passed its checks to the
    /// run's Issue (when the run tracks one), without the project guard and
    /// before the finish applies the result. Only a result that moves the
    /// flow on is posted: a completed stage (not a plan attempt) or review
    /// findings that will be returned (re-entry limit not reached), and only
    /// while the task is still running. Returns why the post failed.
    ///
    /// Crash safety: right before posting, the attempt is marked as syncing
    /// (`issue_sync_pending`, under a short guard); the finish clears the
    /// mark. If the app dies in between, recovery parks the task as a failed
    /// sync of that same attempt, so a retry finds an entry that already
    /// landed by its marker instead of posting a second one. During shutdown
    /// nothing is posted (the post could outlast the shutdown wait); the
    /// stage parks as an interrupted sync instead.
    fn sync_issue(
        &self,
        store: &WorkflowStore,
        planned: &PlannedAttempt,
        input: &FinishInput,
    ) -> Option<IssueSyncError> {
        if input.check.reason.is_some() {
            return None;
        }
        let AttemptEnd::Completed { final_response } = &input.end else {
            return None;
        };
        let issue = flow::tracked_issue(&planned.run)?;
        let outcome = parse_outcome(final_response).ok()?;
        let role = planned.stage.role;
        let result = flow::stage_result(role, planned.mode, &outcome)?;
        let req = &planned.request;
        match store.get_task(&req.task_id) {
            Ok(task) if task.meta.status == TaskStatus::Running => {}
            _ => return None,
        }
        let run = store
            .get_run(&req.root_task_id)
            .unwrap_or_else(|_| planned.run.clone());
        if matches!(result, StageResult::Returned(_))
            && run.reentry_count >= run.workflow.max_reentry_count
        {
            return None;
        }
        let entry = match flow::stage_entry(
            &planned.worktree_base,
            &run,
            &req.task_id,
            &req.attempt_id,
            role,
            &result,
        ) {
            Ok(entry) => entry,
            Err(err) => return Some(err),
        };
        if self.inner().shut_down {
            return Some(IssueSyncError::Local {
                code: WORKFLOW_ISSUE_SYNC_INTERRUPTED,
                detail: String::new(),
            });
        }
        {
            let guard = store.lock();
            if let Err(err) = flow::mark_issue_sync_pending(
                &guard,
                store,
                &req.root_task_id,
                &req.attempt_id,
                entry.kind,
            ) {
                // Without the mark a crash during the post could not be
                // recovered safely: do not post.
                return Some(IssueSyncError::Local {
                    code: err.code(),
                    detail: err.to_string(),
                });
            }
        }
        // The task may be put on hold or cancelled while the entry is being
        // posted (the status check above is not under the guard). The entry
        // then records a result the finish does not apply: the finish leaves
        // a task that is no longer running as it is, and a later attempt
        // posts its own entry. This is accepted; the Issue history only
        // gains an extra record.
        flow::post_stage_entry(self.forge.as_ref(), issue, &entry)
            .err()
            .map(IssueSyncError::from)
    }

    /// Applies an attempt's end under the project guard and reports it.
    fn finish(&self, store: &WorkflowStore, planned: &PlannedAttempt, input: FinishInput) {
        let guard = store.lock();
        match finish_attempt(&guard, store, planned, input) {
            Ok(summary) => {
                for task in &summary.changed_tasks {
                    self.sink.task_changed(store.project_root(), task);
                }
                if let Some(run) = &summary.run {
                    self.sink.run_changed(store.project_root(), run);
                }
            }
            Err(err) => {
                eprintln!(
                    "[workflow] finishing attempt {} failed: {err}",
                    planned.request.attempt_id
                );
                if let Some(task) =
                    park_unfinished(&guard, store, &planned.request.task_id, err.code())
                {
                    self.emit_changes(store, &[task]);
                }
            }
        }
    }

    /// Reports task `task_id` as currently stored.
    fn emit_task(&self, store: &WorkflowStore, task_id: &str) {
        match store.get_task(task_id) {
            Ok(task) => self.sink.task_changed(store.project_root(), &task),
            Err(err) => eprintln!("[workflow] reading task {task_id} failed: {err}"),
        }
    }

    /// Reports `task` as currently stored, plus its run if it has one.
    fn emit_task_and_run(&self, store: &WorkflowStore, task: &Task) {
        match store.get_task(&task.meta.id) {
            Ok(current) => self.emit_changes(store, &[current]),
            Err(err) => eprintln!("[workflow] reading task {} failed: {err}", task.meta.id),
        }
    }

    /// Reports `tasks` and the runs they belong to.
    fn emit_changes(&self, store: &WorkflowStore, tasks: &[Task]) {
        let root = store.project_root();
        for task in tasks {
            self.sink.task_changed(root, task);
        }
        let run_ids: BTreeSet<&str> = tasks.iter().map(|t| t.meta.root_id.as_str()).collect();
        for run_id in run_ids {
            if let Ok(run) = store.get_run(run_id) {
                self.sink.run_changed(root, &run);
            }
        }
    }
}

/// The project's Active runs per workflow snapshot id, or `None` if the
/// runs cannot be listed (then no new run is started in this pass).
fn active_run_counts(store: &WorkflowStore) -> Option<HashMap<String, usize>> {
    match store.list_runs() {
        Ok(list) => {
            let mut counts = HashMap::new();
            for run in list.runs.iter().filter(|r| r.status == RunStatus::Active) {
                *counts.entry(run.workflow.id.clone()).or_default() += 1;
            }
            Some(counts)
        }
        Err(err) => {
            eprintln!("[workflow] listing runs failed: {err}");
            None
        }
    }
}

/// How a task stands against its workflow's concurrency limit.
#[derive(Debug, PartialEq)]
enum RunSlot {
    /// The task needs no new run slot: it belongs to an existing run
    /// (already counted), or `begin_attempt` will park or report it.
    NotNeeded,
    /// The task would start a new run of this workflow id.
    Free(String),
    /// The workflow already has `max_concurrent_runs` Active runs.
    Full,
}

/// Checks `task` against the concurrency limit, which counts Active runs
/// (`active_runs`, see [`active_run_counts`]) whose workflow snapshot has
/// the task's workflow id, against the loaded workflow's
/// `max_concurrent_runs`.
fn run_slot(
    store: &WorkflowStore,
    workflows: &[Workflow],
    task: &Task,
    active_runs: Option<&HashMap<String, usize>>,
) -> RunSlot {
    match store.get_run(&task.meta.root_id) {
        Err(StoreError::NotFound) => {}
        // An existing run, or one `begin_attempt` will report on.
        _ => return RunSlot::NotNeeded,
    }
    let Some(workflow_id) = task.meta.workflow_id.as_deref() else {
        return RunSlot::NotNeeded;
    };
    let Some(workflow) = workflows.iter().find(|w| w.id == workflow_id) else {
        return RunSlot::NotNeeded;
    };
    let Some(active_runs) = active_runs else {
        return RunSlot::Full;
    };
    let active = active_runs.get(workflow_id).copied().unwrap_or(0);
    if active < workflow.max_concurrent_runs as usize {
        RunSlot::Free(workflow_id.to_string())
    } else {
        RunSlot::Full
    }
}

/// The check result of an integrity check that panicked (fails closed).
fn panicked_check() -> CheckResult {
    CheckResult {
        after: None,
        reason: Some(to_attention(
            "ATTENTION_INTEGRITY_CHECK_FAILED",
            [("code", WORKFLOW_ATTEMPT_PANICKED)],
        )),
    }
}

/// The end of an attempt whose thread panicked.
fn panicked(payload: Box<dyn Any + Send>) -> AttemptEnd {
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_default();
    AttemptEnd::Failed {
        code: WORKFLOW_ATTEMPT_PANICKED.to_string(),
        message,
    }
}

/// Keeps an attempt registered as active while its thread runs. Dropping
/// it (also when the thread panics) unregisters the attempt and requests
/// another dispatch pass for its project in the same critical section, so
/// the orchestrator is never seen idle in between.
struct Registration {
    orch: Arc<Orchestrator>,
    key: PathBuf,
    task_id: String,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let dispatch = {
            let mut inner = self.orch.inner();
            inner.active.remove(&self.task_id);
            let dispatch = inner.request_dispatch(&self.key);
            self.orch.idle.notify_all();
            dispatch
        };
        if dispatch {
            self.orch.spawn_dispatch(self.key.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::forge::{FakeForge, FakeOp, ForgeCall, ForgeError, ForgeKind};
    use crate::workflow::fsutil::{self, new_id};
    use crate::workflow::gitops::{self, test_support::Fixture};
    use crate::workflow::issue_sync::{self, EntryKind};
    use crate::workflow::model::{
        IssueRef, IssueTracking, Provider, Role, RunStatus, TaskMeta, TaskStatus, Workflow,
        WorkflowsFile,
    };
    use crate::workflow::runner_client::{
        RunnerError, RunnerEvent, RunnerPermission, StartSessionParams,
    };
    use crate::workflow::state::transition;
    use crate::workflow::template::standard_workflow;
    use std::collections::{HashMap, VecDeque};
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::Barrier;

    /// Upper bound for every wait; only reached when a test fails.
    const WAIT: Duration = Duration::from_secs(60);

    type Hook = Box<dyn Fn(&StartSessionParams) + Send + Sync>;

    /// What the fake runner does with one session's turn.
    enum Script {
        /// Runs `hook` (mid-turn) and then completes with `response`.
        Complete {
            hook: Option<Hook>,
            response: String,
        },
        /// Reports the turn as waiting and ends it with `on_cancel` once
        /// the session is cancelled.
        WaitForCancel { on_cancel: RunnerEvent },
    }

    impl Script {
        fn complete(response: &str) -> Self {
            Script::Complete {
                hook: None,
                response: response.to_string(),
            }
        }

        fn complete_after(
            hook: impl Fn(&StartSessionParams) + Send + Sync + 'static,
            response: &str,
        ) -> Self {
            Script::Complete {
                hook: Some(Box::new(hook)),
                response: response.to_string(),
            }
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    enum Call {
        Start(String, RunnerPermission),
        Cancel(String),
        Close(String),
        Shutdown,
    }

    struct Session {
        tx: Sender<RunnerEvent>,
        params: StartSessionParams,
        script: Option<Script>,
        on_cancel: Option<RunnerEvent>,
    }

    /// Scripted runner: sessions take scripts in start order (an unscripted
    /// session reports `attention`), and every call is recorded.
    struct FakeRunner {
        scripts: Mutex<VecDeque<Script>>,
        sessions: Mutex<HashMap<String, Session>>,
        calls: Mutex<Vec<Call>>,
        /// Receives the session id of every turn that waits for a cancel.
        waiting: Mutex<Sender<String>>,
    }

    impl FakeRunner {
        fn new() -> (Arc<FakeRunner>, Receiver<String>) {
            let (tx, rx) = mpsc::channel();
            let runner = FakeRunner {
                scripts: Mutex::new(VecDeque::new()),
                sessions: Mutex::new(HashMap::new()),
                calls: Mutex::new(Vec::new()),
                waiting: Mutex::new(tx),
            };
            (Arc::new(runner), rx)
        }

        fn script(&self, script: Script) {
            self.scripts.lock().unwrap().push_back(script);
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }

        fn starts(&self) -> Vec<RunnerPermission> {
            self.calls()
                .into_iter()
                .filter_map(|call| match call {
                    Call::Start(_, permission) => Some(permission),
                    _ => None,
                })
                .collect()
        }

        fn record(&self, call: Call) {
            self.calls.lock().unwrap().push(call);
        }
    }

    impl RunnerApi for FakeRunner {
        fn start_session(
            &self,
            params: StartSessionParams,
            _timeout: Duration,
        ) -> Result<(Receiver<RunnerEvent>, Option<String>), RunnerError> {
            self.record(Call::Start(params.session_id.clone(), params.permission));
            let script = self
                .scripts
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Script::complete(&attention("unscripted")));
            let (tx, rx) = mpsc::channel();
            self.sessions.lock().unwrap().insert(
                params.session_id.clone(),
                Session {
                    tx,
                    params,
                    script: Some(script),
                    on_cancel: None,
                },
            );
            Ok((rx, None))
        }

        fn send(
            &self,
            session_id: &str,
            _text: &str,
            _images: &[String],
        ) -> Result<(), RunnerError> {
            let (tx, params, script) = {
                let mut sessions = self.sessions.lock().unwrap();
                let session = sessions.get_mut(session_id).ok_or(RunnerError::Exited)?;
                (
                    session.tx.clone(),
                    session.params.clone(),
                    session.script.take(),
                )
            };
            match script {
                Some(Script::Complete { hook, response }) => {
                    if let Some(hook) = hook {
                        hook(&params);
                    }
                    let _ = tx.send(RunnerEvent::TurnCompleted {
                        final_response: response,
                        native_session_id: None,
                    });
                }
                Some(Script::WaitForCancel { on_cancel }) => {
                    if let Some(session) = self.sessions.lock().unwrap().get_mut(session_id) {
                        session.on_cancel = Some(on_cancel);
                    }
                    let _ = self.waiting.lock().unwrap().send(session_id.to_string());
                }
                None => {}
            }
            Ok(())
        }

        fn cancel(&self, session_id: &str) -> Result<(), RunnerError> {
            self.record(Call::Cancel(session_id.to_string()));
            let mut sessions = self.sessions.lock().unwrap();
            let session = sessions.get_mut(session_id).ok_or(RunnerError::Exited)?;
            if let Some(event) = session.on_cancel.take() {
                let _ = session.tx.send(event);
            }
            Ok(())
        }

        fn respond_permission(
            &self,
            _session_id: &str,
            _permission_id: &str,
            _allow: bool,
        ) -> Result<(), RunnerError> {
            Ok(())
        }

        fn close_session(&self, session_id: &str) -> Result<(), RunnerError> {
            self.record(Call::Close(session_id.to_string()));
            self.sessions.lock().unwrap().remove(session_id);
            Ok(())
        }

        fn probe(
            &self,
            _provider: Provider,
            _timeout: Duration,
        ) -> Result<serde_json::Value, RunnerError> {
            Err(RunnerError::Exited)
        }

        fn shutdown(&self) {
            self.record(Call::Shutdown);
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    enum Event {
        Task(String, TaskStatus),
        Run(String, RunStatus),
    }

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<Event>>,
        roots: Mutex<Vec<PathBuf>>,
    }

    impl RecordingSink {
        fn events(&self) -> Vec<Event> {
            self.events.lock().unwrap().clone()
        }

        fn task_events(&self) -> Vec<(String, TaskStatus)> {
            self.events()
                .into_iter()
                .filter_map(|event| match event {
                    Event::Task(id, status) => Some((id, status)),
                    Event::Run(..) => None,
                })
                .collect()
        }
    }

    impl EventSink for RecordingSink {
        fn task_changed(&self, project_root: &Path, task: &Task) {
            self.roots.lock().unwrap().push(project_root.to_path_buf());
            self.events
                .lock()
                .unwrap()
                .push(Event::Task(task.meta.id.clone(), task.meta.status));
        }

        fn run_changed(&self, project_root: &Path, run: &WorkflowRun) {
            self.roots.lock().unwrap().push(project_root.to_path_buf());
            self.events
                .lock()
                .unwrap()
                .push(Event::Run(run.root_task_id.clone(), run.status));
        }

        fn progress(
            &self,
            _project_root: &Path,
            _task_id: &str,
            _attempt_id: &str,
            _update: &ProgressUpdate,
        ) {
        }
        fn intake_changed(&self, _: &Path, _: &str, _: IntakeStatus, _: bool) {}

        fn workflows_changed(&self, _: &Path) {}
    }

    fn completed(body: &str) -> String {
        format!("---\noutcome: completed\n---\n\n{body}")
    }

    fn attention(reason: &str) -> String {
        format!("---\noutcome: attention\nreason: {reason}\n---\n\nstopped")
    }

    /// A repo fixture with one enabled standard workflow, a fake runner, a
    /// recording sink, and an orchestrator attached to the repo.
    struct Env {
        fx: Fixture,
        store: WorkflowStore,
        runner: Arc<FakeRunner>,
        waiting: Receiver<String>,
        sink: Arc<RecordingSink>,
        forge: Arc<FakeForge>,
        orch: Arc<Orchestrator>,
    }

    impl Env {
        fn new() -> Self {
            Self::with(|_| {})
        }

        fn with(edit: impl FnOnce(&mut Workflow)) -> Self {
            let fx = Fixture::new();
            let store = WorkflowStore::new(fx.root().to_path_buf());
            let mut workflow = standard_workflow("Standard", Provider::Codex);
            workflow.enabled = true;
            edit(&mut workflow);
            store
                .save_workflows(&WorkflowsFile {
                    schema_version: 1,
                    workflows: vec![workflow],
                })
                .unwrap();
            let (runner, waiting) = FakeRunner::new();
            let sink = Arc::new(RecordingSink::default());
            let forge = Arc::new(FakeForge::new());
            let orch = Orchestrator::new(
                runner.clone(),
                sink.clone(),
                forge.clone(),
                fx.base().to_path_buf(),
            );
            orch.attach_project(fx.root());
            Env {
                fx,
                store,
                runner,
                waiting,
                sink,
                forge,
                orch,
            }
        }

        fn workflow(&self) -> Workflow {
            self.store.load_workflows().unwrap().workflows[0].clone()
        }

        /// Creates an inbox root task of the (first) workflow.
        fn root_task(&self, title: &str, body: &str) -> Task {
            self.root_task_of(&self.workflow().id, title, body)
        }

        /// Creates an inbox root task of workflow `workflow_id`.
        fn root_task_of(&self, workflow_id: &str, title: &str, body: &str) -> Task {
            let id = new_id();
            let meta = TaskMeta {
                schema_version: 1,
                id: id.clone(),
                title: title.to_string(),
                status: TaskStatus::Inbox,
                root_id: id,
                parent_id: None,
                workflow_id: Some(workflow_id.to_string()),
                stage_id: None,
                role: None,
                auto_generated: false,
                archived: false,
                created_at: fsutil::now(),
                updated_at: fsutil::now(),
                attention: None,
                history: Vec::new(),
                awaiting: None,
                plan_approved: false,
                user_input: None,
                screening_ack: None,
                issue: None,
                pending_issue_entry: None,
            };
            self.store
                .create_task(&self.store.lock(), meta, body)
                .unwrap()
        }

        /// Sets a task's `created_at` (dispatch order is oldest first).
        fn set_created_at(&self, task: &Task, created_at: &str) {
            let mut task = self.task(&task.meta.id);
            task.meta.created_at = created_at.to_string();
            self.store.put_task(&self.store.lock(), &task).unwrap();
        }

        /// Runs the design stage of `root` directly through the flow (no
        /// orchestrator involved), leaving its run Active with an inbox
        /// implement child, which is returned.
        fn design_done_by_flow(&self, root: &Task) -> Task {
            let workflows = self.store.load_workflows().unwrap().workflows;
            let guard = self.store.lock();
            let begun = begin_attempt(
                &guard,
                &self.store,
                &workflows,
                &root.meta.id,
                self.fx.base(),
            )
            .unwrap();
            let BeginResult::Started(planned) = begun else {
                panic!("expected Started, got {begun:?}");
            };
            let response = completed("# Design");
            let req = &planned.request;
            self.store
                .write_attempt_output(&req.root_task_id, &req.task_id, &req.attempt_id, &response)
                .unwrap();
            let input = FinishInput {
                end: AttemptEnd::Completed {
                    final_response: response,
                },
                check: CheckResult {
                    after: None,
                    reason: None,
                },
                issue_sync_error: None,
            };
            let summary = finish_attempt(&guard, &self.store, &planned, input).unwrap();
            let child = summary.changed_tasks.last().unwrap().clone();
            assert_eq!(child.meta.role, Some(Role::Implement));
            assert_eq!(child.meta.status, TaskStatus::Inbox);
            child
        }

        fn kick(&self) {
            self.orch.kick(self.fx.root());
        }

        fn wait_idle(&self) {
            assert!(self.orch.wait_idle(WAIT), "orchestrator did not go idle");
        }

        /// Blocks until a scripted turn waits for its cancel.
        fn wait_for_waiting_turn(&self) -> String {
            self.waiting.recv_timeout(WAIT).expect("no turn is waiting")
        }

        fn task(&self, id: &str) -> Task {
            self.store.get_task(id).unwrap()
        }

        fn tasks(&self) -> Vec<Task> {
            self.store.list_tasks().unwrap().tasks
        }

        fn run(&self, root_id: &str) -> WorkflowRun {
            self.store.get_run(root_id).unwrap()
        }
    }

    fn attention_code(task: &Task) -> String {
        task.meta.attention.as_ref().unwrap().code.clone()
    }

    #[test]
    fn root_task_runs_through_all_stages_to_awaiting_merge() {
        let env = Env::new();
        env.runner
            .script(Script::complete(&completed("# Design\nthe plan")));
        env.runner.script(Script::complete_after(
            |params| {
                let wt = Path::new(&params.working_directory);
                gitops::test_support::write_file(wt, "feature.txt", "brand new line\n");
                gitops::git(wt, &["add", "feature.txt"]).unwrap();
                gitops::git(wt, &["commit", "-m", "add feature"]).unwrap();
            },
            &completed("Implemented feature.txt"),
        ));
        env.runner
            .script(Script::complete(&completed("Looks good.")));
        let root = env.root_task("Feature", "Build it.");

        env.kick();
        env.wait_idle();

        let run = env.run(&root.meta.id);
        assert_eq!(run.status, RunStatus::AwaitingMerge);
        let tasks = env.tasks();
        assert_eq!(tasks.len(), 3);
        let roles: Vec<_> = tasks.iter().map(|t| t.meta.role).collect();
        assert_eq!(roles, [None, Some(Role::Implement), Some(Role::Review)]);
        assert!(tasks.iter().all(|t| t.meta.status == TaskStatus::Completed));
        assert_eq!(
            env.runner.starts(),
            [
                RunnerPermission::ReadOnly,
                RunnerPermission::FullAccess,
                RunnerPermission::ReadOnly
            ]
        );
        let outcomes: Vec<_> = run
            .attempts
            .iter()
            .map(|a| a.outcome.as_deref().unwrap().to_string())
            .collect();
        assert_eq!(outcomes, ["completed", "completed", "completed"]);

        let (design, implement, review) = (&tasks[0].meta.id, &tasks[1].meta.id, &tasks[2].meta.id);
        let expected = [
            (design, TaskStatus::Running),
            (design, TaskStatus::Completed),
            (implement, TaskStatus::Inbox),
            (implement, TaskStatus::Running),
            (implement, TaskStatus::Completed),
            (review, TaskStatus::Inbox),
            (review, TaskStatus::Running),
            (review, TaskStatus::Completed),
        ]
        .map(|(id, status)| (id.clone(), status));
        assert_eq!(env.sink.task_events(), expected);
        assert_eq!(
            env.sink.events().last(),
            Some(&Event::Run(root.meta.id.clone(), RunStatus::AwaitingMerge))
        );
        // Events carry the attached project root.
        let project = env.orch.store(env.fx.root()).project_root().to_path_buf();
        assert!(env.sink.roots.lock().unwrap().iter().all(|r| *r == project));
        assert!(!env.orch.is_active(design));
    }

    const OLDEST: &str = "2000-01-01T00:00:00.000Z";

    #[test]
    fn concurrency_limit_counts_active_runs_and_never_blocks_an_existing_run() {
        let env = Env::new();
        assert_eq!(env.workflow().max_concurrent_runs, 1);
        let a = env.root_task("A", "a");
        let b = env.root_task("B", "b");
        // B is considered first in every pass.
        env.set_created_at(&b, OLDEST);
        let implement = env.design_done_by_flow(&a);
        env.runner
            .script(Script::complete(&completed("Implemented.")));
        env.runner
            .script(Script::complete(&completed("Looks good.")));

        env.kick();
        env.wait_idle();

        // A's run was Active until its review completed: B waited for it.
        let run_a = env.run(&a.meta.id);
        assert_eq!(run_a.status, RunStatus::AwaitingMerge);
        let run_b = env.run(&b.meta.id);
        let session = |run: &WorkflowRun, i: usize| run.attempts[i].session_id.clone();
        assert_eq!(run_a.attempts[1].task_id, implement.meta.id);
        assert_eq!(
            env.runner.calls(),
            [
                Call::Start(session(&run_a, 1), RunnerPermission::FullAccess),
                Call::Close(session(&run_a, 1)),
                Call::Start(session(&run_a, 2), RunnerPermission::ReadOnly),
                Call::Close(session(&run_a, 2)),
                Call::Start(session(&run_b, 0), RunnerPermission::ReadOnly),
                Call::Close(session(&run_b, 0)),
            ]
        );
    }

    #[test]
    fn runs_started_in_a_pass_count_against_the_limit() {
        let env = Env::new();
        let first = env.root_task("First", "one");
        let second = env.root_task("Second", "two");
        env.set_created_at(&first, OLDEST);

        env.kick();
        env.wait_idle();

        // The first run stays Active (its task needs attention), so the
        // second root never gets a run.
        assert_eq!(env.run(&first.meta.id).status, RunStatus::Active);
        assert_eq!(env.runner.starts().len(), 1);
        assert_eq!(env.task(&second.meta.id).meta.status, TaskStatus::Inbox);
        assert_eq!(
            env.store.get_run(&second.meta.id).unwrap_err(),
            crate::workflow::store::StoreError::NotFound
        );
    }

    #[test]
    fn a_panicked_pass_honours_a_pending_request_once() {
        let key = PathBuf::from("project");
        let mut inner = Inner::default();
        inner.projects.insert(
            key.clone(),
            Project {
                root: key.clone(),
                dispatching: false,
                dirty: false,
            },
        );
        assert!(inner.request_dispatch(&key));
        assert!(!inner.request_dispatch(&key));
        assert!(inner.abort_pass(&key), "pending request: one new thread");
        assert!(!inner.is_idle());
        assert!(!inner.abort_pass(&key), "nothing pending: no new thread");
        assert!(inner.is_idle());
        assert!(inner.request_dispatch(&key));
        assert!(!inner.request_dispatch(&key));
        inner.shut_down = true;
        assert!(!inner.abort_pass(&key), "no new thread after shutdown");
        assert!(inner.is_idle());
    }

    #[test]
    fn an_existing_run_uses_its_workflow_snapshot() {
        let env = Env::new();
        let a = env.root_task("A", "a");
        let implement = env.design_done_by_flow(&a);
        // Replace the workflow: A's snapshot id is no longer in the file.
        let mut other = standard_workflow("Other", Provider::Codex);
        other.enabled = true;
        env.store
            .save_workflows(&WorkflowsFile {
                schema_version: 1,
                workflows: vec![other.clone()],
            })
            .unwrap();
        let c = env.root_task_of(&other.id, "C", "c");
        let d = env.root_task_of(&other.id, "D", "d");
        env.set_created_at(&c, OLDEST);

        env.kick();
        env.wait_idle();

        // A's child ran under the snapshot (not parked as missing).
        let implement = env.task(&implement.meta.id);
        assert_eq!(attention_code(&implement), "ATTENTION_STAGE_REPORTED");
        assert_eq!(env.run(&a.meta.id).attempts.len(), 2);
        // A's run counts for its snapshot id only: C started, and C's run
        // blocks D under the new workflow's limit of 1.
        assert_eq!(env.run(&c.meta.id).attempts.len(), 1);
        assert_eq!(env.task(&d.meta.id).meta.status, TaskStatus::Inbox);
        assert_eq!(
            env.store.get_run(&d.meta.id).unwrap_err(),
            crate::workflow::store::StoreError::NotFound
        );
    }

    #[test]
    fn a_request_after_the_last_pass_is_never_lost() {
        let key = PathBuf::from("project");
        let mut inner = Inner::default();
        inner.projects.insert(
            key.clone(),
            Project {
                root: key.clone(),
                dispatching: false,
                dirty: false,
            },
        );
        assert!(
            inner.request_dispatch(&key),
            "first request starts a thread"
        );
        assert!(!inner.request_dispatch(&key), "coalesced while dispatching");
        assert!(inner.finish_pass(&key), "the coalesced request runs a pass");
        assert!(!inner.finish_pass(&key));
        assert!(
            inner.is_idle(),
            "the thread cleared its flag on its way out"
        );
        // A request right after the thread's final check starts a new one.
        assert!(inner.request_dispatch(&key));
        // A request still pending when shutdown starts is dropped.
        assert!(!inner.request_dispatch(&key));
        inner.shut_down = true;
        assert!(!inner.finish_pass(&key));
        assert!(inner.is_idle());
        assert!(!inner.request_dispatch(&key));
    }

    #[test]
    fn user_commit_to_base_branch_mid_turn_needs_attention_and_retry_succeeds() {
        let env = Env::new();
        let repo = env.fx.root().to_path_buf();
        env.runner.script(Script::complete_after(
            move |_| {
                gitops::test_support::write_file(&repo, "user.txt", "user work\n");
                gitops::git(&repo, &["add", "user.txt"]).unwrap();
                gitops::git(&repo, &["commit", "-m", "user commit"]).unwrap();
            },
            &completed("# Design"),
        ));
        let root = env.root_task("Feature", "Build it.");

        env.kick();
        env.wait_idle();

        let task = env.task(&root.meta.id);
        assert_eq!(task.meta.status, TaskStatus::Attention);
        assert_eq!(attention_code(&task), "ATTENTION_INTEGRITY_CHANGED");
        let items: serde_json::Value =
            serde_json::from_str(&task.meta.attention.as_ref().unwrap().params["items"]).unwrap();
        assert!(
            items
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["code"] == "INTEGRITY_BASE_BRANCH_MOVED"),
            "{items}"
        );
        assert_eq!(env.tasks().len(), 1, "no child task on an integrity change");

        // Retry: a fresh baseline is taken and the stage succeeds.
        transition(
            &env.store,
            &root.meta.id,
            TaskStatus::Attention,
            TaskStatus::Inbox,
            None,
        )
        .unwrap();
        env.runner
            .script(Script::complete(&completed("# Design again")));
        env.kick();
        env.wait_idle();

        assert_eq!(env.task(&root.meta.id).meta.status, TaskStatus::Completed);
        let tasks = env.tasks();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[1].meta.role, Some(Role::Implement));
        // The user's commit is still on main.
        assert!(env
            .fx
            .run(&["log", "--format=%s", "main"])
            .contains("user commit"));
    }

    #[test]
    fn hold_while_the_agent_finishes_keeps_the_task_on_hold() {
        let env = Env::new();
        env.runner.script(Script::WaitForCancel {
            on_cancel: RunnerEvent::TurnCompleted {
                final_response: completed("# Design"),
                native_session_id: None,
            },
        });
        let root = env.root_task("Feature", "Build it.");
        let id = root.meta.id.clone();

        env.kick();
        let session = env.wait_for_waiting_turn();
        assert!(env.orch.is_active(&id));
        transition(
            &env.store,
            &id,
            TaskStatus::Running,
            TaskStatus::OnHold,
            None,
        )
        .unwrap();
        assert!(env.orch.cancel_task(&id, CancelReason::User));
        env.wait_idle();

        assert_eq!(env.task(&id).meta.status, TaskStatus::OnHold);
        assert_eq!(env.tasks().len(), 1, "no child task");
        let attempt = env.run(&id).attempts.last().unwrap().clone();
        assert_eq!(attempt.outcome.as_deref(), Some("cancelled"));
        assert!(attempt.finished_at.is_some());
        assert!(env.runner.calls().contains(&Call::Cancel(session)));
        assert!(!env.orch.is_active(&id));
        assert!(!env.orch.cancel_task(&id, CancelReason::User));
    }

    #[test]
    fn different_spellings_share_one_project_and_concurrent_kicks_start_once() {
        let env = Env::new();
        let key = env.orch.attach_project(env.fx.root());
        assert_eq!(env.orch.attach_project(&env.fx.root().join("")), key);
        if cfg!(windows) {
            let upper = PathBuf::from(env.fx.root().to_string_lossy().to_uppercase());
            assert_eq!(env.orch.attach_project(&upper), key);
            let verbatim = PathBuf::from(format!(
                r"\\?\{}",
                crate::workflow::state::normalize_root(env.fx.root()).display()
            ));
            assert_eq!(env.orch.attach_project(&verbatim), key);
        }

        // Only the first attach of a key reports attaching it.
        assert!(!env.orch.attach(&env.fx.root().join("")).1);

        // Later attaches do not treat running tasks as interrupted.
        let running = env.root_task("Running", "r");
        transition(
            &env.store,
            &running.meta.id,
            TaskStatus::Inbox,
            TaskStatus::Running,
            None,
        )
        .unwrap();
        env.orch.attach_project(&env.fx.root().join(""));
        assert_eq!(env.task(&running.meta.id).meta.status, TaskStatus::Running);

        let task = env.root_task("Feature", "Build it.");
        let barrier = Arc::new(Barrier::new(2));
        let kicks: Vec<_> = [env.fx.root().to_path_buf(), env.fx.root().join("")]
            .into_iter()
            .map(|root| {
                let orch = env.orch.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    orch.kick(&root);
                })
            })
            .collect();
        for kick in kicks {
            kick.join().unwrap();
        }
        env.wait_idle();

        assert_eq!(env.runner.starts().len(), 1);
        assert_eq!(env.run(&task.meta.id).attempts.len(), 1);
        assert_eq!(env.task(&task.meta.id).meta.status, TaskStatus::Attention);
    }

    #[test]
    fn shutdown_cancels_the_attempt_and_next_start_marks_it_interrupted() {
        let env = Env::new();
        env.runner.script(Script::WaitForCancel {
            on_cancel: RunnerEvent::TurnCancelled,
        });
        let root = env.root_task("Feature", "Build it.");
        let id = root.meta.id.clone();

        env.kick();
        let session = env.wait_for_waiting_turn();
        env.orch.shutdown(WAIT);

        assert!(!env.orch.is_active(&id));
        let calls = env.runner.calls();
        let cancel = calls
            .iter()
            .position(|c| *c == Call::Cancel(session.clone()));
        let close = calls
            .iter()
            .position(|c| *c == Call::Close(session.clone()));
        assert!(cancel.is_some() && close.is_some());
        assert_eq!(calls.last(), Some(&Call::Shutdown));
        assert_eq!(env.task(&id).meta.status, TaskStatus::Running);
        let attempt = env.run(&id).attempts.last().unwrap().clone();
        assert_eq!(attempt.outcome.as_deref(), Some("cancelled"));

        // Kicks after shutdown are ignored.
        let other = env.root_task("Other", "o");
        env.kick();
        env.wait_idle();
        assert_eq!(env.runner.starts().len(), 1);
        assert_eq!(env.task(&other.meta.id).meta.status, TaskStatus::Inbox);

        // The next start (a new orchestrator) interrupts the running task.
        let (runner, _waiting) = FakeRunner::new();
        let sink = Arc::new(RecordingSink::default());
        let next = Orchestrator::new(
            runner.clone(),
            sink.clone(),
            Arc::new(FakeForge::new()),
            env.fx.base().to_path_buf(),
        );
        assert!(next.attach(env.fx.root()).1);
        let task = env.task(&id);
        assert_eq!(task.meta.status, TaskStatus::Attention);
        assert_eq!(attention_code(&task), "ATTENTION_INTERRUPTED");
        assert!(sink
            .task_events()
            .contains(&(id.clone(), TaskStatus::Attention)));
        assert!(runner.calls().is_empty());
    }

    #[test]
    fn a_panicking_attempt_finishes_as_failed_and_does_not_stay_active() {
        let env = Env::new();
        env.runner.script(Script::complete_after(
            |_| panic!("scripted panic"),
            &completed("# Design"),
        ));
        let root = env.root_task("Feature", "Build it.");
        let id = root.meta.id.clone();

        env.kick();
        env.wait_idle();

        assert!(!env.orch.is_active(&id));
        let task = env.task(&id);
        assert_eq!(task.meta.status, TaskStatus::Attention);
        assert_eq!(attention_code(&task), "ATTENTION_ATTEMPT_FAILED");
        let params = &task.meta.attention.as_ref().unwrap().params;
        assert_eq!(params["code"], WORKFLOW_ATTEMPT_PANICKED);
        assert_eq!(params["message"], "scripted panic");
        let attempt = env.run(&id).attempts[0].clone();
        assert_eq!(attempt.outcome.as_deref(), Some("failed"));
        assert!(env
            .runner
            .calls()
            .contains(&Call::Close(attempt.session_id.clone())));

        // The orchestrator keeps working after the panic.
        transition(
            &env.store,
            &id,
            TaskStatus::Attention,
            TaskStatus::Inbox,
            None,
        )
        .unwrap();
        env.kick();
        env.wait_idle();
        assert_eq!(env.run(&id).attempts.len(), 2);
    }

    #[test]
    fn a_failed_finish_moves_the_running_task_to_attention() {
        let env = Env::new();
        let root = env.root_task("Feature", "Build it.");
        let id = root.meta.id.clone();
        let run_file = env
            .fx
            .root()
            .join(".mdium")
            .join("runs")
            .join(format!("{id}.json"));
        // The run becomes unreadable mid-turn, so the finish cannot load it.
        env.runner.script(Script::complete_after(
            move |_| std::fs::write(&run_file, "not json").unwrap(),
            &completed("# Design"),
        ));

        env.kick();
        env.wait_idle();

        let task = env.task(&id);
        assert_eq!(task.meta.status, TaskStatus::Attention);
        assert_eq!(attention_code(&task), "ATTENTION_ATTEMPT_FAILED");
        assert_eq!(
            task.meta.attention.as_ref().unwrap().params["code"],
            "STORE_CORRUPT"
        );
        assert!(env
            .sink
            .task_events()
            .contains(&(id.clone(), TaskStatus::Attention)));
        assert!(!env.orch.is_active(&id));
    }

    #[test]
    fn an_unacknowledged_config_change_stops_the_next_attempt_until_accepted() {
        let env = Env::new();
        let root = env.root_task("Feature", "Build it.");
        let implement = env.design_done_by_flow(&root);
        // The acknowledged baseline, then a git config change nobody
        // acknowledged (as when the attempt that saw it was put on hold
        // and its attention reason was dropped).
        {
            let mut run = env.run(&root.meta.id);
            run.integrity_baseline = Some(checks::baseline(env.fx.root(), &run).unwrap());
            env.store.put_run(&env.store.lock(), &run).unwrap();
        }
        env.fx.run(&["config", "core.fsmonitor", "false"]);

        env.kick();
        env.wait_idle();

        assert!(env.runner.starts().is_empty(), "no session may start");
        let task = env.task(&implement.meta.id);
        assert_eq!(task.meta.status, TaskStatus::Attention);
        assert_eq!(attention_code(&task), "ATTENTION_INTEGRITY_CHANGED");
        let items = &task.meta.attention.as_ref().unwrap().params["items"];
        assert!(items.contains("INTEGRITY_GIT_CONFIG_CHANGED"), "{items}");

        // A plain retry is refused; accepting the change lets it run.
        assert_eq!(
            crate::workflow::actions::retry_task(
                &env.orch,
                env.fx.root(),
                &implement.meta.id,
                crate::workflow::actions::RetryOptions::default(),
            )
            .unwrap_err()
            .code(),
            "WORKFLOW_INTEGRITY_ACK_REQUIRED"
        );
        env.runner
            .script(Script::complete(&completed("Implemented.")));
        crate::workflow::actions::retry_task(
            &env.orch,
            env.fx.root(),
            &implement.meta.id,
            crate::workflow::actions::RetryOptions {
                accept_integrity: true,
                ..Default::default()
            },
        )
        .unwrap();
        env.wait_idle();
        assert!(!env.runner.starts().is_empty());
        assert_eq!(
            env.task(&implement.meta.id).meta.status,
            TaskStatus::Completed
        );
    }

    #[test]
    fn shutdown_waits_for_the_cancel_grace_and_the_finish() {
        assert!(SHUTDOWN_WAIT >= CANCEL_GRACE + Duration::from_secs(2));
    }

    const ISSUE: u64 = 7;

    fn issue_ref() -> IssueRef {
        IssueRef {
            kind: ForgeKind::GitHub,
            host: "github.com".to_string(),
            path: "owner/repo".to_string(),
            number: ISSUE,
            url: "https://github.com/owner/repo/issues/7".to_string(),
        }
    }

    /// An environment whose workflow tracks Issues automatically.
    fn tracked_env(edit: impl FnOnce(&mut Workflow)) -> Env {
        Env::with(|workflow| {
            workflow.issue_tracking = IssueTracking::Auto;
            edit(workflow);
        })
    }

    /// Creates an inbox root task linked to Issue #7.
    fn tracked_root(env: &Env) -> Task {
        let root = env.root_task("Feature", "Build it.");
        let mut task = env.task(&root.meta.id);
        task.meta.issue = Some(issue_ref());
        env.store.put_task(&env.store.lock(), &task).unwrap()
    }

    /// The comment bodies of Issue #7.
    fn comment_bodies(env: &Env) -> Vec<String> {
        env.forge
            .comments(ISSUE)
            .into_iter()
            .map(|comment| comment.body)
            .collect()
    }

    /// The entry id of the `index`-th attempt of `root_id`'s run.
    fn entry_of(env: &Env, root_id: &str, index: usize) -> String {
        let attempt = env.run(root_id).attempts[index].clone();
        issue_sync::entry_id(&attempt.task_id, &attempt.attempt_id)
    }

    /// Runs the design stage of a tracked root task with the forge's
    /// comment listing failing, so the stage ends in
    /// `ATTENTION_ISSUE_SYNC_FAILED`.
    fn design_with_failed_sync(env: &Env, op: FakeOp) -> Task {
        env.forge.set_failure(op, Some(ForgeError::Timeout));
        env.runner
            .script(Script::complete(&completed("# Design\nthe plan")));
        let root = tracked_root(env);
        env.kick();
        env.wait_idle();
        let task = env.task(&root.meta.id);
        assert_eq!(task.meta.status, TaskStatus::Attention);
        assert_eq!(attention_code(&task), "ATTENTION_ISSUE_SYNC_FAILED");
        let params = &task.meta.attention.as_ref().unwrap().params;
        assert_eq!(params["code"], "FORGE_TIMEOUT");
        assert_eq!(params["entry"], "design");
        assert_eq!(task.meta.pending_issue_entry.as_deref(), Some("design"));
        assert_eq!(env.tasks().len(), 1, "no child task");
        env.forge.set_failure(op, None);
        env.forge.clear_calls();
        task
    }

    #[test]
    fn a_completed_design_posts_one_issue_entry_before_the_implement_stage_starts() {
        let env = tracked_env(|_| {});
        let forge = env.forge.clone();
        let seen = Arc::new(Mutex::new(None));
        let seen_in_hook = seen.clone();
        env.runner
            .script(Script::complete(&completed("# Design\nthe plan")));
        env.runner.script(Script::complete_after(
            move |_| *seen_in_hook.lock().unwrap() = Some(forge.comments(ISSUE).len()),
            &attention("stop here"),
        ));
        let root = tracked_root(&env);

        env.kick();
        env.wait_idle();

        assert_eq!(*seen.lock().unwrap(), Some(1), "posted before implement");
        let bodies = comment_bodies(&env);
        assert_eq!(bodies.len(), 1);
        let entry = entry_of(&env, &root.meta.id, 0);
        assert!(bodies[0].starts_with("## Design"), "{}", bodies[0]);
        assert!(bodies[0].contains("the plan"));
        assert!(bodies[0].ends_with(&issue_sync::marker(&entry)));
        assert_eq!(
            env.forge.calls(),
            [
                ForgeCall::ListComments(ISSUE),
                ForgeCall::AddComment {
                    number: ISSUE,
                    body: bodies[0].clone()
                }
            ]
        );
        assert_eq!(env.task(&root.meta.id).meta.status, TaskStatus::Completed);
        assert_eq!(env.runner.starts().len(), 2);
    }

    #[test]
    fn a_post_that_already_landed_is_not_repeated_and_the_retry_advances() {
        let env = tracked_env(|_| {});
        let root = design_with_failed_sync(&env, FakeOp::ListComments);
        let id = root.meta.id.clone();
        // The comment landed before the failure was reported (as after a
        // crash or a timeout between posting and advancing).
        let entry = entry_of(&env, &id, 0);
        let landed = issue_sync::design_body("# Design\nthe plan", &entry);
        env.forge.set_comments(ISSUE, &[&landed]);

        crate::workflow::actions::retry_issue_sync(&env.orch, env.fx.root(), &id, false).unwrap();
        env.wait_idle();

        assert_eq!(env.forge.calls(), [ForgeCall::ListComments(ISSUE)]);
        assert_eq!(comment_bodies(&env), [landed]);
        let task = env.task(&id);
        assert_eq!(task.meta.status, TaskStatus::Completed);
        assert_eq!(task.meta.pending_issue_entry, None);
        let tasks = env.tasks();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[1].meta.role, Some(Role::Implement));
    }

    #[test]
    fn a_failed_sync_commits_no_design_doc_until_the_retry_posts_and_advances() {
        let env = tracked_env(|w| w.design_doc_path = Some("docs/{slug}-design.md".into()));
        let root = design_with_failed_sync(&env, FakeOp::AddComment);
        let id = root.meta.id.clone();
        let info = env.run(&id).worktree.unwrap();
        let wt = Path::new(&info.path);
        let doc = wt.join("docs/feature-design.md");
        assert!(!doc.exists(), "no design doc before the sync");
        let log = gitops::git(wt, &["log", "--format=%s"]).unwrap();
        assert!(!log.contains("docs: design for"), "{log}");

        // A retry that fails again leaves everything as it was.
        env.forge
            .set_failure(FakeOp::AddComment, Some(ForgeError::NotAuthenticated));
        let err = crate::workflow::actions::retry_issue_sync(&env.orch, env.fx.root(), &id, false)
            .unwrap_err();
        assert_eq!(err.code(), "FORGE_NOT_AUTHENTICATED");
        assert_eq!(env.tasks().len(), 1);
        assert!(!doc.exists());
        env.forge.set_failure(FakeOp::AddComment, None);

        crate::workflow::actions::retry_issue_sync(&env.orch, env.fx.root(), &id, false).unwrap();
        env.wait_idle();

        let bodies = comment_bodies(&env);
        assert_eq!(bodies.len(), 1);
        assert!(bodies[0].ends_with(&issue_sync::marker(&entry_of(&env, &id, 0))));
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "# Design\nthe plan");
        let log = gitops::git(wt, &["log", "--format=%s"]).unwrap();
        assert!(log.contains("docs: design for Feature"), "{log}");
        let task = env.task(&id);
        assert_eq!(task.meta.status, TaskStatus::Completed);
        assert_eq!(task.meta.pending_issue_entry, None);
        assert_eq!(env.tasks().len(), 2);
    }

    #[test]
    fn skipping_the_sync_advances_without_any_forge_call() {
        let env = tracked_env(|_| {});
        let root = design_with_failed_sync(&env, FakeOp::ListComments);
        let id = root.meta.id.clone();

        crate::workflow::actions::skip_issue_sync(&env.orch, env.fx.root(), &id, false).unwrap();
        env.wait_idle();

        // The implement attempt (unscripted: attention) posts nothing.
        assert!(env.forge.calls().is_empty(), "{:?}", env.forge.calls());
        assert!(env.forge.comments(ISSUE).is_empty());
        let task = env.task(&id);
        assert_eq!(task.meta.status, TaskStatus::Completed);
        assert_eq!(task.meta.pending_issue_entry, None);
        let tasks = env.tasks();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[1].meta.role, Some(Role::Implement));
    }

    #[test]
    fn returned_review_findings_post_a_returned_entry_then_re_enter() {
        let env = tracked_env(|_| {});
        env.runner
            .script(Script::complete(&completed("# Design\nthe plan")));
        env.runner.script(Script::complete_after(
            |params| {
                let wt = Path::new(&params.working_directory);
                gitops::test_support::write_file(wt, "feature.txt", "brand new line\n");
                gitops::git(wt, &["add", "feature.txt"]).unwrap();
                gitops::git(wt, &["commit", "-m", "add feature"]).unwrap();
            },
            &completed("Implemented feature.txt"),
        ));
        env.runner.script(Script::complete(
            "---\noutcome: attention\nreason: issues found\n---\n\nFix X.",
        ));
        let root = tracked_root(&env);

        env.kick();
        env.wait_idle();

        let run = env.run(&root.meta.id);
        assert_eq!(run.reentry_count, 1);
        let tasks = env.tasks();
        assert_eq!(tasks.len(), 4);
        assert_eq!(tasks[2].meta.status, TaskStatus::Completed);
        assert_eq!(tasks[3].meta.role, Some(run.workflow.review_return_to));
        assert!(tasks[3].body.contains("Fix X."));

        let bodies = comment_bodies(&env);
        assert_eq!(bodies.len(), 3, "{bodies:?}");
        let info = run.worktree.clone().unwrap();
        assert!(bodies[1].starts_with("## Implementation"));
        assert!(bodies[1].contains(&format!("`{}`", info.branch)));
        assert!(bodies[1].contains("add feature"));
        assert!(bodies[1].ends_with(&issue_sync::marker(&entry_of(&env, &root.meta.id, 1))));
        assert!(bodies[2].starts_with("## Review"));
        assert!(bodies[2].contains("Result: findings returned for rework."));
        assert!(bodies[2].contains("Fix X."));
        assert!(bodies[2].ends_with(&issue_sync::marker(&entry_of(&env, &root.meta.id, 2))));
    }

    #[test]
    fn runs_without_auto_tracking_or_an_issue_make_no_forge_calls() {
        for tracking in [IssueTracking::Off, IssueTracking::Auto] {
            let env = Env::with(|w| w.issue_tracking = tracking);
            env.runner.script(Script::complete(&completed("# Design")));
            env.runner
                .script(Script::complete(&completed("Implemented.")));
            env.runner
                .script(Script::complete(&completed("Looks good.")));
            // Off: linked to an Issue; Auto: no Issue.
            let root = if tracking == IssueTracking::Off {
                tracked_root(&env)
            } else {
                env.root_task("Feature", "Build it.")
            };

            env.kick();
            env.wait_idle();

            assert_eq!(env.run(&root.meta.id).status, RunStatus::AwaitingMerge);
            assert!(env.forge.calls().is_empty(), "{tracking:?}");
        }
    }

    #[test]
    fn an_approved_review_posts_an_approved_entry() {
        let env = tracked_env(|_| {});
        env.runner.script(Script::complete(&completed("# Design")));
        env.runner
            .script(Script::complete(&completed("Implemented.")));
        env.runner
            .script(Script::complete(&completed("Looks good.")));
        let root = tracked_root(&env);

        env.kick();
        env.wait_idle();

        assert_eq!(env.run(&root.meta.id).status, RunStatus::AwaitingMerge);
        let bodies = comment_bodies(&env);
        assert_eq!(bodies.len(), 3);
        assert!(bodies[1].contains("No commits"));
        assert!(bodies[2].contains("Result: Approved."));
        assert!(bodies[2].contains("Looks good."));
        // Every finish cleared its attempt's sync mark.
        let run = env.run(&root.meta.id);
        assert!(run.attempts.iter().all(|a| a.issue_sync_pending.is_none()));
    }

    #[test]
    fn a_crash_after_the_post_is_recovered_without_a_second_comment() {
        let env = tracked_env(|_| {});
        let root = tracked_root(&env);
        let id = root.meta.id.clone();
        // The design attempt ends, its output is saved, it is marked as
        // syncing and its entry lands; then the app dies before the finish.
        let workflows = env.store.load_workflows().unwrap().workflows;
        let begun = begin_attempt(
            &env.store.lock(),
            &env.store,
            &workflows,
            &id,
            env.fx.base(),
        )
        .unwrap();
        let BeginResult::Started(planned) = begun else {
            panic!("expected Started, got {begun:?}");
        };
        let req = &planned.request;
        env.store
            .write_attempt_output(
                &req.root_task_id,
                &req.task_id,
                &req.attempt_id,
                &completed("# Design\nthe plan"),
            )
            .unwrap();
        flow::mark_issue_sync_pending(
            &env.store.lock(),
            &env.store,
            &id,
            &req.attempt_id,
            EntryKind::Design,
        )
        .unwrap();
        let entry = issue_sync::entry_id(&id, &req.attempt_id);
        let posted = issue_sync::design_body("# Design\nthe plan", &entry);
        env.forge.set_comments(ISSUE, &[&posted]);
        assert_eq!(env.task(&id).meta.status, TaskStatus::Running);

        // The next start recovers the task as an interrupted sync.
        let (runner, _waiting) = FakeRunner::new();
        let next = Orchestrator::new(
            runner,
            Arc::new(RecordingSink::default()),
            env.forge.clone(),
            env.fx.base().to_path_buf(),
        );
        assert!(next.attach(env.fx.root()).1);
        let task = env.task(&id);
        assert_eq!(attention_code(&task), "ATTENTION_ISSUE_SYNC_FAILED");
        let params = &task.meta.attention.as_ref().unwrap().params;
        assert_eq!(params["code"], WORKFLOW_ISSUE_SYNC_INTERRUPTED);
        assert_eq!(params["entry"], "design");
        assert_eq!(task.meta.pending_issue_entry.as_deref(), Some("design"));
        let attempt = env.run(&id).attempts[0].clone();
        assert_eq!(attempt.outcome.as_deref(), Some("completed"));
        assert!(attempt.finished_at.is_some());
        assert_eq!(attempt.issue_sync_pending, None);

        // The retry finds the landed entry by its marker and advances.
        env.forge.clear_calls();
        crate::workflow::actions::retry_issue_sync(&next, env.fx.root(), &id, false).unwrap();
        assert!(next.wait_idle(WAIT));
        assert_eq!(env.forge.calls(), [ForgeCall::ListComments(ISSUE)]);
        assert_eq!(comment_bodies(&env), [posted]);
        let task = env.task(&id);
        assert_eq!(task.meta.status, TaskStatus::Completed);
        assert_eq!(task.meta.pending_issue_entry, None);
        let tasks = env.tasks();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[1].meta.role, Some(Role::Implement));
    }

    #[test]
    fn a_shutdown_right_after_the_turn_parks_the_sync_without_posting() {
        let env = tracked_env(|_| {});
        let orch = env.orch.clone();
        env.runner.script(Script::complete_after(
            move |_| orch.mark_shut_down(),
            &completed("# Design\nthe plan"),
        ));
        let root = tracked_root(&env);
        let id = root.meta.id.clone();

        env.kick();
        env.wait_idle();

        assert!(env.forge.calls().is_empty(), "{:?}", env.forge.calls());
        let task = env.task(&id);
        assert_eq!(attention_code(&task), "ATTENTION_ISSUE_SYNC_FAILED");
        let params = &task.meta.attention.as_ref().unwrap().params;
        assert_eq!(params["code"], WORKFLOW_ISSUE_SYNC_INTERRUPTED);
        assert_eq!(task.meta.pending_issue_entry.as_deref(), Some("design"));
        assert_eq!(env.tasks().len(), 1);
        assert_eq!(env.run(&id).attempts[0].issue_sync_pending, None);

        crate::workflow::actions::retry_issue_sync(&env.orch, env.fx.root(), &id, false).unwrap();
        assert_eq!(comment_bodies(&env).len(), 1);
        assert_eq!(env.task(&id).meta.status, TaskStatus::Completed);
        assert_eq!(env.tasks().len(), 2);
    }
}

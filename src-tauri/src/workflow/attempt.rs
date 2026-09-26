//! Runs one stage attempt through the workflow runner: starts a guarded
//! session in the run's worktree, sends the stage prompt, and waits for the
//! turn to end while logging every event, denying permission requests,
//! forwarding throttled progress, and honouring cancellation and the
//! stage timeout.

use crate::workflow::model::Provider;
use crate::workflow::runner_client::{
    RunnerError, RunnerEvent, RunnerPermission, StartSessionParams,
};
use crate::workflow::runner_host::RunnerApi;
use crate::workflow::store::WorkflowStore;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Why an attempt was cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    User,
    Shutdown,
}

const CANCEL_NONE: u8 = 0;
const CANCEL_USER: u8 = 1;
const CANCEL_SHUTDOWN: u8 = 2;

/// Shared cancellation flag for a running attempt. The first reason set
/// wins; later calls to [`CancelToken::cancel`] are ignored.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicU8>);

impl CancelToken {
    pub fn cancel(&self, reason: CancelReason) {
        let value = match reason {
            CancelReason::User => CANCEL_USER,
            CancelReason::Shutdown => CANCEL_SHUTDOWN,
        };
        let _ = self
            .0
            .compare_exchange(CANCEL_NONE, value, Ordering::SeqCst, Ordering::SeqCst);
    }

    pub fn reason(&self) -> Option<CancelReason> {
        match self.0.load(Ordering::SeqCst) {
            CANCEL_USER => Some(CancelReason::User),
            CANCEL_SHUTDOWN => Some(CancelReason::Shutdown),
            _ => None,
        }
    }
}

/// Everything needed to run one attempt.
#[derive(Debug, Clone)]
pub struct AttemptRequest {
    pub root_task_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub session_id: String,
    pub provider: Provider,
    pub model: Option<String>,
    pub permission: RunnerPermission,
    pub worktree: PathBuf,
    pub prompt: String,
    pub timeout: Duration,
}

/// How an attempt ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptEnd {
    Completed {
        final_response: String,
    },
    /// Runner/start errors (`code` is the error's detail code or its
    /// category code), a failed turn, a rejected command, or a turn the
    /// runner cancelled on its own (`RUNNER_TURN_CANCELLED`).
    Failed {
        code: String,
        message: String,
    },
    GuardBlocked {
        rule: String,
        summary: String,
    },
    TimedOut,
    Cancelled(CancelReason),
    RunnerExited,
}

/// A progress line for the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressUpdate {
    /// `"message"` or `"tool"`.
    pub kind: &'static str,
    pub text: String,
}

/// How often the attempt loop wakes up to check cancellation, the deadline,
/// and throttled progress.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// How long `start_session` may take to be acknowledged.
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// How long to wait for `TurnCancelled` after cancelling the session. Kept
/// short because the app's exit waits for it ([`crate::workflow::orchestrator::SHUTDOWN_WAIT`]);
/// a turn still running after it is torn down by closing the session.
pub(crate) const CANCEL_GRACE: Duration = Duration::from_secs(4);
/// Added to the stage timeout for the runner's own turn timeout, so this
/// side's deadline normally ends the turn first (as `TimedOut`).
const RUNNER_TIMEOUT_MARGIN: Duration = Duration::from_secs(60);
/// The runner's turn-failure message when its own turn timeout fired.
const RUNNER_TIMEOUT_MESSAGE: &str = "TIMEOUT";
/// The runner's turn-failure message when the safety guard blocked a tool
/// call.
const RUNNER_GUARD_BLOCKED_MESSAGE: &str = "GUARD_BLOCKED";
/// Rule reported for a guard block whose violation event was not seen.
const UNKNOWN_GUARD_RULE: &str = "unknown";
/// Code of an attempt whose worktree path is not valid UTF-8 (it cannot be
/// passed to the runner as the guard root without loss).
const WORKFLOW_WORKTREE_PATH_NOT_UTF8: &str = "WORKFLOW_WORKTREE_PATH_NOT_UTF8";
/// Code of a turn the runner cancelled without being asked to.
const RUNNER_TURN_CANCELLED: &str = "RUNNER_TURN_CANCELLED";
/// Minimum spacing between progress updates (at most 4 per second).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// Maximum progress text length, in characters.
const PROGRESS_MAX_CHARS: usize = 500;

/// Runs one attempt to its end. Never takes the project lock (attempt
/// output and log writes need none). Always closes the session before
/// returning and, on [`AttemptEnd::Completed`], saves the final response as
/// the attempt output; if that write fails the attempt ends as
/// [`AttemptEnd::Failed`] with the store error's code. Log write errors are
/// only reported via `eprintln!`.
pub fn run_attempt(
    runner: &dyn RunnerApi,
    store: &WorkflowStore,
    req: &AttemptRequest,
    cancel: &CancelToken,
    progress: &dyn Fn(ProgressUpdate),
) -> AttemptEnd {
    run_attempt_with_grace(runner, store, req, cancel, progress, CANCEL_GRACE)
}

/// [`run_attempt`] with a configurable wait for `TurnCancelled` after
/// cancelling the session.
fn run_attempt_with_grace(
    runner: &dyn RunnerApi,
    store: &WorkflowStore,
    req: &AttemptRequest,
    cancel: &CancelToken,
    progress: &dyn Fn(ProgressUpdate),
    cancel_grace: Duration,
) -> AttemptEnd {
    let mut throttle = Throttle::default();
    let mut end = drive(
        runner,
        store,
        req,
        cancel,
        progress,
        &mut throttle,
        cancel_grace,
    );
    throttle.finish(progress);
    if let AttemptEnd::Completed { final_response } = &end {
        if let Err(e) = store.write_attempt_output(
            &req.root_task_id,
            &req.task_id,
            &req.attempt_id,
            final_response,
        ) {
            // An answer that cannot be saved cannot be inspected or parsed.
            end = AttemptEnd::Failed {
                code: e.code().to_string(),
                message: e.to_string(),
            };
        }
    }
    // Also tears down a turn still in flight (e.g. after `Rejected`).
    if let Err(e) = runner.close_session(&req.session_id) {
        eprintln!("[workflow] failed to close session {}: {e}", req.session_id);
    }
    end
}

/// Why this side is stopping the turn.
#[derive(Clone, Copy)]
enum StopCause {
    Cancel(CancelReason),
    Timeout,
}

impl StopCause {
    fn end(self) -> AttemptEnd {
        match self {
            StopCause::Cancel(reason) => AttemptEnd::Cancelled(reason),
            StopCause::Timeout => AttemptEnd::TimedOut,
        }
    }
}

fn failed(err: &RunnerError) -> AttemptEnd {
    AttemptEnd::Failed {
        code: err.detail_code().unwrap_or(err.code()).to_string(),
        message: err.to_string(),
    }
}

/// Starts the session, sends the prompt, and waits for the turn to end.
fn drive(
    runner: &dyn RunnerApi,
    store: &WorkflowStore,
    req: &AttemptRequest,
    cancel: &CancelToken,
    progress: &dyn Fn(ProgressUpdate),
    throttle: &mut Throttle,
    cancel_grace: Duration,
) -> AttemptEnd {
    // The guard root must be exactly the worktree; never pass a lossy path.
    let Some(worktree) = req.worktree.to_str() else {
        return AttemptEnd::Failed {
            code: WORKFLOW_WORKTREE_PATH_NOT_UTF8.to_string(),
            message: req.worktree.display().to_string(),
        };
    };
    let params = StartSessionParams {
        session_id: req.session_id.clone(),
        provider: req.provider,
        working_directory: worktree.to_string(),
        permission: req.permission,
        model: req.model.clone(),
        resume_native_id: None,
        guard_workspace_root: Some(worktree.to_string()),
        timeout_ms: Some(
            req.timeout
                .checked_add(RUNNER_TIMEOUT_MARGIN)
                .and_then(|timeout| u64::try_from(timeout.as_millis()).ok())
                .unwrap_or(u64::MAX),
        ),
    };
    if let Some(reason) = cancel.reason() {
        return AttemptEnd::Cancelled(reason);
    }
    let rx = match runner.start_session(params, START_TIMEOUT) {
        Ok((rx, _)) => rx,
        Err(e) => return failed(&e),
    };
    if let Some(reason) = cancel.reason() {
        return AttemptEnd::Cancelled(reason);
    }
    if let Err(e) = runner.send(&req.session_id, &req.prompt) {
        return failed(&e);
    }

    let log = |line: String| {
        if let Err(e) =
            store.append_attempt_log(&req.root_task_id, &req.task_id, &req.attempt_id, &line)
        {
            eprintln!(
                "[workflow] failed to append attempt log {}: {e}",
                req.attempt_id
            );
        }
    };
    // `None` (a timeout too large to represent) means no deadline.
    let deadline = Instant::now().checked_add(req.timeout);
    // The first guard violation of the turn.
    let mut violation: Option<(String, String)> = None;
    // Set once this side has asked the runner to cancel the turn, with the
    // end of the grace period for `TurnCancelled`.
    let mut stopping: Option<(StopCause, Instant)> = None;

    loop {
        let now = Instant::now();
        throttle.tick(now, progress);
        match stopping {
            Some((cause, grace_end)) if now >= grace_end => return cause.end(),
            Some(_) => {}
            None => {
                let cause = match cancel.reason() {
                    Some(reason) => Some(StopCause::Cancel(reason)),
                    None if deadline.is_some_and(|d| now >= d) => Some(StopCause::Timeout),
                    None => None,
                };
                if let Some(cause) = cause {
                    // Progress of a turn being stopped is no longer shown.
                    throttle.stop();
                    if let Err(e) = runner.cancel(&req.session_id) {
                        // No `TurnCancelled` will follow; closing the
                        // session tears the turn down.
                        eprintln!(
                            "[workflow] failed to cancel session {}: {e}",
                            req.session_id
                        );
                        return cause.end();
                    }
                    stopping = Some((cause, now + cancel_grace));
                }
            }
        }

        // Wake up no later than the next deadline or due progress update.
        let mut wake = now + POLL_INTERVAL;
        if let Some(limit) = stopping.map(|(_, grace_end)| grace_end).or(deadline) {
            wake = wake.min(limit);
        }
        if let Some(due) = throttle.next_due() {
            wake = wake.min(due);
        }
        let event = match rx.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return stopping.map_or(AttemptEnd::RunnerExited, |(cause, _)| cause.end());
            }
        };

        match event {
            RunnerEvent::Event(value) => {
                log(value.to_string());
                if let Some(update) = progress_for(&value) {
                    throttle.offer(update, Instant::now(), progress);
                }
                continue;
            }
            RunnerEvent::PermissionRequest {
                permission_id,
                request,
            } => {
                // Workflow sessions never ask the user.
                if let Err(e) = runner.respond_permission(&req.session_id, &permission_id, false) {
                    eprintln!("[workflow] failed to deny permission {permission_id}: {e}");
                }
                log(json!({
                    "type": "permission_denied",
                    "permissionId": permission_id,
                    "request": request,
                })
                .to_string());
                continue;
            }
            RunnerEvent::GuardViolation { rule, summary } => {
                log(
                    json!({ "type": "guard_violation", "rule": rule, "summary": summary })
                        .to_string(),
                );
                if violation.is_none() {
                    violation = Some((rule, summary));
                }
                continue;
            }
            _ => {}
        }

        // A terminal event. Once this side has stopped the turn, whatever
        // ends it reports that stop.
        if let Some((cause, _)) = stopping {
            return cause.end();
        }
        return match event {
            RunnerEvent::TurnCompleted { final_response, .. } => {
                AttemptEnd::Completed { final_response }
            }
            RunnerEvent::TurnFailed { message } => {
                log(json!({ "type": "turn_failed", "message": message }).to_string());
                match violation {
                    Some((rule, summary)) => AttemptEnd::GuardBlocked { rule, summary },
                    None if message == RUNNER_TIMEOUT_MESSAGE => AttemptEnd::TimedOut,
                    None if message == RUNNER_GUARD_BLOCKED_MESSAGE => AttemptEnd::GuardBlocked {
                        rule: UNKNOWN_GUARD_RULE.to_string(),
                        summary: String::new(),
                    },
                    None => AttemptEnd::Failed {
                        code: "RUNNER_TURN_FAILED".to_string(),
                        message,
                    },
                }
            }
            // The runner refused a command without ending its turn. The
            // attempt still ends here: `close_session` in `run_attempt`
            // tears down whatever is still in flight.
            RunnerEvent::Rejected { message } => {
                log(json!({ "type": "rejected", "message": message }).to_string());
                AttemptEnd::Failed {
                    code: "RUNNER_REJECTED".to_string(),
                    message,
                }
            }
            RunnerEvent::TurnCancelled if deadline.is_some_and(|d| Instant::now() >= d) => {
                AttemptEnd::TimedOut
            }
            // Nobody asked for this cancel (a request would have set the
            // token): the turn did not do its work.
            RunnerEvent::TurnCancelled => match cancel.reason() {
                Some(reason) => AttemptEnd::Cancelled(reason),
                None => AttemptEnd::Failed {
                    code: RUNNER_TURN_CANCELLED.to_string(),
                    message: String::new(),
                },
            },
            _ => AttemptEnd::RunnerExited,
        };
    }
}

/// The progress update for an agent event, if it has one.
fn progress_for(event: &Value) -> Option<ProgressUpdate> {
    let (kind, field) = match event.get("type").and_then(Value::as_str)? {
        "assistant_message" => ("message", "text"),
        "tool_started" => ("tool", "title"),
        _ => return None,
    };
    let text = event.get(field).and_then(Value::as_str)?.trim();
    Some(ProgressUpdate {
        kind,
        text: text.chars().take(PROGRESS_MAX_CHARS).collect(),
    })
}

/// Limits progress to one update per [`PROGRESS_INTERVAL`]. Updates that
/// arrive too early replace each other; the newest one is delivered once
/// allowed, and always before the attempt ends.
#[derive(Default)]
struct Throttle {
    last_sent: Option<Instant>,
    pending: Option<ProgressUpdate>,
    /// Set once the turn is being stopped; nothing is forwarded after that.
    stopped: bool,
}

impl Throttle {
    fn stop(&mut self) {
        self.stopped = true;
        self.pending = None;
    }

    fn is_due(&self, now: Instant) -> bool {
        self.last_sent
            .map_or(true, |last| now >= last + PROGRESS_INTERVAL)
    }

    fn deliver(&mut self, update: ProgressUpdate, now: Instant, progress: &dyn Fn(ProgressUpdate)) {
        self.last_sent = Some(now);
        progress(update);
    }

    fn offer(&mut self, update: ProgressUpdate, now: Instant, progress: &dyn Fn(ProgressUpdate)) {
        if self.stopped {
            return;
        }
        if self.is_due(now) {
            self.pending = None;
            self.deliver(update, now, progress);
        } else {
            self.pending = Some(update);
        }
    }

    fn tick(&mut self, now: Instant, progress: &dyn Fn(ProgressUpdate)) {
        if self.is_due(now) {
            if let Some(update) = self.pending.take() {
                self.deliver(update, now, progress);
            }
        }
    }

    /// When the pending update may be delivered, if there is one.
    fn next_due(&self) -> Option<Instant> {
        self.pending.as_ref()?;
        self.last_sent.map(|last| last + PROGRESS_INTERVAL)
    }

    fn finish(&mut self, progress: &dyn Fn(ProgressUpdate)) {
        if let Some(update) = self.pending.take() {
            progress(update);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::Mutex;
    use std::thread;

    const ROOT: &str = "0000000000000001";
    const TASK: &str = "0000000000000002";
    const ATTEMPT: &str = "00000000000000a1";

    /// Scripted runner: records every call and hands out a receiver whose
    /// sender side stays with the test.
    struct FakeRunner {
        calls: Mutex<Vec<String>>,
        params: Mutex<Option<StartSessionParams>>,
        rx: Mutex<Option<Receiver<RunnerEvent>>>,
        start_error: Option<RunnerError>,
        /// When set, `cancel` pushes these events through the sender.
        cancel_reply: Mutex<Option<(Sender<RunnerEvent>, Vec<RunnerEvent>)>>,
        cancel_error: bool,
        /// When set, `start_session` cancels this token (a cancel that
        /// arrives while the session is starting).
        cancel_on_start: Option<CancelToken>,
        permissions: Mutex<Vec<(String, bool)>>,
    }

    impl FakeRunner {
        fn new() -> (FakeRunner, Sender<RunnerEvent>) {
            let (tx, rx) = mpsc::channel();
            (
                FakeRunner {
                    calls: Mutex::new(vec![]),
                    params: Mutex::new(None),
                    rx: Mutex::new(Some(rx)),
                    start_error: None,
                    cancel_reply: Mutex::new(None),
                    cancel_error: false,
                    cancel_on_start: None,
                    permissions: Mutex::new(vec![]),
                },
                tx,
            )
        }

        fn replying_to_cancel() -> (FakeRunner, Sender<RunnerEvent>) {
            Self::replying_to_cancel_with(vec![RunnerEvent::TurnCancelled])
        }

        fn replying_to_cancel_with(events: Vec<RunnerEvent>) -> (FakeRunner, Sender<RunnerEvent>) {
            let (runner, tx) = Self::new();
            *runner.cancel_reply.lock().unwrap() = Some((tx.clone(), events));
            (runner, tx)
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn record(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }
    }

    impl RunnerApi for FakeRunner {
        fn start_session(
            &self,
            params: StartSessionParams,
            _timeout: Duration,
        ) -> Result<(Receiver<RunnerEvent>, Option<String>), RunnerError> {
            self.record("start".to_string());
            if let Some(token) = &self.cancel_on_start {
                token.cancel(CancelReason::Shutdown);
            }
            *self.params.lock().unwrap() = Some(params);
            if let Some(err) = &self.start_error {
                return Err(err.clone());
            }
            Ok((self.rx.lock().unwrap().take().unwrap(), None))
        }

        fn send(&self, _session_id: &str, text: &str) -> Result<(), RunnerError> {
            self.record(format!("send:{text}"));
            Ok(())
        }

        fn cancel(&self, _session_id: &str) -> Result<(), RunnerError> {
            self.record("cancel".to_string());
            if self.cancel_error {
                return Err(RunnerError::Exited);
            }
            if let Some((tx, events)) = self.cancel_reply.lock().unwrap().as_ref() {
                for event in events {
                    let _ = tx.send(event.clone());
                }
            }
            Ok(())
        }

        fn respond_permission(
            &self,
            _session_id: &str,
            permission_id: &str,
            allow: bool,
        ) -> Result<(), RunnerError> {
            self.permissions
                .lock()
                .unwrap()
                .push((permission_id.to_string(), allow));
            Ok(())
        }

        fn close_session(&self, _session_id: &str) -> Result<(), RunnerError> {
            self.record("close".to_string());
            Ok(())
        }

        fn probe(
            &self,
            _provider: Provider,
            _timeout: Duration,
        ) -> Result<serde_json::Value, RunnerError> {
            unreachable!("attempts never probe")
        }

        fn shutdown(&self) {
            unreachable!("attempts never shut the runner down")
        }
    }

    fn request(dir: &tempfile::TempDir) -> AttemptRequest {
        AttemptRequest {
            root_task_id: ROOT.to_string(),
            task_id: TASK.to_string(),
            attempt_id: ATTEMPT.to_string(),
            session_id: "wf-session-1".to_string(),
            provider: Provider::Codex,
            model: Some("gpt-5".to_string()),
            permission: RunnerPermission::FullAccess,
            worktree: dir.path().join("worktree"),
            prompt: "do the stage".to_string(),
            timeout: Duration::from_secs(30),
        }
    }

    /// Runs an attempt, collecting progress updates.
    fn run(
        runner: &FakeRunner,
        store: &WorkflowStore,
        req: &AttemptRequest,
        cancel: &CancelToken,
    ) -> (AttemptEnd, Vec<ProgressUpdate>) {
        run_with_grace(runner, store, req, cancel, CANCEL_GRACE)
    }

    fn run_with_grace(
        runner: &FakeRunner,
        store: &WorkflowStore,
        req: &AttemptRequest,
        cancel: &CancelToken,
        grace: Duration,
    ) -> (AttemptEnd, Vec<ProgressUpdate>) {
        let updates = Mutex::new(vec![]);
        let end = run_attempt_with_grace(
            runner,
            store,
            req,
            cancel,
            &|u| updates.lock().unwrap().push(u),
            grace,
        );
        (end, updates.into_inner().unwrap())
    }

    fn completed(text: &str) -> RunnerEvent {
        RunnerEvent::TurnCompleted {
            final_response: text.to_string(),
            native_session_id: None,
        }
    }

    #[test]
    fn completed_path_writes_output_log_and_progress() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, tx) = FakeRunner::new();
        let event = json!({ "type": "assistant_message", "text": "  working on it  " });
        tx.send(RunnerEvent::Event(event.clone())).unwrap();
        tx.send(completed("---\noutcome: done\n---\n")).unwrap();

        let (end, updates) = run(&runner, &store, &request(&dir), &CancelToken::default());

        assert_eq!(
            end,
            AttemptEnd::Completed {
                final_response: "---\noutcome: done\n---\n".to_string()
            }
        );
        assert_eq!(
            store.read_attempt_output(ROOT, TASK, ATTEMPT).unwrap(),
            "---\noutcome: done\n---\n"
        );
        let log = store.read_attempt_log(ROOT, TASK, ATTEMPT).unwrap();
        assert!(log.lines().any(|l| l == event.to_string()), "{log}");
        assert_eq!(
            updates,
            vec![ProgressUpdate {
                kind: "message",
                text: "working on it".to_string()
            }]
        );
        assert_eq!(runner.calls(), vec!["start", "send:do the stage", "close"]);
    }

    #[test]
    fn progress_text_is_truncated_and_tools_report_their_title() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, tx) = FakeRunner::new();
        tx.send(RunnerEvent::Event(
            json!({ "type": "tool_started", "toolId": "t1", "title": "npm test" }),
        ))
        .unwrap();
        tx.send(RunnerEvent::Event(
            json!({ "type": "assistant_message", "text": "あ".repeat(600) }),
        ))
        .unwrap();
        tx.send(completed("x")).unwrap();

        let (_, updates) = run(&runner, &store, &request(&dir), &CancelToken::default());

        assert_eq!(updates[0].kind, "tool");
        assert_eq!(updates[0].text, "npm test");
        let last = updates.last().unwrap();
        assert_eq!(last.kind, "message");
        assert_eq!(last.text.chars().count(), 500);
    }

    #[test]
    fn session_params_carry_the_guard_root_and_permission() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, tx) = FakeRunner::new();
        tx.send(completed("x")).unwrap();
        let req = request(&dir);

        run(&runner, &store, &req, &CancelToken::default());

        let worktree = req.worktree.to_str().unwrap().to_string();
        assert_eq!(
            runner.params.lock().unwrap().clone().unwrap(),
            StartSessionParams {
                session_id: "wf-session-1".to_string(),
                provider: Provider::Codex,
                working_directory: worktree.clone(),
                permission: RunnerPermission::FullAccess,
                model: Some("gpt-5".to_string()),
                resume_native_id: None,
                guard_workspace_root: Some(worktree),
                // The stage timeout plus the runner margin.
                timeout_ms: Some(90_000),
            }
        );
    }

    #[test]
    fn permission_requests_are_denied_and_logged() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, tx) = FakeRunner::new();
        tx.send(RunnerEvent::PermissionRequest {
            permission_id: "perm-7".to_string(),
            request: json!({ "tool": "Bash" }),
        })
        .unwrap();
        tx.send(completed("x")).unwrap();

        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());

        assert!(matches!(end, AttemptEnd::Completed { .. }));
        assert_eq!(
            *runner.permissions.lock().unwrap(),
            vec![("perm-7".to_string(), false)]
        );
        let log = store.read_attempt_log(ROOT, TASK, ATTEMPT).unwrap();
        assert!(log.contains("perm-7"), "{log}");
    }

    #[test]
    fn guard_violation_then_turn_failed_is_guard_blocked() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, tx) = FakeRunner::new();
        tx.send(RunnerEvent::GuardViolation {
            rule: "outside-workspace".to_string(),
            summary: "write to C:\\Windows".to_string(),
        })
        .unwrap();
        tx.send(RunnerEvent::GuardViolation {
            rule: "second".to_string(),
            summary: "ignored".to_string(),
        })
        .unwrap();
        tx.send(RunnerEvent::TurnFailed {
            message: "blocked".to_string(),
        })
        .unwrap();

        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());

        assert_eq!(
            end,
            AttemptEnd::GuardBlocked {
                rule: "outside-workspace".to_string(),
                summary: "write to C:\\Windows".to_string(),
            }
        );
        let log = store.read_attempt_log(ROOT, TASK, ATTEMPT).unwrap();
        assert!(log.contains("outside-workspace"), "{log}");
        assert_eq!(runner.calls().last().unwrap(), "close");
    }

    #[test]
    fn turn_failed_and_rejected_are_failures() {
        for (event, code) in [
            (
                RunnerEvent::TurnFailed {
                    message: "boom".to_string(),
                },
                "RUNNER_TURN_FAILED",
            ),
            (
                RunnerEvent::Rejected {
                    message: "boom".to_string(),
                },
                "RUNNER_REJECTED",
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let store = WorkflowStore::new(dir.path().to_path_buf());
            let (runner, tx) = FakeRunner::new();
            tx.send(event).unwrap();

            let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());

            assert_eq!(
                end,
                AttemptEnd::Failed {
                    code: code.to_string(),
                    message: "boom".to_string()
                }
            );
            assert!(store.read_attempt_output(ROOT, TASK, ATTEMPT).is_err());
        }
    }

    #[test]
    fn user_cancel_mid_turn_cancels_the_session_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, _tx) = FakeRunner::replying_to_cancel();
        let cancel = CancelToken::default();
        let canceller = {
            let cancel = cancel.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(50));
                cancel.cancel(CancelReason::User);
                // A later reason does not replace the first one.
                cancel.cancel(CancelReason::Shutdown);
            })
        };

        let (end, _) = run(&runner, &store, &request(&dir), &cancel);
        canceller.join().unwrap();

        assert_eq!(end, AttemptEnd::Cancelled(CancelReason::User));
        assert_eq!(
            runner.calls(),
            vec!["start", "send:do the stage", "cancel", "close"]
        );
    }

    #[test]
    fn runner_side_cancel_without_a_request_is_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, tx) = FakeRunner::new();
        tx.send(RunnerEvent::TurnCancelled).unwrap();

        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());

        assert_eq!(
            end,
            AttemptEnd::Failed {
                code: "RUNNER_TURN_CANCELLED".to_string(),
                message: String::new(),
            }
        );
        assert!(!runner.calls().contains(&"cancel".to_string()));
    }

    #[test]
    fn runner_side_timeout_is_timed_out() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, tx) = FakeRunner::new();
        tx.send(RunnerEvent::TurnFailed {
            message: "TIMEOUT".to_string(),
        })
        .unwrap();

        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());

        assert_eq!(end, AttemptEnd::TimedOut);
    }

    #[test]
    fn guard_blocked_without_a_violation_event_is_guard_blocked() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, tx) = FakeRunner::new();
        tx.send(RunnerEvent::TurnFailed {
            message: "GUARD_BLOCKED".to_string(),
        })
        .unwrap();

        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());

        assert_eq!(
            end,
            AttemptEnd::GuardBlocked {
                rule: "unknown".to_string(),
                summary: String::new(),
            }
        );
    }

    #[test]
    fn deadline_cancels_the_session_and_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, _tx) = FakeRunner::replying_to_cancel();
        let mut req = request(&dir);
        req.timeout = Duration::from_millis(300);

        let started = Instant::now();
        let (end, _) = run(&runner, &store, &req, &CancelToken::default());

        assert_eq!(end, AttemptEnd::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(
            runner.calls(),
            vec!["start", "send:do the stage", "cancel", "close"]
        );
    }

    #[test]
    fn runner_exit_or_disconnect_is_runner_exited() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, tx) = FakeRunner::new();
        tx.send(RunnerEvent::Exited).unwrap();
        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());
        assert_eq!(end, AttemptEnd::RunnerExited);

        let (runner, tx) = FakeRunner::new();
        drop(tx);
        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());
        assert_eq!(end, AttemptEnd::RunnerExited);
        assert_eq!(runner.calls().last().unwrap(), "close");
    }

    #[test]
    fn start_session_error_is_a_failure_with_its_code() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (mut runner, _tx) = FakeRunner::new();
        runner.start_error = Some(RunnerError::InvalidRequest("RUNNER_GUARD_REQUIRED"));

        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());

        assert_eq!(
            end,
            AttemptEnd::Failed {
                code: "RUNNER_GUARD_REQUIRED".to_string(),
                message: RunnerError::InvalidRequest("RUNNER_GUARD_REQUIRED").to_string(),
            }
        );
        assert!(!runner.calls().iter().any(|c| c.starts_with("send:")));

        let (mut runner, _tx) = FakeRunner::new();
        runner.start_error = Some(RunnerError::Unavailable("AGENT_RUNNER_MISSING"));
        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());
        assert!(
            matches!(&end, AttemptEnd::Failed { code, .. } if code == "AGENT_RUNNER_MISSING"),
            "{end:?}"
        );

        let (mut runner, _tx) = FakeRunner::new();
        runner.start_error = Some(RunnerError::Timeout);
        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());
        assert!(
            matches!(&end, AttemptEnd::Failed { code, .. } if code == "RUNNER_TIMEOUT"),
            "{end:?}"
        );
    }

    #[test]
    fn progress_is_throttled_but_the_last_update_is_delivered() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, tx) = FakeRunner::new();
        let pusher = thread::spawn(move || {
            let started = Instant::now();
            for i in 0..100 {
                let event = json!({ "type": "assistant_message", "text": format!("msg {i}") });
                tx.send(RunnerEvent::Event(event)).unwrap();
                // Spread the 100 events over roughly 100 ms.
                let due = started + Duration::from_millis(i + 1);
                if let Some(wait) = due.checked_duration_since(Instant::now()) {
                    thread::sleep(wait);
                }
            }
            tx.send(completed("x")).unwrap();
        });

        let (end, updates) = run(&runner, &store, &request(&dir), &CancelToken::default());
        pusher.join().unwrap();

        assert!(matches!(end, AttemptEnd::Completed { .. }));
        assert!(updates.len() <= 3, "{updates:?}");
        assert_eq!(updates.last().unwrap().text, "msg 99");
        // Every event is still logged.
        let log = store.read_attempt_log(ROOT, TASK, ATTEMPT).unwrap();
        assert_eq!(log.lines().count(), 100);
    }

    #[test]
    fn unsaved_output_is_a_failure_with_the_store_code() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        // A file where the attempt directory belongs makes every write fail.
        let run_dir = dir.path().join(".mdium").join("runs").join(ROOT);
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::write(run_dir.join(TASK), "not a directory").unwrap();
        let (runner, tx) = FakeRunner::new();
        tx.send(completed("answer")).unwrap();

        let (end, _) = run(&runner, &store, &request(&dir), &CancelToken::default());

        assert!(
            matches!(&end, AttemptEnd::Failed { code, .. } if code == "STORE_IO_FAILED"),
            "{end:?}"
        );
        assert_eq!(runner.calls().last().unwrap(), "close");
    }

    #[test]
    fn cancel_before_start_never_starts_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (runner, _tx) = FakeRunner::new();
        let cancel = CancelToken::default();
        cancel.cancel(CancelReason::Shutdown);

        let (end, _) = run(&runner, &store, &request(&dir), &cancel);

        assert_eq!(end, AttemptEnd::Cancelled(CancelReason::Shutdown));
        assert_eq!(runner.calls(), vec!["close"]);
    }

    #[test]
    fn cancel_while_starting_never_sends_the_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (mut runner, _tx) = FakeRunner::new();
        let cancel = CancelToken::default();
        runner.cancel_on_start = Some(cancel.clone());

        let (end, _) = run(&runner, &store, &request(&dir), &cancel);

        assert_eq!(end, AttemptEnd::Cancelled(CancelReason::Shutdown));
        assert_eq!(runner.calls(), vec!["start", "close"]);
    }

    #[test]
    fn cancel_error_ends_the_attempt_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let (mut runner, _tx) = FakeRunner::new();
        runner.cancel_error = true;
        let cancel = CancelToken::default();
        let canceller = {
            let cancel = cancel.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(20));
                cancel.cancel(CancelReason::User);
            })
        };

        let started = Instant::now();
        let (end, _) = run(&runner, &store, &request(&dir), &cancel);
        canceller.join().unwrap();

        assert_eq!(end, AttemptEnd::Cancelled(CancelReason::User));
        // Well below the grace period.
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            runner.calls(),
            vec!["start", "send:do the stage", "cancel", "close"]
        );
    }

    #[test]
    fn missing_turn_cancelled_ends_after_the_grace_period() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        // The runner never answers the cancel.
        let (runner, _tx) = FakeRunner::new();
        let mut req = request(&dir);
        req.timeout = Duration::from_millis(50);

        let started = Instant::now();
        let (end, _) = run_with_grace(
            &runner,
            &store,
            &req,
            &CancelToken::default(),
            Duration::from_millis(100),
        );

        assert_eq!(end, AttemptEnd::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            runner.calls(),
            vec!["start", "send:do the stage", "cancel", "close"]
        );
    }

    #[test]
    fn no_progress_is_forwarded_after_the_turn_is_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path().to_path_buf());
        let late = json!({ "type": "assistant_message", "text": "late" });
        let (runner, tx) = FakeRunner::replying_to_cancel_with(vec![
            RunnerEvent::Event(late),
            RunnerEvent::TurnCancelled,
        ]);
        for text in ["first", "throttled"] {
            let event = json!({ "type": "assistant_message", "text": text });
            tx.send(RunnerEvent::Event(event)).unwrap();
        }
        let mut req = request(&dir);
        // Shorter than the progress interval, so "throttled" is still pending.
        req.timeout = Duration::from_millis(100);

        let (end, updates) = run(&runner, &store, &req, &CancelToken::default());

        assert_eq!(end, AttemptEnd::TimedOut);
        assert_eq!(
            updates,
            vec![ProgressUpdate {
                kind: "message",
                text: "first".to_string()
            }]
        );
    }
}

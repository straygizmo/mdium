//! Agent turns of `agent` nodes. The driver talks to an [`AgentRunner`]
//! and never to the Node sidecar: the desktop app runs turns over the
//! shared runner host ([`RunnerApiAgentRunner`]), tests use a fake.
//!
//! A turn is one guarded session: start it rooted at the working
//! directory, send the prompt, deny every permission request, remember
//! guard violations, and report how the turn ended. The session is always
//! closed afterwards.

use crate::model::AgentPermission;
use crate::provider::Provider;
use crate::runner_client::{RunnerError, RunnerEvent, RunnerPermission, StartSessionParams};
use crate::runner_host::RunnerApi;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How often the turn thread checks for a cancel while waiting for events.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// How long the runner may take to start a session.
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a cancelled turn may take to report `TurnCancelled`.
const CANCEL_GRACE: Duration = Duration::from_secs(4);
/// Added to the node timeout for the runner's own turn timeout, so the
/// driver's timeout normally fires first.
const RUNNER_TIMEOUT_MARGIN: Duration = Duration::from_secs(60);
/// `TurnFailed` message of a turn the runner timed out.
const RUNNER_TIMEOUT_MESSAGE: &str = "TIMEOUT";
/// `TurnFailed` message of a turn the runner's guard blocked.
const RUNNER_GUARD_BLOCKED_MESSAGE: &str = "GUARD_BLOCKED";
/// Rule reported when the runner blocked a turn without naming the rule.
const UNKNOWN_GUARD_RULE: &str = "unknown";
/// The working directory cannot be passed to the runner losslessly.
const WORKFLOW_WORKTREE_PATH_NOT_UTF8: &str = "WORKFLOW_WORKTREE_PATH_NOT_UTF8";
/// Longest progress text taken from an agent event, in chars.
const PROGRESS_MAX_CHARS: usize = 500;

/// One turn to run.
pub struct AgentTurnRequest {
    pub session_id: String,
    pub provider: Provider,
    pub model: Option<String>,
    pub permission: AgentPermission,
    pub working_dir: PathBuf,
    pub prompt: String,
    /// The node timeout; the runner's own turn timeout is this plus a margin.
    pub timeout: Option<Duration>,
}

/// Something that happened in a turn. `Completed`, `Failed`, `Cancelled`
/// and `Exited` end it; exactly one of them is reported.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentTurnEvent {
    /// A line for the node's `stdout.log` (runner events as JSON).
    Log(String),
    Progress(String),
    GuardViolation {
        rule: String,
        summary: String,
    },
    Completed {
        final_response: String,
    },
    Failed {
        code: String,
        message: String,
    },
    Cancelled,
    /// The runner process is gone.
    Exited,
}

impl AgentTurnEvent {
    /// The event ends the turn.
    pub fn is_end(&self) -> bool {
        matches!(
            self,
            AgentTurnEvent::Completed { .. }
                | AgentTurnEvent::Failed { .. }
                | AgentTurnEvent::Cancelled
                | AgentTurnEvent::Exited
        )
    }
}

/// A running turn, polled by the driver without blocking.
pub trait AgentTurnHandle: Send {
    fn try_recv(&mut self) -> Option<AgentTurnEvent>;
    /// Asks the runner to cancel; the handle still reports an end event.
    fn cancel(&mut self);
}

/// Starts agent turns and checks providers.
pub trait AgentRunner: Send + Sync {
    fn start(&self, req: AgentTurnRequest) -> Result<Box<dyn AgentTurnHandle>, String>;
    /// `Err(message)` when the provider cannot be used on this machine.
    fn probe(&self, provider: Provider) -> Result<(), String>;
}

/// Every start / probe fails: the app has no runner.
pub struct NoAgentRunner;

impl AgentRunner for NoAgentRunner {
    fn start(&self, _req: AgentTurnRequest) -> Result<Box<dyn AgentTurnHandle>, String> {
        Err("no agent runner".to_string())
    }

    fn probe(&self, _provider: Provider) -> Result<(), String> {
        Err("no agent runner".to_string())
    }
}

/// Runs a turn on a thread over the shared runner host.
pub struct RunnerApiAgentRunner {
    pub api: Arc<dyn RunnerApi>,
    pub probe_timeout: Duration,
}

impl AgentRunner for RunnerApiAgentRunner {
    fn start(&self, req: AgentTurnRequest) -> Result<Box<dyn AgentTurnHandle>, String> {
        let (tx, rx) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let api = self.api.clone();
        let flag = cancel.clone();
        std::thread::Builder::new()
            .name(format!("flow-agent-{}", req.session_id))
            .spawn(move || {
                let end = drive_turn(api.as_ref(), &req, &flag, &tx);
                let _ = tx.send(end);
                // Tears down whatever is still in flight; harmless after a clean end.
                let _ = api.close_session(&req.session_id);
            })
            .map_err(|e| e.to_string())?;
        Ok(Box::new(ChannelTurn {
            rx,
            cancel,
            ended: false,
        }))
    }

    fn probe(&self, provider: Provider) -> Result<(), String> {
        self.api
            .probe(provider, self.probe_timeout)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

impl From<AgentPermission> for RunnerPermission {
    fn from(permission: AgentPermission) -> Self {
        match permission {
            AgentPermission::ReadOnly => RunnerPermission::ReadOnly,
            AgentPermission::FullAccess => RunnerPermission::FullAccess,
        }
    }
}

/// The driver's end of a turn running on a thread.
struct ChannelTurn {
    rx: Receiver<AgentTurnEvent>,
    cancel: Arc<AtomicBool>,
    ended: bool,
}

impl AgentTurnHandle for ChannelTurn {
    fn try_recv(&mut self) -> Option<AgentTurnEvent> {
        if self.ended {
            return None;
        }
        match self.rx.try_recv() {
            Ok(event) => {
                self.ended = event.is_end();
                Some(event)
            }
            Err(TryRecvError::Empty) => None,
            // The thread ended without an end event (it panicked).
            Err(TryRecvError::Disconnected) => {
                self.ended = true;
                Some(AgentTurnEvent::Exited)
            }
        }
    }

    fn cancel(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
}

fn failed(err: &RunnerError) -> AgentTurnEvent {
    AgentTurnEvent::Failed {
        code: err.detail_code().unwrap_or(err.code()).to_string(),
        message: err.to_string(),
    }
}

/// Starts the session, sends the prompt, forwards events to `tx` and
/// returns the event that ends the turn (sent by the caller).
fn drive_turn(
    api: &dyn RunnerApi,
    req: &AgentTurnRequest,
    cancel: &AtomicBool,
    tx: &Sender<AgentTurnEvent>,
) -> AgentTurnEvent {
    // The guard root must be exactly the working directory; never pass a lossy path.
    let Some(working_dir) = req.working_dir.to_str() else {
        return AgentTurnEvent::Failed {
            code: WORKFLOW_WORKTREE_PATH_NOT_UTF8.to_string(),
            message: req.working_dir.display().to_string(),
        };
    };
    let params = StartSessionParams {
        session_id: req.session_id.clone(),
        provider: req.provider,
        working_directory: working_dir.to_string(),
        permission: RunnerPermission::from(req.permission),
        model: req.model.clone(),
        resume_native_id: None,
        guard_workspace_root: Some(working_dir.to_string()),
        timeout_ms: req.timeout.map(|timeout| {
            timeout
                .checked_add(RUNNER_TIMEOUT_MARGIN)
                .and_then(|t| u64::try_from(t.as_millis()).ok())
                .unwrap_or(u64::MAX)
        }),
    };
    let cancelled = || cancel.load(Ordering::SeqCst);
    if cancelled() {
        return AgentTurnEvent::Cancelled;
    }
    let rx = match api.start_session(params, START_TIMEOUT) {
        Ok((rx, _)) => rx,
        Err(e) => return failed(&e),
    };
    if cancelled() {
        return AgentTurnEvent::Cancelled;
    }
    if let Err(e) = api.send(&req.session_id, &req.prompt, &[]) {
        return failed(&e);
    }
    let forward = |event: AgentTurnEvent| {
        // The driver may be gone (cancel / app exit); keep draining anyway.
        let _ = tx.send(event);
    };
    let mut violation = false;
    // End of the grace period once this side asked the runner to cancel.
    let mut stopping: Option<Instant> = None;
    loop {
        let now = Instant::now();
        match stopping {
            Some(grace_end) if now >= grace_end => return AgentTurnEvent::Cancelled,
            Some(_) => {}
            None if cancelled() => {
                if api.cancel(&req.session_id).is_err() {
                    // No `TurnCancelled` will follow; closing the session ends the turn.
                    return AgentTurnEvent::Cancelled;
                }
                stopping = Some(now + CANCEL_GRACE);
            }
            None => {}
        }
        let mut wake = now + POLL_INTERVAL;
        if let Some(grace_end) = stopping {
            wake = wake.min(grace_end);
        }
        let event = match rx.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return match stopping {
                    Some(_) => AgentTurnEvent::Cancelled,
                    None => AgentTurnEvent::Exited,
                };
            }
        };
        match event {
            RunnerEvent::Event(value) => {
                forward(AgentTurnEvent::Log(value.to_string()));
                if let Some(text) = progress_text(&value) {
                    forward(AgentTurnEvent::Progress(text));
                }
                continue;
            }
            RunnerEvent::PermissionRequest {
                permission_id,
                request,
            } => {
                // Flow sessions never ask the user.
                let _ = api.respond_permission(&req.session_id, &permission_id, false);
                forward(AgentTurnEvent::Log(
                    json!({ "type": "permission_denied", "permissionId": permission_id, "request": request })
                        .to_string(),
                ));
                continue;
            }
            RunnerEvent::GuardViolation { rule, summary } => {
                forward(AgentTurnEvent::Log(
                    json!({ "type": "guard_violation", "rule": rule, "summary": summary })
                        .to_string(),
                ));
                violation = true;
                forward(AgentTurnEvent::GuardViolation { rule, summary });
                continue;
            }
            _ => {}
        }
        // A terminal event. Once this side has stopped the turn, whatever
        // ends it reports that stop.
        if stopping.is_some() {
            return AgentTurnEvent::Cancelled;
        }
        return match event {
            RunnerEvent::TurnCompleted { final_response, .. } => {
                AgentTurnEvent::Completed { final_response }
            }
            RunnerEvent::TurnFailed { message } => {
                forward(AgentTurnEvent::Log(
                    json!({ "type": "turn_failed", "message": message }).to_string(),
                ));
                if message == RUNNER_GUARD_BLOCKED_MESSAGE && !violation {
                    // The driver maps a failure after a violation to a guard block.
                    forward(AgentTurnEvent::GuardViolation {
                        rule: UNKNOWN_GUARD_RULE.to_string(),
                        summary: String::new(),
                    });
                }
                let code = if message == RUNNER_TIMEOUT_MESSAGE {
                    "RUNNER_TIMEOUT"
                } else {
                    "RUNNER_TURN_FAILED"
                };
                AgentTurnEvent::Failed {
                    code: code.to_string(),
                    message,
                }
            }
            // The runner refused a command without ending its turn; closing
            // the session tears down whatever is still in flight.
            RunnerEvent::Rejected { message } => AgentTurnEvent::Failed {
                code: "RUNNER_REJECTED".to_string(),
                message,
            },
            RunnerEvent::TurnCancelled => AgentTurnEvent::Cancelled,
            _ => AgentTurnEvent::Exited,
        };
    }
}

/// The progress text of an agent event, if it has one.
fn progress_text(event: &Value) -> Option<String> {
    let field = match event.get("type").and_then(Value::as_str)? {
        "assistant_message" => "text",
        "tool_started" => "title",
        _ => return None,
    };
    let text = event.get(field).and_then(Value::as_str)?.trim();
    (!text.is_empty()).then(|| text.chars().take(PROGRESS_MAX_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A runner host that replays `events` after `send` and records calls.
    struct ScriptedApi {
        events: Mutex<Option<Vec<RunnerEvent>>>,
        calls: Mutex<Vec<String>>,
        /// Keeps the session channel open (so a hang is a hang).
        keep: Mutex<Vec<Sender<RunnerEvent>>>,
        /// Replies `TurnCancelled` to `cancel`.
        acks_cancel: bool,
    }

    impl ScriptedApi {
        fn new(events: Vec<RunnerEvent>, acks_cancel: bool) -> Arc<Self> {
            Arc::new(Self {
                events: Mutex::new(Some(events)),
                calls: Mutex::new(Vec::new()),
                keep: Mutex::new(Vec::new()),
                acks_cancel,
            })
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl RunnerApi for ScriptedApi {
        fn start_session(
            &self,
            params: StartSessionParams,
            _timeout: Duration,
        ) -> Result<(Receiver<RunnerEvent>, Option<String>), RunnerError> {
            self.calls.lock().unwrap().push(format!(
                "start {} guard={}",
                params.session_id,
                params.guard_workspace_root.unwrap_or_default()
            ));
            let (tx, rx) = mpsc::channel();
            for e in self.events.lock().unwrap().take().unwrap_or_default() {
                tx.send(e).unwrap();
            }
            self.keep.lock().unwrap().push(tx);
            Ok((rx, None))
        }
        fn send(&self, _: &str, text: &str, _: &[String]) -> Result<(), RunnerError> {
            self.calls.lock().unwrap().push(format!("send {text}"));
            Ok(())
        }
        fn cancel(&self, _: &str) -> Result<(), RunnerError> {
            self.calls.lock().unwrap().push("cancel".into());
            if self.acks_cancel {
                if let Some(tx) = self.keep.lock().unwrap().first() {
                    let _ = tx.send(RunnerEvent::TurnCancelled);
                }
            }
            Ok(())
        }
        fn respond_permission(&self, _: &str, id: &str, allow: bool) -> Result<(), RunnerError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("permission {id} {allow}"));
            Ok(())
        }
        fn close_session(&self, _: &str) -> Result<(), RunnerError> {
            self.calls.lock().unwrap().push("close".into());
            Ok(())
        }
        fn probe(&self, _: Provider, _: Duration) -> Result<Value, RunnerError> {
            Ok(json!({}))
        }
        fn shutdown(&self) {}
    }

    fn request() -> AgentTurnRequest {
        AgentTurnRequest {
            session_id: "s1".into(),
            provider: Provider::Claude,
            model: None,
            permission: AgentPermission::ReadOnly,
            working_dir: std::env::temp_dir(),
            prompt: "hello".into(),
            timeout: Some(Duration::from_secs(5)),
        }
    }

    /// Collects the handle's events until the end event.
    fn collect(handle: &mut Box<dyn AgentTurnHandle>) -> Vec<AgentTurnEvent> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut out = Vec::new();
        while Instant::now() < deadline {
            match handle.try_recv() {
                Some(e) => {
                    let end = e.is_end();
                    out.push(e);
                    if end {
                        return out;
                    }
                }
                None => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        panic!("no end event: {out:?}");
    }

    fn runner(api: &Arc<ScriptedApi>) -> RunnerApiAgentRunner {
        RunnerApiAgentRunner {
            api: api.clone(),
            probe_timeout: Duration::from_secs(1),
        }
    }

    fn wait_closed(api: &ScriptedApi) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !api.calls().iter().any(|c| c == "close") {
            assert!(Instant::now() < deadline, "session not closed");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_turn_logs_events_denies_permissions_and_completes() {
        let api = ScriptedApi::new(
            vec![
                RunnerEvent::Event(json!({ "type": "assistant_message", "text": " working " })),
                RunnerEvent::PermissionRequest {
                    permission_id: "p1".into(),
                    request: json!({}),
                },
                RunnerEvent::TurnCompleted {
                    final_response: "done".into(),
                    native_session_id: None,
                },
            ],
            false,
        );
        let mut handle = runner(&api).start(request()).unwrap();
        let events = collect(&mut handle);
        assert!(matches!(&events[0], AgentTurnEvent::Log(l) if l.contains("assistant_message")));
        assert_eq!(events[1], AgentTurnEvent::Progress("working".into()));
        assert!(matches!(&events[2], AgentTurnEvent::Log(l) if l.contains("permission_denied")));
        assert_eq!(
            events.last().unwrap(),
            &AgentTurnEvent::Completed {
                final_response: "done".into()
            }
        );
        wait_closed(&api);
        let calls = api.calls();
        let guard = format!("guard={}", std::env::temp_dir().to_str().unwrap());
        assert!(calls[0].starts_with("start s1") && calls[0].ends_with(&guard));
        assert_eq!(calls[1], "send hello");
        assert!(calls.contains(&"permission p1 false".to_string()));
        assert!(handle.try_recv().is_none());
    }

    #[test]
    fn failures_are_mapped_and_a_guard_block_reports_the_violation() {
        let api = ScriptedApi::new(
            vec![RunnerEvent::TurnFailed {
                message: "GUARD_BLOCKED".into(),
            }],
            false,
        );
        let mut handle = runner(&api).start(request()).unwrap();
        let events = collect(&mut handle);
        assert!(events.contains(&AgentTurnEvent::GuardViolation {
            rule: "unknown".into(),
            summary: String::new()
        }));
        assert!(
            matches!(events.last(), Some(AgentTurnEvent::Failed { code, .. }) if code == "RUNNER_TURN_FAILED")
        );
        let api = ScriptedApi::new(
            vec![RunnerEvent::TurnFailed {
                message: "TIMEOUT".into(),
            }],
            false,
        );
        let mut handle = runner(&api).start(request()).unwrap();
        assert!(
            matches!(collect(&mut handle).last(), Some(AgentTurnEvent::Failed { code, .. }) if code == "RUNNER_TIMEOUT")
        );
        let api = ScriptedApi::new(vec![RunnerEvent::Exited], false);
        let mut handle = runner(&api).start(request()).unwrap();
        assert_eq!(collect(&mut handle).last(), Some(&AgentTurnEvent::Exited));
    }

    #[test]
    fn cancel_asks_the_runner_once_and_ends_cancelled() {
        let api = ScriptedApi::new(vec![], true);
        let mut handle = runner(&api).start(request()).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        handle.cancel();
        assert_eq!(
            collect(&mut handle).last(),
            Some(&AgentTurnEvent::Cancelled)
        );
        wait_closed(&api);
        assert_eq!(api.calls().iter().filter(|c| *c == "cancel").count(), 1);
    }

    #[test]
    fn no_agent_runner_refuses_everything() {
        assert!(NoAgentRunner.start(request()).is_err());
        assert!(NoAgentRunner.probe(Provider::Claude).is_err());
    }
}

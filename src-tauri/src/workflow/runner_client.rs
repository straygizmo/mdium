//! Rust client for the agent runner's JSON-line protocol (see
//! `src/shared/types/agent-runner.ts`). It mirrors the AGENT CHAT TS client:
//! requests carry a `requestId` and resolve on the matching reply (or an
//! `error` with the same id); session messages are routed by `sessionId`.
//!
//! The client is transport-agnostic: the owner feeds stdout lines into
//! [`RunnerClient::handle_line`] and the process exit into
//! [`RunnerClient::handle_exit`].

use crate::commands::node_sidecar;
use crate::workflow::model::Provider;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Writes lines to / kills the runner process.
pub trait RunnerTransport: Send + Sync {
    fn write_line(&self, line: &str) -> Result<(), String>;
    fn kill(&self);
}

/// [`RunnerTransport`] over a sidecar spawned by `node_sidecar`.
pub struct SidecarTransport {
    pub id: u32,
}

impl RunnerTransport for SidecarTransport {
    fn write_line(&self, line: &str) -> Result<(), String> {
        node_sidecar::write(self.id, line)
    }

    fn kill(&self) {
        if let Err(e) = node_sidecar::kill(self.id) {
            eprintln!("[workflow-runner] kill failed: {e}");
        }
    }
}

/// Something that happened in a runner session.
#[derive(Debug, Clone, PartialEq)]
pub enum RunnerEvent {
    /// An `AgentEvent` (assistant text, tool start/finish), passed through as JSON.
    Event(Value),
    PermissionRequest {
        permission_id: String,
        request: Value,
    },
    GuardViolation {
        rule: String,
        summary: String,
    },
    TurnCompleted {
        final_response: String,
        native_session_id: Option<String>,
    },
    /// The turn ended with an error. Also produced for a session-scoped
    /// `error` without a `requestId` other than `TURN_IN_PROGRESS` (e.g.
    /// `NO_SESSION`), so a `send` never waits on a turn that cannot start.
    TurnFailed {
        message: String,
    },
    /// The runner refused a command without affecting the running turn:
    /// a session-scoped `TURN_IN_PROGRESS` error in reply to a `send` while
    /// a turn is still active. That turn's own outcome still follows.
    Rejected {
        message: String,
    },
    TurnCancelled,
    /// The runner process is gone; no further events will arrive.
    Exited,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerError {
    Timeout,
    Exited,
    /// The runner answered with an `error` message (the runner's own wire
    /// code, e.g. `SESSION_EXISTS`).
    Remote(String),
    Transport(String),
    /// The runner sent a reply that does not match the protocol.
    Protocol(String),
    /// The request was rejected locally before being sent; carries the
    /// specific `RUNNER_*` code (e.g. `RUNNER_GUARD_REQUIRED`).
    InvalidRequest(&'static str),
    /// No runner can be started at all; carries the specific cause code
    /// (e.g. `AGENT_RUNNER_MISSING` when the bundled runner is missing).
    Unavailable(&'static str),
}

impl RunnerError {
    /// Stable machine code for this failure's category.
    pub fn code(&self) -> &'static str {
        match self {
            RunnerError::Timeout => "RUNNER_TIMEOUT",
            RunnerError::Exited => "RUNNER_EXITED",
            RunnerError::Remote(_) => "RUNNER_REMOTE_ERROR",
            RunnerError::Transport(_) => "RUNNER_TRANSPORT_ERROR",
            RunnerError::Protocol(_) => "RUNNER_PROTOCOL_ERROR",
            RunnerError::InvalidRequest(_) => "RUNNER_INVALID_REQUEST",
            RunnerError::Unavailable(_) => "RUNNER_UNAVAILABLE",
        }
    }

    /// The specific cause within [`Self::code`]'s category, when there is
    /// a machine-readable one: the `RUNNER_*` validation code of an
    /// `InvalidRequest`, the runner's wire code of a `Remote` error, or
    /// the cause code of an `Unavailable` runner.
    pub fn detail_code(&self) -> Option<&str> {
        match self {
            RunnerError::InvalidRequest(code) | RunnerError::Unavailable(code) => Some(code),
            RunnerError::Remote(code) => Some(code),
            _ => None,
        }
    }
}

impl std::fmt::Display for RunnerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunnerError::Timeout | RunnerError::Exited => f.write_str(self.code()),
            RunnerError::Remote(detail)
            | RunnerError::Transport(detail)
            | RunnerError::Protocol(detail) => write!(f, "{}: {detail}", self.code()),
            RunnerError::InvalidRequest(detail) | RunnerError::Unavailable(detail) => {
                write!(f, "{}: {detail}", self.code())
            }
        }
    }
}

crate::workflow::errors::impl_workflow_error!(RunnerError);

/// Tool permission mode for a workflow session (the runner's
/// `AgentPermission` minus AGENT CHAT's `cli-default`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerPermission {
    ReadOnly,
    FullAccess,
}

impl RunnerPermission {
    fn wire(self) -> &'static str {
        match self {
            RunnerPermission::ReadOnly => "read-only",
            RunnerPermission::FullAccess => "full-access",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StartSessionParams {
    pub session_id: String,
    pub provider: Provider,
    pub working_directory: String,
    pub permission: RunnerPermission,
    pub model: Option<String>,
    pub resume_native_id: Option<String>,
    /// Enables the runner's safety guard rooted at this absolute path.
    /// Required: [`RunnerClient::start_session`] rejects `None` with
    /// `RUNNER_GUARD_REQUIRED`.
    pub guard_workspace_root: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// A request waiting for its reply.
struct Pending {
    /// The reply `type` that resolves this request (besides `error`).
    expect: &'static str,
    reply: Sender<Result<Value, RunnerError>>,
}

#[derive(Default)]
struct State {
    ready: bool,
    dead: bool,
    pending: HashMap<String, Pending>,
    sessions: HashMap<String, Sender<RunnerEvent>>,
}

pub struct RunnerClient {
    transport: Arc<dyn RunnerTransport>,
    state: Mutex<State>,
    ready_cv: Condvar,
    next_request: AtomicU64,
}

/// Wire name of a provider (matches the runner's `RunnerProvider`).
fn provider_wire(provider: Provider) -> Value {
    serde_json::to_value(provider).expect("Provider serializes to a string")
}

/// Whether `path` is absolute: a Windows drive or UNC path, or a posix
/// absolute path (mirrors the runner's `isAbsolutePath`).
fn is_absolute_path(path: &str) -> bool {
    let b = path.as_bytes();
    let is_sep = |c: u8| c == b'\\' || c == b'/';
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && is_sep(b[2]);
    let unc = b.len() >= 3 && is_sep(b[0]) && is_sep(b[1]) && !is_sep(b[2]);
    drive || unc || path.starts_with('/')
}

fn str_field(msg: &Value, key: &str) -> Option<String> {
    msg.get(key).and_then(Value::as_str).map(str::to_string)
}

impl RunnerClient {
    pub fn new(transport: Arc<dyn RunnerTransport>) -> Arc<Self> {
        Arc::new(RunnerClient {
            transport,
            state: Mutex::new(State::default()),
            ready_cv: Condvar::new(),
            next_request: AtomicU64::new(1),
        })
    }

    /// Kills the runner process. Callers still receive the exit through
    /// [`RunnerClient::handle_exit`] once the transport reports it.
    pub fn kill(&self) {
        self.transport.kill();
    }

    /// Dispatches one stdout line from the runner.
    pub fn handle_line(&self, line: &str) {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                eprintln!("[workflow-runner] unparseable line: {line}");
                return;
            }
        };
        let Some(kind) = msg.get("type").and_then(Value::as_str) else {
            eprintln!("[workflow-runner] message without type: {line}");
            return;
        };
        if kind == "ready" {
            self.state.lock().unwrap().ready = true;
            self.ready_cv.notify_all();
            return;
        }
        if let Some(request_id) = msg.get("requestId").and_then(Value::as_str) {
            self.resolve_request(request_id, kind, &msg);
            return;
        }
        let Some(session_id) = msg.get("sessionId").and_then(Value::as_str) else {
            if kind == "error" {
                eprintln!("[workflow-runner] runner error: {line}");
            }
            return;
        };
        let event = match kind {
            "event" => RunnerEvent::Event(msg.get("event").cloned().unwrap_or(Value::Null)),
            "permission_request" => {
                // Without an id the request cannot be answered; drop it.
                let Some(permission_id) =
                    str_field(&msg, "permissionId").filter(|id| !id.is_empty())
                else {
                    eprintln!("[workflow-runner] permission_request without permissionId: {line}");
                    return;
                };
                RunnerEvent::PermissionRequest {
                    permission_id,
                    request: msg.get("request").cloned().unwrap_or(Value::Null),
                }
            }
            "guard_violation" => RunnerEvent::GuardViolation {
                rule: str_field(&msg, "rule").unwrap_or_default(),
                summary: str_field(&msg, "summary").unwrap_or_default(),
            },
            "turn_completed" => RunnerEvent::TurnCompleted {
                final_response: str_field(&msg, "finalResponse").unwrap_or_default(),
                native_session_id: str_field(&msg, "nativeSessionId"),
            },
            "error" if msg.get("message").and_then(Value::as_str) == Some("TURN_IN_PROGRESS") => {
                RunnerEvent::Rejected {
                    message: "TURN_IN_PROGRESS".to_string(),
                }
            }
            "turn_failed" | "error" => RunnerEvent::TurnFailed {
                message: str_field(&msg, "message").unwrap_or_default(),
            },
            "turn_cancelled" => RunnerEvent::TurnCancelled,
            // Unknown message types are ignored.
            _ => return,
        };
        // Clone the sender and release the lock before sending.
        let sender = self.state.lock().unwrap().sessions.get(session_id).cloned();
        if let Some(sender) = sender {
            // A dropped receiver just means nobody listens anymore.
            let _ = sender.send(event);
        }
    }

    fn resolve_request(&self, request_id: &str, kind: &str, msg: &Value) {
        let pending = {
            let mut state = self.state.lock().unwrap();
            match state.pending.get(request_id) {
                Some(p) if p.expect == kind || kind == "error" => state.pending.remove(request_id),
                _ => None,
            }
        };
        let Some(pending) = pending else { return };
        let result = if kind == "error" {
            Err(RunnerError::Remote(
                str_field(msg, "message").unwrap_or_default(),
            ))
        } else {
            Ok(msg.clone())
        };
        let _ = pending.reply.send(result);
    }

    /// The runner process is gone: fail pending requests, notify every
    /// session, and reject all further calls with [`RunnerError::Exited`].
    pub fn handle_exit(&self) {
        let (pending, sessions) = {
            let mut state = self.state.lock().unwrap();
            state.dead = true;
            (
                std::mem::take(&mut state.pending),
                std::mem::take(&mut state.sessions),
            )
        };
        self.ready_cv.notify_all();
        for (_, p) in pending {
            let _ = p.reply.send(Err(RunnerError::Exited));
        }
        for (_, s) in sessions {
            let _ = s.send(RunnerEvent::Exited);
        }
    }

    /// Blocks until the runner reports `ready`.
    pub fn wait_ready(&self, timeout: Duration) -> Result<(), RunnerError> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap();
        loop {
            if state.dead {
                return Err(RunnerError::Exited);
            }
            if state.ready {
                return Ok(());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(RunnerError::Timeout);
            }
            state = self.ready_cv.wait_timeout(state, left).unwrap().0;
        }
    }

    /// Whether the runner process has not been reported gone yet.
    pub fn is_alive(&self) -> bool {
        !self.state.lock().unwrap().dead
    }

    fn new_request_id(&self) -> String {
        format!("wf-{}", self.next_request.fetch_add(1, Ordering::Relaxed))
    }

    fn ensure_alive(&self) -> Result<(), RunnerError> {
        if self.state.lock().unwrap().dead {
            Err(RunnerError::Exited)
        } else {
            Ok(())
        }
    }

    fn write(&self, msg: &Value) -> Result<(), RunnerError> {
        self.transport
            .write_line(&msg.to_string())
            .map_err(RunnerError::Transport)
    }

    /// Sends `msg` (which must carry `request_id`) and waits for its reply.
    fn request(
        &self,
        request_id: &str,
        msg: Value,
        expect: &'static str,
        timeout: Duration,
    ) -> Result<Value, RunnerError> {
        let (tx, rx) = mpsc::channel();
        {
            let mut state = self.state.lock().unwrap();
            if state.dead {
                return Err(RunnerError::Exited);
            }
            state
                .pending
                .insert(request_id.to_string(), Pending { expect, reply: tx });
        }
        if let Err(e) = self.write(&msg) {
            self.state.lock().unwrap().pending.remove(request_id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                self.state.lock().unwrap().pending.remove(request_id);
                // The reply may have raced the timeout; prefer it.
                rx.try_recv().unwrap_or(Err(RunnerError::Timeout))
            }
        }
    }

    /// Asks the runner whether a provider is usable; returns its `Availability`.
    pub fn probe(&self, provider: Provider, timeout: Duration) -> Result<Value, RunnerError> {
        let request_id = self.new_request_id();
        let msg = json!({ "type": "probe", "requestId": request_id, "provider": provider_wire(provider) });
        let reply = self.request(&request_id, msg, "availability", timeout)?;
        reply
            .get("availability")
            .cloned()
            .ok_or_else(|| RunnerError::Protocol("availability missing".to_string()))
    }

    /// Starts a session; returns its event stream and the provider-native id.
    pub fn start_session(
        &self,
        params: StartSessionParams,
        timeout: Duration,
    ) -> Result<(Receiver<RunnerEvent>, Option<String>), RunnerError> {
        // Fail fast on requests the runner would reject anyway.
        let invalid = |code: &'static str| Err(RunnerError::InvalidRequest(code));
        if params.session_id.trim().is_empty() {
            return invalid("RUNNER_INVALID_SESSION_ID");
        }
        if params.working_directory.trim().is_empty() {
            return invalid("RUNNER_INVALID_WORKING_DIRECTORY");
        }
        if params.timeout_ms == Some(0) {
            return invalid("RUNNER_INVALID_TIMEOUT");
        }
        // Every workflow session runs under the runner's safety guard,
        // whatever its permission.
        match &params.guard_workspace_root {
            None => return invalid("RUNNER_GUARD_REQUIRED"),
            Some(root) if !is_absolute_path(root) => return invalid("RUNNER_INVALID_GUARD_ROOT"),
            Some(_) => {}
        }
        let session_id = params.session_id.clone();
        let request_id = self.new_request_id();
        let mut msg = json!({
            "type": "start_session",
            "requestId": request_id,
            "sessionId": session_id,
            "provider": provider_wire(params.provider),
            "workingDirectory": params.working_directory,
            "permission": params.permission.wire(),
        });
        if let Some(model) = params.model {
            msg["model"] = json!(model);
        }
        if let Some(native) = params.resume_native_id {
            msg["resumeNativeId"] = json!(native);
        }
        if let Some(root) = params.guard_workspace_root {
            msg["guard"] = json!({ "workspaceRoot": root });
        }
        if let Some(ms) = params.timeout_ms {
            msg["timeoutMs"] = json!(ms);
        }

        // Register the event channel before sending so no event is lost.
        let (tx, rx) = mpsc::channel();
        {
            let mut state = self.state.lock().unwrap();
            if state.dead {
                return Err(RunnerError::Exited);
            }
            if state.sessions.contains_key(&session_id) {
                // Same error the runner itself sends for a duplicate id.
                return Err(RunnerError::Remote("SESSION_EXISTS".to_string()));
            }
            state.sessions.insert(session_id.clone(), tx);
        }
        match self.request(&request_id, msg, "session_started", timeout) {
            Ok(reply) => Ok((rx, str_field(&reply, "nativeSessionId"))),
            Err(e) => {
                self.state.lock().unwrap().sessions.remove(&session_id);
                if e == RunnerError::Timeout {
                    // The session may still start later; have the runner drop it.
                    let _ =
                        self.write(&json!({ "type": "close_session", "sessionId": session_id }));
                }
                Err(e)
            }
        }
    }

    /// Starts a turn; its outcome arrives on the session's event stream.
    pub fn send(&self, session_id: &str, text: &str) -> Result<(), RunnerError> {
        self.ensure_alive()?;
        self.write(&json!({ "type": "send", "sessionId": session_id, "text": text }))
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), RunnerError> {
        self.ensure_alive()?;
        self.write(&json!({ "type": "cancel", "sessionId": session_id }))
    }

    pub fn respond_permission(
        &self,
        session_id: &str,
        permission_id: &str,
        allow: bool,
    ) -> Result<(), RunnerError> {
        self.ensure_alive()?;
        self.write(&json!({
            "type": "respond_permission",
            "sessionId": session_id,
            "permissionId": permission_id,
            "allow": allow,
        }))
    }

    /// Closes a session and stops delivering its events.
    pub fn close_session(&self, session_id: &str) -> Result<(), RunnerError> {
        self.state.lock().unwrap().sessions.remove(session_id);
        self.ensure_alive()?;
        self.write(&json!({ "type": "close_session", "sessionId": session_id }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    const WAIT: Duration = Duration::from_secs(5);

    /// Records written lines and forwards them to the test.
    struct FakeTransport {
        lines: Mutex<Vec<String>>,
        written: Mutex<Sender<String>>,
        fail_writes: std::sync::atomic::AtomicBool,
        killed: std::sync::atomic::AtomicBool,
    }

    impl RunnerTransport for FakeTransport {
        fn write_line(&self, line: &str) -> Result<(), String> {
            if self.fail_writes.load(Ordering::SeqCst) {
                return Err("broken pipe".to_string());
            }
            self.lines.lock().unwrap().push(line.to_string());
            let _ = self.written.lock().unwrap().send(line.to_string());
            Ok(())
        }
        fn kill(&self) {
            self.killed.store(true, Ordering::SeqCst);
        }
    }

    fn setup() -> (Arc<RunnerClient>, Arc<FakeTransport>, Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        let transport = Arc::new(FakeTransport {
            lines: Mutex::new(vec![]),
            written: Mutex::new(tx),
            fail_writes: Default::default(),
            killed: Default::default(),
        });
        (RunnerClient::new(transport.clone()), transport, rx)
    }

    fn next_msg(rx: &Receiver<String>) -> Value {
        serde_json::from_str(&rx.recv_timeout(WAIT).expect("a line was written")).unwrap()
    }

    fn params(session_id: &str) -> StartSessionParams {
        StartSessionParams {
            session_id: session_id.to_string(),
            provider: Provider::Claude,
            working_directory: "C:/work".to_string(),
            permission: RunnerPermission::FullAccess,
            model: Some("m1".to_string()),
            resume_native_id: None,
            guard_workspace_root: Some("C:/work".to_string()),
            timeout_ms: Some(1000),
        }
    }

    /// Starts `session_id` and answers with `session_started`.
    fn start(
        client: &Arc<RunnerClient>,
        rx: &Receiver<String>,
        session_id: &str,
    ) -> Receiver<RunnerEvent> {
        let c = client.clone();
        let p = params(session_id);
        let h = thread::spawn(move || c.start_session(p, WAIT));
        let msg = next_msg(rx);
        client.handle_line(
            &json!({ "type": "session_started", "requestId": msg["requestId"], "sessionId": session_id })
                .to_string(),
        );
        h.join().unwrap().unwrap().0
    }

    #[test]
    fn provider_wire_names_match_runner_provider() {
        assert_eq!(provider_wire(Provider::Codex), json!("codex"));
        assert_eq!(provider_wire(Provider::Copilot), json!("copilot"));
        assert_eq!(provider_wire(Provider::Opencode), json!("opencode"));
        assert_eq!(provider_wire(Provider::Claude), json!("claude"));
    }

    #[test]
    fn wait_ready_resolves_on_ready_line() {
        let (client, _t, _rx) = setup();
        let c = client.clone();
        let h = thread::spawn(move || c.wait_ready(WAIT));
        thread::sleep(Duration::from_millis(50));
        client.handle_line(r#"{"type":"ready"}"#);
        assert_eq!(h.join().unwrap(), Ok(()));
        // Already ready: returns immediately.
        assert_eq!(client.wait_ready(Duration::ZERO), Ok(()));
    }

    #[test]
    fn wait_ready_times_out() {
        let (client, _t, _rx) = setup();
        assert_eq!(
            client.wait_ready(Duration::from_millis(30)),
            Err(RunnerError::Timeout)
        );
    }

    #[test]
    fn concurrent_probes_resolve_by_request_id() {
        let (client, _t, rx) = setup();
        let c1 = client.clone();
        let h1 = thread::spawn(move || c1.probe(Provider::Codex, WAIT));
        let m1 = next_msg(&rx);
        let c2 = client.clone();
        let h2 = thread::spawn(move || c2.probe(Provider::Claude, WAIT));
        let m2 = next_msg(&rx);
        assert_eq!(m1["type"], "probe");
        assert_eq!(m1["provider"], "codex");
        assert_eq!(m2["provider"], "claude");
        assert_ne!(m1["requestId"], m2["requestId"]);

        // Answer in reverse order; a reply of the wrong type is ignored.
        client.handle_line(
            &json!({ "type": "session_list", "requestId": m2["requestId"], "sessions": [] })
                .to_string(),
        );
        client.handle_line(
            &json!({ "type": "availability", "requestId": m2["requestId"], "provider": "claude",
                     "availability": { "kind": "missing", "detail": "x" } })
            .to_string(),
        );
        client.handle_line(
            &json!({ "type": "availability", "requestId": m1["requestId"], "provider": "codex",
                     "availability": { "kind": "available", "version": "1.0" } })
            .to_string(),
        );
        assert_eq!(
            h1.join().unwrap().unwrap(),
            json!({ "kind": "available", "version": "1.0" })
        );
        assert_eq!(
            h2.join().unwrap().unwrap(),
            json!({ "kind": "missing", "detail": "x" })
        );
    }

    #[test]
    fn probe_times_out_and_error_reply_is_remote() {
        let (client, _t, rx) = setup();
        assert_eq!(
            client.probe(Provider::Codex, Duration::from_millis(30)),
            Err(RunnerError::Timeout)
        );
        let _ = next_msg(&rx);

        let c = client.clone();
        let h = thread::spawn(move || c.probe(Provider::Codex, WAIT));
        let m = next_msg(&rx);
        client.handle_line(
            &json!({ "type": "error", "requestId": m["requestId"], "message": "PROVIDER_UNAVAILABLE" }).to_string(),
        );
        let err = h.join().unwrap().unwrap_err();
        assert_eq!(err, RunnerError::Remote("PROVIDER_UNAVAILABLE".to_string()));
        assert_eq!(err.code(), "RUNNER_REMOTE_ERROR");
        assert_eq!(err.detail_code(), Some("PROVIDER_UNAVAILABLE"));
    }

    #[test]
    fn start_session_sends_full_request_and_returns_native_id() {
        let (client, _t, rx) = setup();
        let c = client.clone();
        let h = thread::spawn(move || c.start_session(params("s1"), WAIT));
        let m = next_msg(&rx);
        assert_eq!(m["type"], "start_session");
        assert_eq!(m["sessionId"], "s1");
        assert_eq!(m["provider"], "claude");
        assert_eq!(m["workingDirectory"], "C:/work");
        assert_eq!(m["permission"], "full-access");
        assert_eq!(m["model"], "m1");
        assert_eq!(m["guard"], json!({ "workspaceRoot": "C:/work" }));
        assert_eq!(m["timeoutMs"], 1000);
        assert!(m.get("resumeNativeId").is_none());
        // An event arriving right after session_started is not lost.
        client.handle_line(
            &json!({ "type": "session_started", "requestId": m["requestId"], "sessionId": "s1",
                     "nativeSessionId": "native-1" })
            .to_string(),
        );
        client.handle_line(r#"{"type":"turn_cancelled","sessionId":"s1"}"#);
        let (events, native) = h.join().unwrap().unwrap();
        assert_eq!(native.as_deref(), Some("native-1"));
        assert_eq!(
            events.recv_timeout(WAIT).unwrap(),
            RunnerEvent::TurnCancelled
        );
    }

    #[test]
    fn start_session_error_reply_is_remote_and_unregisters() {
        let (client, _t, rx) = setup();
        let c = client.clone();
        let h = thread::spawn(move || c.start_session(params("s1"), WAIT));
        let m = next_msg(&rx);
        client.handle_line(
            &json!({ "type": "error", "requestId": m["requestId"], "sessionId": "s1", "message": "SESSION_EXISTS" })
                .to_string(),
        );
        assert_eq!(
            h.join().unwrap().unwrap_err(),
            RunnerError::Remote("SESSION_EXISTS".to_string())
        );
        // The id can be reused.
        let _events = start(&client, &rx, "s1");
    }

    #[test]
    fn start_session_timeout_closes_the_late_session() {
        let (client, _t, rx) = setup();
        let err = client
            .start_session(params("s1"), Duration::from_millis(30))
            .unwrap_err();
        assert_eq!(err, RunnerError::Timeout);
        assert_eq!(next_msg(&rx)["type"], "start_session");
        assert_eq!(
            next_msg(&rx),
            json!({ "type": "close_session", "sessionId": "s1" })
        );
    }

    #[test]
    fn events_are_routed_to_their_session_only() {
        let (client, _t, rx) = setup();
        let a = start(&client, &rx, "a");
        let b = start(&client, &rx, "b");
        client.handle_line(
            r#"{"type":"event","sessionId":"a","event":{"type":"assistant_delta","text":"hi"}}"#,
        );
        client.handle_line(
            r#"{"type":"permission_request","sessionId":"b","permissionId":"p1","request":{"kind":"shell","summary":"ls"}}"#,
        );
        assert_eq!(
            a.recv_timeout(WAIT).unwrap(),
            RunnerEvent::Event(json!({ "type": "assistant_delta", "text": "hi" }))
        );
        assert_eq!(
            b.recv_timeout(WAIT).unwrap(),
            RunnerEvent::PermissionRequest {
                permission_id: "p1".to_string(),
                request: json!({ "kind": "shell", "summary": "ls" }),
            }
        );
        assert!(a.try_recv().is_err());
        assert!(b.try_recv().is_err());
    }

    #[test]
    fn turn_outcomes_and_guard_violation_are_mapped() {
        let (client, _t, rx) = setup();
        let s = start(&client, &rx, "s");
        client.handle_line(r#"{"type":"guard_violation","sessionId":"s","rule":"git-remote","summary":"git push"}"#);
        client.handle_line(r#"{"type":"turn_failed","sessionId":"s","message":"GUARD_BLOCKED"}"#);
        client.handle_line(r#"{"type":"turn_completed","sessionId":"s","finalResponse":"done","nativeSessionId":"n"}"#);
        client.handle_line(r#"{"type":"turn_completed","sessionId":"s","finalResponse":"again"}"#);
        client.handle_line(r#"{"type":"error","sessionId":"s","message":"TURN_IN_PROGRESS"}"#);
        client.handle_line(r#"{"type":"error","sessionId":"s","message":"NO_SESSION"}"#);
        let got: Vec<RunnerEvent> = (0..6).map(|_| s.recv_timeout(WAIT).unwrap()).collect();
        assert_eq!(
            got,
            vec![
                RunnerEvent::GuardViolation {
                    rule: "git-remote".to_string(),
                    summary: "git push".to_string()
                },
                RunnerEvent::TurnFailed {
                    message: "GUARD_BLOCKED".to_string()
                },
                RunnerEvent::TurnCompleted {
                    final_response: "done".to_string(),
                    native_session_id: Some("n".to_string())
                },
                RunnerEvent::TurnCompleted {
                    final_response: "again".to_string(),
                    native_session_id: None
                },
                RunnerEvent::Rejected {
                    message: "TURN_IN_PROGRESS".to_string()
                },
                RunnerEvent::TurnFailed {
                    message: "NO_SESSION".to_string()
                },
            ]
        );
    }

    #[test]
    fn start_session_rejects_invalid_params_without_writing() {
        let (client, _t, rx) = setup();
        let cases: Vec<(StartSessionParams, &str)> = vec![
            (
                StartSessionParams {
                    session_id: " ".to_string(),
                    ..params("s")
                },
                "RUNNER_INVALID_SESSION_ID",
            ),
            (
                StartSessionParams {
                    working_directory: String::new(),
                    ..params("s")
                },
                "RUNNER_INVALID_WORKING_DIRECTORY",
            ),
            (
                StartSessionParams {
                    timeout_ms: Some(0),
                    ..params("s")
                },
                "RUNNER_INVALID_TIMEOUT",
            ),
            (
                StartSessionParams {
                    guard_workspace_root: Some("relative/dir".to_string()),
                    ..params("s")
                },
                "RUNNER_INVALID_GUARD_ROOT",
            ),
            (
                StartSessionParams {
                    guard_workspace_root: Some("C:relative".to_string()),
                    ..params("s")
                },
                "RUNNER_INVALID_GUARD_ROOT",
            ),
            (
                StartSessionParams {
                    guard_workspace_root: None,
                    ..params("s")
                },
                "RUNNER_GUARD_REQUIRED",
            ),
            (
                StartSessionParams {
                    permission: RunnerPermission::ReadOnly,
                    guard_workspace_root: None,
                    ..params("s")
                },
                "RUNNER_GUARD_REQUIRED",
            ),
        ];
        for (p, code) in cases {
            let err = client.start_session(p, WAIT).unwrap_err();
            assert_eq!(err, RunnerError::InvalidRequest(code));
            assert_eq!(err.code(), "RUNNER_INVALID_REQUEST");
            assert_eq!(err.detail_code(), Some(code));
        }
        assert!(rx.try_recv().is_err(), "nothing may be written");
        // The id stays usable after a rejected start.
        let _s = start(&client, &rx, "s");
    }

    #[test]
    fn guard_root_accepts_drive_unc_and_posix_paths() {
        for root in [r"C:\work", "d:/work", r"\\server\share", "/home/u/work"] {
            assert!(is_absolute_path(root), "{root}");
        }
        for root in ["", "work", "C:work", r"\\", "./work"] {
            assert!(!is_absolute_path(root), "{root}");
        }
    }

    #[test]
    fn duplicate_local_session_is_remote_session_exists() {
        let (client, _t, rx) = setup();
        let _s = start(&client, &rx, "s");
        assert_eq!(
            client.start_session(params("s"), WAIT).unwrap_err(),
            RunnerError::Remote("SESSION_EXISTS".to_string())
        );
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn permission_request_without_id_is_dropped() {
        let (client, _t, rx) = setup();
        let s = start(&client, &rx, "s");
        client.handle_line(
            r#"{"type":"permission_request","sessionId":"s","request":{"kind":"shell"}}"#,
        );
        client.handle_line(
            r#"{"type":"permission_request","sessionId":"s","permissionId":"","request":{}}"#,
        );
        client.handle_line(r#"{"type":"turn_cancelled","sessionId":"s"}"#);
        assert_eq!(s.recv_timeout(WAIT).unwrap(), RunnerEvent::TurnCancelled);
    }

    #[test]
    fn session_commands_write_protocol_lines() {
        let (client, _t, rx) = setup();
        let _s = start(&client, &rx, "s");
        client.send("s", "do it").unwrap();
        client.cancel("s").unwrap();
        client.respond_permission("s", "p1", true).unwrap();
        assert_eq!(
            next_msg(&rx),
            json!({ "type": "send", "sessionId": "s", "text": "do it" })
        );
        assert_eq!(next_msg(&rx), json!({ "type": "cancel", "sessionId": "s" }));
        assert_eq!(
            next_msg(&rx),
            json!({ "type": "respond_permission", "sessionId": "s", "permissionId": "p1", "allow": true })
        );
    }

    #[test]
    fn close_session_stops_delivery() {
        let (client, _t, rx) = setup();
        let s = start(&client, &rx, "s");
        client.close_session("s").unwrap();
        assert_eq!(
            next_msg(&rx),
            json!({ "type": "close_session", "sessionId": "s" })
        );
        client.handle_line(r#"{"type":"turn_cancelled","sessionId":"s"}"#);
        assert!(s.recv_timeout(Duration::from_millis(30)).is_err());
    }

    #[test]
    fn dropped_receiver_and_bad_lines_do_not_panic() {
        let (client, _t, rx) = setup();
        drop(start(&client, &rx, "s"));
        client.handle_line(r#"{"type":"turn_cancelled","sessionId":"s"}"#);
        client.handle_line("not json");
        client.handle_line(r#"{"no":"type"}"#);
        client.handle_line(r#"{"type":"mystery","sessionId":"s"}"#);
        client.handle_line(r#"{"type":"availability","requestId":"unknown"}"#);
        client.handle_line(r#"{"type":"ready"}"#);
        assert_eq!(client.wait_ready(Duration::ZERO), Ok(()));
    }

    #[test]
    fn transport_failure_is_reported_and_clears_pending() {
        let (client, t, _rx) = setup();
        t.fail_writes.store(true, Ordering::SeqCst);
        let err = client.probe(Provider::Codex, WAIT).unwrap_err();
        assert_eq!(err, RunnerError::Transport("broken pipe".to_string()));
        assert!(client.state.lock().unwrap().pending.is_empty());
        assert_eq!(
            client.send("s", "x").unwrap_err().code(),
            "RUNNER_TRANSPORT_ERROR"
        );
    }

    #[test]
    fn handle_exit_fails_pending_and_notifies_sessions() {
        let (client, t, rx) = setup();
        let s = start(&client, &rx, "s");
        let c = client.clone();
        let probe = thread::spawn(move || c.probe(Provider::Codex, WAIT));
        let _ = next_msg(&rx);
        let c = client.clone();
        let ready = thread::spawn(move || c.wait_ready(WAIT));
        thread::sleep(Duration::from_millis(50));

        client.handle_exit();
        assert_eq!(probe.join().unwrap(), Err(RunnerError::Exited));
        assert_eq!(ready.join().unwrap(), Err(RunnerError::Exited));
        assert_eq!(s.recv_timeout(WAIT).unwrap(), RunnerEvent::Exited);

        // After exit every call fails with Exited and nothing is written.
        assert_eq!(client.wait_ready(WAIT), Err(RunnerError::Exited));
        assert_eq!(
            client.probe(Provider::Codex, WAIT),
            Err(RunnerError::Exited)
        );
        assert_eq!(
            client.start_session(params("t"), WAIT).unwrap_err(),
            RunnerError::Exited
        );
        assert_eq!(client.send("s", "x"), Err(RunnerError::Exited));
        assert_eq!(client.cancel("s"), Err(RunnerError::Exited));
        assert_eq!(
            client.respond_permission("s", "p", false),
            Err(RunnerError::Exited)
        );
        assert_eq!(client.close_session("s"), Err(RunnerError::Exited));
        assert_eq!(RunnerError::Exited.code(), "RUNNER_EXITED");
        assert!(rx.try_recv().is_err());
        assert!(!t.killed.load(Ordering::SeqCst));
        client.kill();
        assert!(t.killed.load(Ordering::SeqCst));
    }
}

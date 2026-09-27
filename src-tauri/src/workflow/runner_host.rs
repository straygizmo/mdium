//! Hosts the one contained workflow runner process.
//!
//! [`RunnerHost`] lazily spawns the runner (through a [`RunnerSpawner`]),
//! waits for its `ready` line, reuses it while it is alive, and respawns it
//! after it exits. Every call goes through the [`RunnerApi`] trait so the
//! orchestrator can be tested against a fake runner.

use crate::commands::node_sidecar;
use crate::workflow::containment::containment_env;
use crate::workflow::model::Provider;
use crate::workflow::runner_client::{
    RunnerClient, RunnerError, RunnerEvent, RunnerTransport, StartSessionParams,
};
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// How long a freshly spawned runner may take to report `ready`.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Longest runner stderr line forwarded to the log, in chars.
const STDERR_LINE_MAX_CHARS: usize = 500;

/// Cuts `line` to at most `max` chars (never inside a char).
fn truncate_chars(line: &str, max: usize) -> &str {
    match line.char_indices().nth(max) {
        Some((end, _)) => &line[..end],
        None => line,
    }
}

/// The runner operations the orchestrator uses.
pub trait RunnerApi: Send + Sync {
    fn start_session(
        &self,
        params: StartSessionParams,
        timeout: Duration,
    ) -> Result<(Receiver<RunnerEvent>, Option<String>), RunnerError>;
    /// Starts a turn; `images` are absolute image paths inside the session's workspace root.
    fn send(&self, session_id: &str, text: &str, images: &[String]) -> Result<(), RunnerError>;
    fn cancel(&self, session_id: &str) -> Result<(), RunnerError>;
    fn respond_permission(
        &self,
        session_id: &str,
        permission_id: &str,
        allow: bool,
    ) -> Result<(), RunnerError>;
    fn close_session(&self, session_id: &str) -> Result<(), RunnerError>;
    fn probe(
        &self,
        provider: Provider,
        timeout: Duration,
    ) -> Result<serde_json::Value, RunnerError>;
    fn shutdown(&self);
}

pub trait RunnerSpawner: Send + Sync {
    /// Starts a runner process; lines/exit must be forwarded to the returned client.
    fn spawn(&self) -> Result<Arc<RunnerClient>, String>;
}

/// [`RunnerTransport`] over a sidecar whose id is only known once the
/// process has been spawned (the client must exist before the spawn so that
/// no stdout line is lost).
struct LateSidecarTransport {
    id: OnceLock<u32>,
}

impl RunnerTransport for LateSidecarTransport {
    fn write_line(&self, line: &str) -> Result<(), String> {
        match self.id.get() {
            Some(id) => node_sidecar::write(*id, line),
            None => Err("sidecar not running".to_string()),
        }
    }

    fn kill(&self) {
        if let Some(id) = self.id.get() {
            if let Err(e) = node_sidecar::kill(*id) {
                eprintln!("[workflow-runner] kill failed: {e}");
            }
        }
    }
}

/// Production spawner: runs the bundled agent runner under `node` with the
/// containment environment rooted at `data_dir`.
pub struct SidecarSpawner {
    pub script_path: String,
    pub data_dir: PathBuf,
}

impl RunnerSpawner for SidecarSpawner {
    fn spawn(&self) -> Result<Arc<RunnerClient>, String> {
        let env =
            containment_env(&self.data_dir).map_err(|e| format!("containment env failed: {e}"))?;
        let transport = Arc::new(LateSidecarTransport {
            id: OnceLock::new(),
        });
        let client = RunnerClient::new(transport.clone());
        let on_line_client = client.clone();
        let on_exit_client = client.clone();
        let id = node_sidecar::spawn_with_handlers(
            &self.script_path,
            &env,
            Box::new(move |line| on_line_client.handle_line(&line)),
            Box::new(|line| {
                eprintln!(
                    "[workflow-runner] {}",
                    truncate_chars(&line, STDERR_LINE_MAX_CHARS)
                )
            }),
            Box::new(move |_code| on_exit_client.handle_exit()),
        )?;
        let _ = transport.id.set(id);
        Ok(client)
    }
}

#[derive(Default)]
struct HostState {
    current: Option<Arc<RunnerClient>>,
    /// A client that has been spawned but has not reported `ready` yet.
    starting: Option<Arc<RunnerClient>>,
    shut_down: bool,
}

pub struct RunnerHost {
    spawner: Box<dyn RunnerSpawner>,
    state: Mutex<HostState>,
    /// Serializes spawning: only one runner is started at a time.
    spawn_lock: Mutex<()>,
    ready_timeout: Duration,
}

impl RunnerHost {
    pub fn new(spawner: Box<dyn RunnerSpawner>) -> Self {
        Self::with_ready_timeout(spawner, READY_TIMEOUT)
    }

    fn with_ready_timeout(spawner: Box<dyn RunnerSpawner>, ready_timeout: Duration) -> Self {
        RunnerHost {
            spawner,
            state: Mutex::new(HostState::default()),
            spawn_lock: Mutex::new(()),
            ready_timeout,
        }
    }

    /// The live client, if there is one; fails once the host is shut down.
    fn live_client(&self) -> Result<Option<Arc<RunnerClient>>, RunnerError> {
        let state = self.state.lock().unwrap();
        if state.shut_down {
            return Err(RunnerError::Exited);
        }
        Ok(state.current.clone().filter(|c| c.is_alive()))
    }

    /// The live client for a session-scoped call. Never spawns: a new runner
    /// would not know the session, so no live runner means [`RunnerError::Exited`].
    fn session_client(&self) -> Result<Arc<RunnerClient>, RunnerError> {
        self.live_client()?.ok_or(RunnerError::Exited)
    }

    /// Returns the running client, spawning (and waiting for) a new one when
    /// there is none or the previous one has exited.
    fn client(&self) -> Result<Arc<RunnerClient>, RunnerError> {
        if let Some(client) = self.live_client()? {
            return Ok(client);
        }
        let _spawning = self.spawn_lock.lock().unwrap();
        // Another caller may have spawned while this one waited.
        if let Some(client) = self.live_client()? {
            return Ok(client);
        }
        let client = self.spawner.spawn().map_err(RunnerError::Transport)?;
        {
            let mut state = self.state.lock().unwrap();
            if state.shut_down {
                drop(state);
                client.kill();
                return Err(RunnerError::Exited);
            }
            state.current = None;
            state.starting = Some(client.clone());
        }
        let ready = client.wait_ready(self.ready_timeout);
        let mut state = self.state.lock().unwrap();
        state.starting = None;
        if state.shut_down {
            drop(state);
            client.kill();
            return Err(RunnerError::Exited);
        }
        match ready {
            Ok(()) => {
                state.current = Some(client.clone());
                Ok(client)
            }
            Err(e) => {
                drop(state);
                // Do not leave a runner behind that never became ready.
                client.kill();
                // Fail anything still waiting on it right away.
                client.handle_exit();
                Err(RunnerError::Transport(e.to_string()))
            }
        }
    }
}

impl RunnerApi for RunnerHost {
    fn start_session(
        &self,
        params: StartSessionParams,
        timeout: Duration,
    ) -> Result<(Receiver<RunnerEvent>, Option<String>), RunnerError> {
        self.client()?.start_session(params, timeout)
    }

    fn send(&self, session_id: &str, text: &str, images: &[String]) -> Result<(), RunnerError> {
        self.session_client()?.send(session_id, text, images)
    }

    fn cancel(&self, session_id: &str) -> Result<(), RunnerError> {
        self.session_client()?.cancel(session_id)
    }

    fn respond_permission(
        &self,
        session_id: &str,
        permission_id: &str,
        allow: bool,
    ) -> Result<(), RunnerError> {
        self.session_client()?
            .respond_permission(session_id, permission_id, allow)
    }

    fn close_session(&self, session_id: &str) -> Result<(), RunnerError> {
        self.session_client()?.close_session(session_id)
    }

    fn probe(
        &self,
        provider: Provider,
        timeout: Duration,
    ) -> Result<serde_json::Value, RunnerError> {
        self.client()?.probe(provider, timeout)
    }

    /// Kills the runner (including one still starting up) and refuses every
    /// further call with [`RunnerError::Exited`].
    fn shutdown(&self) {
        let clients = {
            let mut state = self.state.lock().unwrap();
            state.shut_down = true;
            [state.current.take(), state.starting.take()]
        };
        for client in clients.into_iter().flatten() {
            client.kill();
            // Fail pending waits now instead of when the exit is reported.
            client.handle_exit();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Weak;
    use std::thread;

    const WAIT: Duration = Duration::from_secs(5);

    /// A call that may spawn the runner.
    fn probe(host: &RunnerHost) -> Result<serde_json::Value, RunnerError> {
        host.probe(Provider::Codex, WAIT)
    }

    fn params(session_id: &str) -> StartSessionParams {
        StartSessionParams {
            session_id: session_id.to_string(),
            provider: Provider::Claude,
            working_directory: "C:/work".to_string(),
            permission: crate::workflow::runner_client::RunnerPermission::ReadOnly,
            model: None,
            resume_native_id: None,
            guard_workspace_root: Some("C:/work".to_string()),
            timeout_ms: None,
        }
    }

    /// Records written lines and answers probes like the runner would.
    #[derive(Default)]
    struct FakeTransport {
        lines: Mutex<Vec<String>>,
        killed: AtomicBool,
        client: OnceLock<Weak<RunnerClient>>,
    }

    impl RunnerTransport for FakeTransport {
        fn write_line(&self, line: &str) -> Result<(), String> {
            self.lines.lock().unwrap().push(line.to_string());
            let msg: serde_json::Value = serde_json::from_str(line).unwrap();
            if msg["type"] == "probe" {
                if let Some(client) = self.client.get().and_then(Weak::upgrade) {
                    client.handle_line(
                        &serde_json::json!({ "type": "availability", "requestId": msg["requestId"],
                                             "availability": { "kind": "available" } })
                        .to_string(),
                    );
                }
            }
            Ok(())
        }
        fn kill(&self) {
            self.killed.store(true, Ordering::SeqCst);
        }
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Ready,
        NeverReady,
        Fail,
    }

    /// Spawns clients over fake transports and records them.
    struct FakeSpawner {
        mode: Mutex<Mode>,
        spawns: AtomicUsize,
        spawned: Mutex<Vec<(Arc<RunnerClient>, Arc<FakeTransport>)>>,
    }

    impl RunnerSpawner for Arc<FakeSpawner> {
        fn spawn(&self) -> Result<Arc<RunnerClient>, String> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            let mode = *self.mode.lock().unwrap();
            if mode == Mode::Fail {
                return Err("node not found".to_string());
            }
            let transport = Arc::new(FakeTransport::default());
            let client = RunnerClient::new(transport.clone());
            let _ = transport.client.set(Arc::downgrade(&client));
            if mode == Mode::Ready {
                client.handle_line(r#"{"type":"ready"}"#);
            }
            self.spawned
                .lock()
                .unwrap()
                .push((client.clone(), transport));
            Ok(client)
        }
    }

    fn host(mode: Mode, ready_timeout: Duration) -> (RunnerHost, Arc<FakeSpawner>) {
        let spawner = Arc::new(FakeSpawner {
            mode: Mutex::new(mode),
            spawns: AtomicUsize::new(0),
            spawned: Mutex::new(vec![]),
        });
        (
            RunnerHost::with_ready_timeout(Box::new(spawner.clone()), ready_timeout),
            spawner,
        )
    }

    fn spawned(s: &FakeSpawner, i: usize) -> (Arc<RunnerClient>, Arc<FakeTransport>) {
        s.spawned.lock().unwrap()[i].clone()
    }

    #[test]
    fn first_call_spawns_once_and_later_calls_reuse() {
        let (host, s) = host(Mode::Ready, WAIT);
        assert_eq!(
            probe(&host).unwrap(),
            serde_json::json!({ "kind": "available" })
        );
        assert_eq!(s.spawns.load(Ordering::SeqCst), 1);
        probe(&host).unwrap();
        host.send("s", "one", &[]).unwrap();
        host.cancel("s").unwrap();
        host.respond_permission("s", "p", true).unwrap();
        host.close_session("s").unwrap();
        assert_eq!(s.spawns.load(Ordering::SeqCst), 1);
        let (_, t) = spawned(&s, 0);
        let lines = t.lines.lock().unwrap();
        assert_eq!(lines.len(), 6);
        assert!(lines[2].contains(r#""type":"send""#));
    }

    #[test]
    fn concurrent_first_calls_spawn_once() {
        let (host, s) = host(Mode::Ready, WAIT);
        let host = Arc::new(host);
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let h = host.clone();
                thread::spawn(move || probe(&h))
            })
            .collect();
        for h in handles {
            h.join().unwrap().unwrap();
        }
        assert_eq!(s.spawns.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn session_calls_never_spawn() {
        let (host, s) = host(Mode::Ready, WAIT);
        // No runner yet.
        assert_eq!(host.send("s", "x", &[]), Err(RunnerError::Exited));
        assert_eq!(host.cancel("s"), Err(RunnerError::Exited));
        assert_eq!(
            host.respond_permission("s", "p", false),
            Err(RunnerError::Exited)
        );
        assert_eq!(host.close_session("s"), Err(RunnerError::Exited));
        assert_eq!(s.spawns.load(Ordering::SeqCst), 0);

        // The runner that knew the session is gone: still no respawn.
        probe(&host).unwrap();
        let (first, _) = spawned(&s, 0);
        first.handle_exit();
        assert_eq!(host.send("s", "x", &[]), Err(RunnerError::Exited));
        assert_eq!(host.cancel("s"), Err(RunnerError::Exited));
        assert_eq!(
            host.respond_permission("s", "p", true),
            Err(RunnerError::Exited)
        );
        assert_eq!(host.close_session("s"), Err(RunnerError::Exited));
        assert_eq!(s.spawns.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn respawns_after_the_runner_exits() {
        let (host, s) = host(Mode::Ready, WAIT);
        probe(&host).unwrap();
        let (first, _) = spawned(&s, 0);
        first.handle_exit();
        probe(&host).unwrap();
        assert_eq!(s.spawns.load(Ordering::SeqCst), 2);
        let (_, t2) = spawned(&s, 1);
        assert_eq!(t2.lines.lock().unwrap().len(), 1);

        // start_session spawns too (the fake never confirms the session).
        spawned(&s, 1).0.handle_exit();
        let err = host
            .start_session(params("s"), Duration::from_millis(30))
            .unwrap_err();
        assert_eq!(err, RunnerError::Timeout);
        assert_eq!(s.spawns.load(Ordering::SeqCst), 3);
        let (_, t3) = spawned(&s, 2);
        assert!(t3.lines.lock().unwrap()[0].contains(r#""type":"start_session""#));
    }

    #[test]
    fn spawn_failure_is_transport_error() {
        let (host, s) = host(Mode::Fail, WAIT);
        assert_eq!(
            probe(&host),
            Err(RunnerError::Transport("node not found".to_string()))
        );
        // The next spawning call tries again.
        *s.mode.lock().unwrap() = Mode::Ready;
        probe(&host).unwrap();
        assert_eq!(s.spawns.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn ready_timeout_kills_the_runner_and_keeps_no_client() {
        let (host, s) = host(Mode::NeverReady, Duration::from_millis(30));
        assert_eq!(
            probe(&host),
            Err(RunnerError::Transport("RUNNER_TIMEOUT".to_string()))
        );
        let (client, t) = spawned(&s, 0);
        assert!(t.killed.load(Ordering::SeqCst));
        assert!(!client.is_alive());
        assert!(t.lines.lock().unwrap().is_empty());
        assert!(host.state.lock().unwrap().current.is_none());
        assert!(host.state.lock().unwrap().starting.is_none());

        *s.mode.lock().unwrap() = Mode::Ready;
        probe(&host).unwrap();
        assert_eq!(s.spawns.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn shutdown_kills_the_runner_and_refuses_further_calls() {
        let (host, s) = host(Mode::Ready, WAIT);
        probe(&host).unwrap();
        host.shutdown();
        let (client, t) = spawned(&s, 0);
        assert!(t.killed.load(Ordering::SeqCst));
        assert!(!client.is_alive());
        assert_eq!(host.send("s", "y", &[]), Err(RunnerError::Exited));
        assert_eq!(probe(&host), Err(RunnerError::Exited));
        assert_eq!(
            host.start_session(params("s"), WAIT).unwrap_err(),
            RunnerError::Exited
        );
        assert_eq!(host.close_session("s"), Err(RunnerError::Exited));
        assert_eq!(s.spawns.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn shutdown_while_starting_kills_the_starting_runner() {
        let (host, s) = host(Mode::NeverReady, Duration::from_secs(20));
        let host = Arc::new(host);
        let h = host.clone();
        let call = thread::spawn(move || probe(&h));
        while s.spawns.load(Ordering::SeqCst) == 0 || host.state.lock().unwrap().starting.is_none()
        {
            thread::sleep(Duration::from_millis(5));
        }
        host.shutdown();
        assert_eq!(call.join().unwrap(), Err(RunnerError::Exited));
        let (_, t) = spawned(&s, 0);
        assert!(t.killed.load(Ordering::SeqCst));
        assert!(t.lines.lock().unwrap().is_empty());
    }

    #[test]
    fn stderr_lines_are_cut_on_a_char_boundary() {
        assert_eq!(truncate_chars("short", 500), "short");
        let long = "\u{3042}".repeat(600);
        let cut = truncate_chars(&long, STDERR_LINE_MAX_CHARS);
        assert_eq!(cut.chars().count(), 500);
        assert_eq!(truncate_chars(&"a".repeat(500), 500).len(), 500);
    }

    /// Runs the real bundled runner. Needs `node` on PATH and the bundle
    /// built by `npm run build:sidecar`; run with `--ignored`.
    #[test]
    #[ignore]
    fn sidecar_spawner_starts_the_bundled_runner() {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("agent-runner")
            .join("agent-runner.mjs");
        assert!(script.exists(), "build the runner bundle first");
        let tmp = tempfile::TempDir::new().unwrap();
        let host = RunnerHost::new(Box::new(SidecarSpawner {
            script_path: script.to_str().unwrap().to_string(),
            data_dir: tmp.path().join("data"),
        }));
        let availability = host
            .probe(Provider::Codex, Duration::from_secs(60))
            .expect("probe answered");
        assert!(availability.get("kind").is_some(), "{availability}");
        host.shutdown();
        assert_eq!(
            host.probe(Provider::Codex, Duration::from_secs(1)),
            Err(RunnerError::Exited)
        );
    }
}

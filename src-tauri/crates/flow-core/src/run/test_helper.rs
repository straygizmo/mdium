//! A small "external command" for engine tests, implemented by the test
//! binary itself: a test that does nothing unless `FLOW_TEST_HELPER` holds
//! a JSON step script, in which case it runs the script and exits the
//! process. Cross-platform and needs no extra binary.

use serde_json::{json, Value};
use std::io::Write;
use std::time::{Duration, Instant};

const TEST_NAME: &str = "run::test_helper::flow_test_helper_entry";

/// argv that runs `steps` as a command node.
pub fn helper_argv() -> Vec<String> {
    let exe = std::env::current_exe().expect("test exe");
    vec![
        exe.to_string_lossy().into_owned(),
        "--exact".into(),
        TEST_NAME.into(),
        "--nocapture".into(),
        "--test-threads=1".into(),
        "--quiet".into(),
    ]
}

/// The env entry that carries the script.
pub fn helper_env(steps: &[Value]) -> (String, String) {
    (
        "FLOW_TEST_HELPER".to_string(),
        Value::from(steps.to_vec()).to_string(),
    )
}

/// The attempt number (last component of `MDIUM_FLOW_NODE_DIR`).
fn attempt() -> u64 {
    let dir = std::env::var("MDIUM_FLOW_NODE_DIR").unwrap_or_default();
    std::path::Path::new(&dir)
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

fn append(path: &str, line: &str) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("events file");
    writeln!(file, "{line}").expect("write event");
}

#[test]
fn flow_test_helper_entry() {
    let Ok(script) = std::env::var("FLOW_TEST_HELPER") else {
        return;
    };
    let steps: Vec<Value> = serde_json::from_str(&script).expect("helper script");
    let events = std::env::var("MDIUM_FLOW_EVENTS_FILE").unwrap_or_default();
    let stop = std::env::var("MDIUM_FLOW_STOP_FILE").unwrap_or_default();
    for step in steps {
        if let Some(event) = step.get("emit") {
            append(&events, &event.to_string());
        } else if let Some(raw) = step.get("emit_raw").and_then(Value::as_str) {
            append(&events, raw);
        } else if let Some(text) = step.get("stdout").and_then(Value::as_str) {
            println!("{text}");
        } else if let Some(ms) = step.get("sleep_ms").and_then(Value::as_u64) {
            std::thread::sleep(Duration::from_millis(ms));
        } else if let Some(ms) = step.get("wait_stop_ms").and_then(Value::as_u64) {
            // Cooperative stop: finish "at a boundary" when the STOP file appears.
            let deadline = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < deadline {
                if std::path::Path::new(&stop).exists() {
                    append(
                        &events,
                        &json!({ "v": 1, "type": "outcome", "status": "stopped" }).to_string(),
                    );
                    std::process::exit(0);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        } else if let Some(path) = step.get("dump_env").and_then(Value::as_str) {
            let vars: serde_json::Map<String, Value> = std::env::vars()
                .filter(|(k, _)| k.starts_with("MDIUM_FLOW_") || k.starts_with("FLOWT_"))
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
            let cwd = std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let args: Vec<String> = std::env::args().collect();
            std::fs::write(
                path,
                json!({ "env": vars, "cwd": cwd, "args": args }).to_string(),
            )
            .unwrap();
        } else if let Some(path) = step.get("spawn_sleeper_pid_file").and_then(Value::as_str) {
            // A grandchild that sleeps; its pid is written for kill-tree checks.
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(&super::test_helper::helper_argv()[1..])
                .env(
                    "FLOW_TEST_HELPER",
                    json!([{ "sleep_ms": 30000 }]).to_string(),
                )
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let child = command.spawn().unwrap();
            std::fs::write(path, child.id().to_string()).unwrap();
        } else if let Some(spec) = step.get("write_file") {
            // Writes a file; a relative path is relative to the node directory.
            let raw = spec["path"].as_str().unwrap_or_default();
            let path = if std::path::Path::new(raw).is_absolute() {
                std::path::PathBuf::from(raw)
            } else {
                std::path::PathBuf::from(std::env::var("MDIUM_FLOW_NODE_DIR").unwrap_or_default()).join(raw)
            };
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&path, spec["content"].as_str().unwrap_or_default()).unwrap();
        } else if let Some(n) = step.get("fail_before_attempt").and_then(Value::as_u64) {
            if attempt() < n {
                std::process::exit(1);
            }
        } else if let Some(n) = step.get("succeed_from_attempt").and_then(Value::as_u64) {
            if attempt() >= n {
                std::process::exit(0);
            }
        } else if step.get("emit_input").is_some() {
            // Echo the node input (`item`, `index`) as outputs, plus `n = index + 1`.
            let inputs: Value = std::fs::read(std::env::var("MDIUM_FLOW_INPUTS_FILE").unwrap())
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(Value::Null);
            for (key, value) in [
                ("item", inputs["item"].clone()),
                ("index", inputs["index"].clone()),
            ] {
                append(
                    &events,
                    &json!({ "v": 1, "type": "output", "key": key, "value": value }).to_string(),
                );
            }
            if let Some(index) = inputs["index"].as_u64() {
                append(
                    &events,
                    &json!({ "v": 1, "type": "output", "key": "n", "value": index + 1 })
                        .to_string(),
                );
            }
        } else if let Some(item) = step.get("fail_if_item") {
            let inputs: Value = std::fs::read(std::env::var("MDIUM_FLOW_INPUTS_FILE").unwrap())
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(Value::Null);
            if &inputs["item"] == item {
                std::process::exit(5);
            }
        } else if let Some(rule) = step.get("emit_if_key_contains") {
            let key = std::env::var("MDIUM_FLOW_NODE_KEY").unwrap_or_default();
            if key.contains(rule["needle"].as_str().unwrap_or("\u{0}")) {
                append(&events, &rule["event"].to_string());
            }
        } else if let Some(path) = step.get("fail_if_file_exists").and_then(Value::as_str) {
            if std::path::Path::new(path).exists() {
                std::process::exit(6);
            }
        } else if let Some(path) = step.get("append_key_to").and_then(Value::as_str) {
            // Records which node instance ran (order of execution).
            let key = std::env::var("MDIUM_FLOW_NODE_KEY").unwrap_or_default();
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .unwrap();
            writeln!(file, "{key}").unwrap();
        } else if let Some(arg) = step.get("emit_arg_as").and_then(Value::as_str) {
            // Emits the last command-line argument as output `arg`.
            let last = std::env::args().last().unwrap_or_default();
            append(
                &events,
                &json!({ "v": 1, "type": "output", "key": arg, "value": last }).to_string(),
            );
        } else if let Some(code) = step.get("exit").and_then(Value::as_i64) {
            std::process::exit(code as i32);
        }
    }
    std::process::exit(0);
}

/// The supervisor, run by the test binary (see `detached_launcher`).
#[test]
fn flow_supervisor_entry() {
    if std::env::var("FLOW_TEST_SUPERVISE").is_err() {
        return;
    }
    let spec = std::env::args().last().expect("spec path");
    std::process::exit(crate::run::supervise::supervise(std::path::Path::new(
        &spec,
    )));
}

/// A detached launcher whose supervisor is this test binary.
pub fn detached_launcher() -> crate::run::supervise::DetachedLauncher {
    let exe = std::env::current_exe().expect("test exe");
    crate::run::supervise::DetachedLauncher {
        supervisor: vec![
            exe.to_string_lossy().into_owned(),
            "--exact".into(),
            "run::test_helper::flow_supervisor_entry".into(),
            "--nocapture".into(),
            "--test-threads=1".into(),
            "--quiet".into(),
        ],
        supervisor_env: vec![("FLOW_TEST_SUPERVISE".into(), "1".into())],
    }
}

/// True while a process with `pid` exists.
pub fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .creation_flags(0x0800_0000)
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

// ---- Fake Python worker ----------------------------------------------------
//
// The same trick as the command helper: the test binary re-invokes itself and
// `flow_test_worker_entry` speaks the `mdium-worker-v1` protocol on stdio,
// driven by the JSON script in `FLOW_TEST_WORKER`:
//
//   { "stages": [...],                      // manifest answer to `describe`
//     "behaviour": { "<entry>": [steps] },  // what a `call` of <entry> does
//     "exit_on_describe": 3,                // exit with this code on `describe`
//     "ignore_describe": true }             // never answer `describe`
//
// Steps: `emit` (item JSON; `callId` is added), `emit_many` {count,item}
// (`item` repeated `count` times), `log` {level,text}, `raw`
// (a verbatim line), `raw_bytes` (an array of byte values written as is),
// `long_line` (n; a line of n `x` bytes), `long_fail` (n; outcome `fail`
// with an n-byte reason, which ends the call), `sleep_ms`, `wait_cancel_ms`
// (outcome `stopped` when a `cancel` arrives), `exit_on_cancel_ms` (exit 0
// without an outcome when a `cancel` arrives), `wait_stop_ms` (outcome
// `stopped` when the STOP file
// appears), `exit` (code; no outcome), `outcome` {status,reason?,message?},
// `fail_before_attempt` (n; outcome `fail` while `context.attempt` < n, which
// also ends the call), `error` {code,message} (an `error` answering the call
// request, which ends it).
//
// When `FLOW_TEST_WORKER_PID_FILE` is set the worker writes its pid there and
// appends one line per handled `describe` to the sibling `describes.log`.

use super::worker::{spawn_piped, WorkerHandle, WorkerLauncher, WorkerSpec};
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Arc;

const WORKER_TEST_NAME: &str = "run::test_helper::flow_test_worker_entry";

/// The env entry that carries the fake worker's script.
pub fn worker_script_env(script: &Value) -> (String, String) {
    ("FLOW_TEST_WORKER".to_string(), script.to_string())
}

/// Starts the fake worker (this test binary) through the real piped spawner.
pub struct FakeWorkerLauncher {
    pub script: Value,
}

impl WorkerLauncher for FakeWorkerLauncher {
    fn launch(&self, spec: &WorkerSpec) -> std::io::Result<Box<dyn WorkerHandle>> {
        let mut argv = helper_argv();
        argv[2] = WORKER_TEST_NAME.into();
        let mut cmd = std::process::Command::new(&argv[0]);
        let (key, value) = worker_script_env(&self.script);
        cmd.args(&argv[1..])
            .current_dir(&spec.working_dir)
            .envs(spec.env.iter().cloned())
            .env(key, value)
            .env(
                "FLOW_TEST_WORKER_PID_FILE",
                spec.stdout_log.with_file_name("pid"),
            )
            .stderr(super::worker::open_stderr_log(&spec.stderr)?);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        spawn_piped(cmd)
    }
}

pub fn fake_worker_launcher(script: Value) -> Arc<dyn WorkerLauncher> {
    Arc::new(FakeWorkerLauncher { script })
}

fn worker_out(value: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn worker_item(call_id: &str, mut item: Value) -> Value {
    item["v"] = json!(1);
    item["callId"] = json!(call_id);
    item
}

fn worker_outcome(call_id: &str, status: &str) {
    worker_out(&worker_item(
        call_id,
        json!({ "type": "outcome", "status": status }),
    ));
}

/// Waits up to `ms`; true when `on_line` / `on_tick` ended the wait early.
/// Exits the process on `shutdown` or a closed stdin.
fn worker_wait(
    rx: &Receiver<String>,
    ms: u64,
    mut on_line: impl FnMut(&Value) -> bool,
    mut on_tick: impl FnMut() -> bool,
) -> bool {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        if on_tick() {
            return true;
        }
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(line) => {
                let msg: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                if msg["type"] == "shutdown" {
                    std::process::exit(0);
                }
                if on_line(&msg) {
                    return true;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => std::process::exit(0),
        }
    }
    false
}

/// Runs one step of a call; true when the call is over.
fn worker_step(step: &Value, call_id: &str, ctx: &Value, rx: &Receiver<String>) -> bool {
    if let Some(item) = step.get("emit") {
        worker_out(&worker_item(call_id, item.clone()));
    } else if let Some(many) = step.get("emit_many") {
        let line = worker_item(call_id, many["item"].clone()).to_string();
        let mut out = std::io::BufWriter::new(std::io::stdout().lock());
        for _ in 0..many["count"].as_u64().unwrap_or(0) {
            let _ = writeln!(out, "{line}");
        }
        let _ = out.flush();
    } else if let Some(log) = step.get("log") {
        worker_out(&worker_item(
            call_id,
            json!({ "type": "log", "level": log["level"], "text": log["text"] }),
        ));
    } else if let Some(raw) = step.get("raw").and_then(Value::as_str) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{raw}");
        let _ = out.flush();
    } else if let Some(bytes) = step.get("raw_bytes").and_then(Value::as_array) {
        let bytes: Vec<u8> = bytes.iter().filter_map(Value::as_u64).map(|b| b as u8).collect();
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(&bytes);
        let _ = out.flush();
    } else if let Some(n) = step.get("long_line").and_then(Value::as_u64) {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(&vec![b'x'; n as usize]);
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    } else if let Some(n) = step.get("long_fail").and_then(Value::as_u64) {
        // An outcome `fail` whose reason is n bytes (too big for the env script).
        worker_out(&worker_item(
            call_id,
            json!({ "type": "outcome", "status": "fail", "reason": "r".repeat(n as usize) }),
        ));
        return true;
    } else if let Some(ms) = step.get("exit_on_cancel_ms").and_then(Value::as_u64) {
        if worker_wait(rx, ms, |msg| msg["type"] == "cancel", || false) {
            std::process::exit(0);
        }
    } else if let Some(ms) = step.get("sleep_ms").and_then(Value::as_u64) {
        std::thread::sleep(Duration::from_millis(ms));
    } else if let Some(ms) = step.get("wait_cancel_ms").and_then(Value::as_u64) {
        let cancelled = worker_wait(rx, ms, |msg| msg["type"] == "cancel", || false);
        if cancelled {
            worker_outcome(call_id, "stopped");
            return true;
        }
    } else if let Some(ms) = step.get("wait_stop_ms").and_then(Value::as_u64) {
        let stop = std::env::var("MDIUM_FLOW_STOP_FILE")
            .ok()
            .or_else(|| ctx["stopFile"].as_str().map(String::from))
            .unwrap_or_default();
        let stopped = worker_wait(
            rx,
            ms,
            |_| false,
            || !stop.is_empty() && std::path::Path::new(&stop).exists(),
        );
        if stopped {
            worker_outcome(call_id, "stopped");
            return true;
        }
    } else if let Some(exit) = step.get("exit") {
        let code = exit.as_i64().or_else(|| exit["code"].as_i64()).unwrap_or(0);
        std::process::exit(code as i32);
    } else if let Some(outcome) = step.get("outcome") {
        let mut item = json!({ "type": "outcome", "status": outcome["status"] });
        for key in ["reason", "message"] {
            if !outcome[key].is_null() {
                item[key] = outcome[key].clone();
            }
        }
        worker_out(&worker_item(call_id, item));
    } else if let Some(n) = step.get("fail_before_attempt") {
        let n = n.as_u64().or_else(|| n["n"].as_u64()).unwrap_or(0);
        if ctx["attempt"].as_u64().unwrap_or(0) < n {
            worker_out(&worker_item(
                call_id,
                json!({ "type": "outcome", "status": "fail", "reason": "attempt too low" }),
            ));
            return true;
        }
    }
    false
}

fn worker_call(script: &Value, msg: &Value, rx: &Receiver<String>) {
    let call_id = msg["callId"].as_str().unwrap_or_default();
    let entry = msg["entry"].as_str().unwrap_or_default();
    let Some(steps) = script["behaviour"].get(entry).and_then(Value::as_array) else {
        worker_out(&json!({
            "v": 1, "type": "error", "requestId": msg["requestId"], "callId": call_id,
            "code": "FLOW_PYTHON_ENTRY_UNKNOWN", "message": format!("unknown entry {entry}"),
        }));
        return;
    };
    for step in steps {
        if let Some(error) = step.get("error") {
            // An `error` answering the call request (ends the call).
            worker_out(&json!({
                "v": 1, "type": "error", "requestId": msg["requestId"],
                "code": error["code"], "message": error["message"],
            }));
            return;
        }
        if worker_step(step, call_id, &msg["context"], rx) {
            return;
        }
    }
}

#[test]
fn flow_test_worker_entry() {
    let Ok(script) = std::env::var("FLOW_TEST_WORKER") else {
        return;
    };
    let script: Value = serde_json::from_str(&script).expect("worker script");
    let pid_file = std::env::var("FLOW_TEST_WORKER_PID_FILE")
        .ok()
        .map(PathBuf::from);
    if let Some(path) = &pid_file {
        std::fs::write(path, std::process::id().to_string()).expect("pid file");
    }
    // One reader thread feeds every wait (a `cancel` can arrive mid-call).
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    loop {
        let Ok(line) = rx.recv() else {
            std::process::exit(0);
        };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match msg["type"].as_str() {
            Some("describe") => {
                if let Some(path) = &pid_file {
                    append(
                        &path.with_file_name("describes.log").to_string_lossy(),
                        "describe",
                    );
                }
                if let Some(code) = script["exit_on_describe"].as_i64() {
                    eprintln!("fake worker: exiting on describe");
                    std::process::exit(code as i32);
                }
                if script["ignore_describe"] == true {
                    continue;
                }
                worker_out(&json!({
                    "v": 1, "type": "manifest", "requestId": msg["requestId"],
                    "module": "fake", "stages": script["stages"],
                }));
            }
            Some("call") => worker_call(&script, &msg, &rx),
            Some("shutdown") => std::process::exit(0),
            _ => {}
        }
    }
}

// ------------------------------------------------------------ fake agent runner

use super::agent::{AgentRunner, AgentTurnEvent, AgentTurnHandle, AgentTurnRequest};
use crate::provider::Provider;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// What one fake agent turn does.
#[derive(Debug, Clone)]
pub enum FakeTurn {
    /// Completes with this final response.
    Respond(String),
    Fail { code: String, message: String },
    /// Reports a guard violation, then fails like a blocked turn.
    Guard { rule: String, summary: String },
    /// Never ends until cancelled (or `complete_hanging`).
    Hang,
    /// The runner goes away without ending the turn.
    Exit,
}

/// An agent runner that plays scripted turns and records what it got.
pub struct FakeAgentRunner {
    turns: Mutex<VecDeque<FakeTurn>>,
    prompts: Mutex<Vec<String>>,
    dirs: Mutex<Vec<PathBuf>>,
    cancelled: Arc<AtomicUsize>,
    /// The event queues of every turn handed out, in start order.
    handles: Mutex<Vec<Arc<Mutex<TurnQueue>>>>,
    /// Providers whose probe fails.
    unavailable: Mutex<Vec<Provider>>,
}

impl FakeAgentRunner {
    pub fn new(turns: Vec<FakeTurn>) -> Self {
        Self {
            turns: Mutex::new(turns.into()),
            prompts: Mutex::new(Vec::new()),
            dirs: Mutex::new(Vec::new()),
            cancelled: Arc::new(AtomicUsize::new(0)),
            handles: Mutex::new(Vec::new()),
            unavailable: Mutex::new(Vec::new()),
        }
    }

    /// Makes `probe(provider)` fail from now on.
    pub fn set_unavailable(&self, provider: Provider) {
        let mut list = self.unavailable.lock().unwrap();
        if !list.contains(&provider) {
            list.push(provider);
        }
    }

    /// Makes `probe(provider)` succeed again.
    pub fn set_available(&self, provider: Provider) {
        self.unavailable.lock().unwrap().retain(|p| *p != provider);
    }

    /// Ends the first still hanging turn with `Completed { response }`
    /// (waiting up to 5 s for the driver to start one).
    pub fn complete_hanging(&self, response: &str) {
        self.end_hanging(AgentTurnEvent::Completed {
            final_response: response.to_string(),
        });
    }

    /// Ends the first still hanging turn with `end` (waiting up to 5 s).
    pub fn end_hanging(&self, end: AgentTurnEvent) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let queue = loop {
            let found = self
                .handles
                .lock()
                .unwrap()
                .iter()
                .find(|q| q.lock().unwrap().hang)
                .cloned();
            match found {
                Some(queue) => break queue,
                None if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                None => panic!("no hanging turn"),
            }
        };
        let mut queue = queue.lock().unwrap();
        queue.hang = false;
        queue.events.push_back(end);
    }

    /// Every prompt received, in order.
    pub fn prompts(&self) -> Vec<String> {
        self.prompts.lock().unwrap().clone()
    }

    /// The working directory of every turn, in order.
    pub fn working_dirs(&self) -> Vec<PathBuf> {
        self.dirs.lock().unwrap().clone()
    }

    /// Hanging turns ended by a cancel.
    pub fn cancelled(&self) -> usize {
        self.cancelled.load(Ordering::SeqCst)
    }
}

impl AgentRunner for FakeAgentRunner {
    fn start(&self, req: AgentTurnRequest) -> Result<Box<dyn AgentTurnHandle>, String> {
        self.prompts.lock().unwrap().push(req.prompt);
        self.dirs.lock().unwrap().push(req.working_dir);
        let turn = self
            .turns
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| FakeTurn::Respond("---\noutcome: completed\n---\n".into()));
        let (events, hang) = match turn {
            FakeTurn::Respond(final_response) => {
                (vec![AgentTurnEvent::Completed { final_response }], false)
            }
            FakeTurn::Fail { code, message } => (vec![AgentTurnEvent::Failed { code, message }], false),
            FakeTurn::Guard { rule, summary } => (
                vec![
                    AgentTurnEvent::GuardViolation { rule, summary },
                    AgentTurnEvent::Failed {
                        code: "RUNNER_TURN_FAILED".into(),
                        message: "GUARD_BLOCKED".into(),
                    },
                ],
                false,
            ),
            FakeTurn::Hang => (Vec::new(), true),
            FakeTurn::Exit => (vec![AgentTurnEvent::Exited], false),
        };
        let queue = Arc::new(Mutex::new(TurnQueue {
            events: events.into(),
            hang,
        }));
        self.handles.lock().unwrap().push(queue.clone());
        Ok(Box::new(FakeTurnHandle {
            queue,
            cancelled: self.cancelled.clone(),
        }))
    }

    fn probe(&self, provider: Provider) -> Result<(), String> {
        if self.unavailable.lock().unwrap().contains(&provider) {
            Err("provider unavailable".into())
        } else {
            Ok(())
        }
    }
}

/// Events a fake turn still has to deliver.
struct TurnQueue {
    events: VecDeque<AgentTurnEvent>,
    /// Still hanging (no end event queued yet).
    hang: bool,
}

struct FakeTurnHandle {
    queue: Arc<Mutex<TurnQueue>>,
    cancelled: Arc<AtomicUsize>,
}

impl AgentTurnHandle for FakeTurnHandle {
    fn try_recv(&mut self) -> Option<AgentTurnEvent> {
        self.queue.lock().unwrap().events.pop_front()
    }

    fn cancel(&mut self) {
        let mut queue = self.queue.lock().unwrap();
        if queue.hang {
            queue.hang = false;
            self.cancelled.fetch_add(1, Ordering::SeqCst);
            queue.events.push_back(AgentTurnEvent::Cancelled);
        }
    }
}

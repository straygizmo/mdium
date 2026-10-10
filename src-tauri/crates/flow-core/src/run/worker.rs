//! The resident Python worker of `python` nodes (spec 2026-10-10, chapter 3):
//! the `mdium-worker-v1` JSON-line protocol, the manifest a worker returns
//! to `describe`, input validation against a stage, interpreter resolution
//! and the piped child process behind [`WorkerLauncher`].

use crate::project::RuntimeDef;
use crate::run::model::Reason;
use crate::run::process::{parse_line, ProtocolItem};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

pub const WORKER_PROTOCOL_VERSION: u64 = 1;

pub const FLOW_RUNTIME_START_FAILED: &str = "FLOW_RUNTIME_START_FAILED";
pub const FLOW_PYTHON_ENTRY_UNKNOWN: &str = "FLOW_PYTHON_ENTRY_UNKNOWN";
pub const FLOW_PYTHON_INPUT_INVALID: &str = "FLOW_PYTHON_INPUT_INVALID";
pub const FLOW_PYTHON_PROTOCOL: &str = "FLOW_PYTHON_PROTOCOL";
pub const FLOW_PYTHON_WORKER_EXITED: &str = "FLOW_PYTHON_WORKER_EXITED";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StageInputType {
    String,
    Number,
    Bool,
    Path,
    Object,
    Array,
}

impl StageInputType {
    fn accepts(self, value: &Value) -> bool {
        match self {
            StageInputType::String | StageInputType::Path => value.is_string(),
            StageInputType::Number => value.is_number(),
            StageInputType::Bool => value.is_boolean(),
            StageInputType::Object => value.is_object(),
            StageInputType::Array => value.is_array(),
        }
    }
    fn name(self) -> &'static str {
        match self {
            StageInputType::String => "string",
            StageInputType::Number => "number",
            StageInputType::Bool => "bool",
            StageInputType::Path => "path",
            StageInputType::Object => "object",
            StageInputType::Array => "array",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageInput {
    #[serde(rename = "type")]
    pub ty: StageInputType,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOutput {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub ty: Option<StageInputType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageArtifact {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageDef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub inputs: BTreeMap<String, StageInput>,
    #[serde(default)]
    pub outputs: BTreeMap<String, StageOutput>,
    #[serde(default)]
    pub artifacts: Vec<StageArtifact>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub module: String,
    #[serde(default)]
    pub stages: Vec<StageDef>,
}

impl Manifest {
    pub fn stage(&self, name: &str) -> Option<&StageDef> {
        self.stages.iter().find(|s| s.name == name)
    }
}

/// One line received from a worker.
#[derive(Debug)]
pub enum WorkerMessage {
    Manifest {
        request_id: String,
        manifest: Manifest,
    },
    Error {
        request_id: Option<String>,
        code: String,
        message: String,
    },
    Log {
        call_id: Option<String>,
        level: String,
        text: String,
    },
    /// A node-level protocol item; `line` is the JSON without `callId`
    /// (what the attempt's `events.jsonl` records).
    Item {
        call_id: Option<String>,
        item: ProtocolItem,
        line: String,
    },
    Invalid {
        reason: &'static str,
    },
}

pub fn parse_worker_line(line: &str) -> WorkerMessage {
    let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(line) else {
        return WorkerMessage::Invalid {
            reason: "invalid-json",
        };
    };
    if obj.get("v").and_then(Value::as_u64) != Some(WORKER_PROTOCOL_VERSION) {
        return WorkerMessage::Invalid {
            reason: "unsupported-version",
        };
    }
    let s = |o: &Map<String, Value>, k: &str| o.get(k).and_then(Value::as_str).map(String::from);
    match obj.get("type").and_then(Value::as_str) {
        Some("manifest") => {
            let Some(request_id) = s(&obj, "requestId") else {
                return WorkerMessage::Invalid {
                    reason: "missing-request-id",
                };
            };
            match serde_json::from_value::<Manifest>(Value::Object(obj)) {
                Ok(manifest) => WorkerMessage::Manifest {
                    request_id,
                    manifest,
                },
                Err(_) => WorkerMessage::Invalid {
                    reason: "bad-manifest",
                },
            }
        }
        Some("error") => WorkerMessage::Error {
            request_id: s(&obj, "requestId"),
            code: s(&obj, "code").unwrap_or_else(|| FLOW_PYTHON_PROTOCOL.to_string()),
            message: s(&obj, "message").unwrap_or_default(),
        },
        Some("log") => WorkerMessage::Log {
            call_id: s(&obj, "callId"),
            level: s(&obj, "level").unwrap_or_else(|| "info".to_string()),
            text: s(&obj, "text").unwrap_or_default(),
        },
        Some("progress") | Some("cost") | Some("output") | Some("artifact") | Some("outcome") => {
            let call_id = s(&obj, "callId");
            obj.remove("callId");
            let line = Value::Object(obj).to_string();
            match parse_line(&line) {
                Ok(item) => WorkerMessage::Item {
                    call_id,
                    item,
                    line,
                },
                Err(reason) => WorkerMessage::Invalid { reason },
            }
        }
        _ => WorkerMessage::Invalid {
            reason: "unknown-type",
        },
    }
}

/// Checks `given` against the stage's inputs and fills defaults (spec 3.4).
pub fn validate_inputs(
    stage: &StageDef,
    given: &Map<String, Value>,
) -> Result<Map<String, Value>, Vec<Reason>> {
    let mut errors = Vec::new();
    let mut out = Map::new();
    let bad = |input: &str, reason: &str| {
        Reason::new(FLOW_PYTHON_INPUT_INVALID)
            .with("input", input)
            .with("reason", reason)
    };
    for key in given.keys() {
        if !stage.inputs.contains_key(key) {
            errors.push(bad(key, "unknown"));
        }
    }
    for (name, def) in &stage.inputs {
        let value = given
            .get(name)
            .filter(|v| !v.is_null())
            .cloned()
            .or_else(|| def.default.clone());
        match value {
            None if def.required => errors.push(bad(name, "missing")),
            None => {}
            Some(v) if !def.ty.accepts(&v) => errors.push(
                bad(name, "type")
                    .with("expected", def.ty.name())
                    .with("found", json_type_name(&v)),
            ),
            Some(v) => {
                out.insert(name.clone(), v);
            }
        }
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors)
    }
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Where a call runs, as the worker sees it (`context` of `call`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallContext {
    pub run_id: String,
    pub node_key: String,
    pub node_dir: String,
    pub project_root: String,
    pub stop_file: String,
    pub attempt: u32,
}

pub fn describe_request(request_id: &str) -> String {
    serde_json::json!({ "v": WORKER_PROTOCOL_VERSION, "type": "describe", "requestId": request_id })
        .to_string()
}

pub fn call_request(
    request_id: &str,
    call_id: &str,
    entry: &str,
    inputs: &Map<String, Value>,
    ctx: &CallContext,
) -> String {
    serde_json::json!({
        "v": WORKER_PROTOCOL_VERSION, "type": "call", "requestId": request_id, "callId": call_id,
        "entry": entry, "inputs": inputs, "context": ctx,
    })
    .to_string()
}

pub fn cancel_request(call_id: &str) -> String {
    serde_json::json!({ "v": WORKER_PROTOCOL_VERSION, "type": "cancel", "callId": call_id })
        .to_string()
}

pub fn shutdown_request() -> String {
    serde_json::json!({ "v": WORKER_PROTOCOL_VERSION, "type": "shutdown" }).to_string()
}

// ---- The worker process ----------------------------------------------------

#[derive(Debug, Clone)]
pub struct WorkerSpec {
    /// Absolute interpreter candidates, in preference order.
    pub python_candidates: Vec<PathBuf>,
    pub module: String,
    pub working_dir: PathBuf,
    pub env: Vec<(String, String)>,
    pub stderr: PathBuf,
    pub stdout_log: PathBuf,
}

#[derive(Debug)]
pub enum WorkerEvent {
    Line(String),
    Exited(Option<i32>),
}

pub trait WorkerHandle: Send {
    fn pid(&self) -> u32;
    fn send(&mut self, line: &str) -> std::io::Result<()>;
    fn try_recv(&mut self) -> Option<WorkerEvent>;
    fn try_wait(&mut self) -> std::io::Result<Option<i32>>;
    fn kill_tree(&mut self);
}

pub trait WorkerLauncher: Send + Sync {
    fn launch(&self, spec: &WorkerSpec) -> std::io::Result<Box<dyn WorkerHandle>>;
}

struct PipedWorker {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<WorkerEvent>,
    pid: u32,
}

impl WorkerHandle for PipedWorker {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn send(&mut self, line: &str) -> std::io::Result<()> {
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()
    }

    fn try_recv(&mut self) -> Option<WorkerEvent> {
        self.rx.try_recv().ok()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        Ok(self.child.try_wait()?.map(|s| s.code().unwrap_or(-1)))
    }

    fn kill_tree(&mut self) {
        crate::run::process::kill_tree_by_pid(self.pid);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawns `cmd` with piped stdin/stdout and a reader thread; `stderr` must
/// already be set on `cmd` (a file). Lines arrive through `try_recv`.
pub fn spawn_piped(mut cmd: Command) -> std::io::Result<Box<dyn WorkerHandle>> {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("no stdout"))?;
    let pid = child.id();
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(WorkerEvent::Line(line)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        // EOF: the exit code is read by the owner through `try_wait`.
        let _ = tx.send(WorkerEvent::Exited(None));
    });
    Ok(Box::new(PipedWorker {
        child,
        stdin,
        rx,
        pid,
    }))
}

fn no_link_metadata(path: &Path) -> Option<std::fs::Metadata> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    (!meta.file_type().is_symlink()).then_some(meta)
}

/// The first interpreter candidate that is an existing regular file (no link).
pub fn resolve_python(project_root: &Path, def: &RuntimeDef) -> Result<PathBuf, String> {
    let candidates = def.python.candidates();
    for candidate in &candidates {
        let path = project_root.join(candidate);
        if no_link_metadata(&path).is_some_and(|m| m.is_file()) {
            return Ok(path);
        }
    }
    Err(format!(
        "no interpreter found among {}",
        candidates.join(", ")
    ))
}

/// The runtime's working directory (an existing directory, no link).
pub fn resolve_cwd(project_root: &Path, def: &RuntimeDef) -> Result<PathBuf, String> {
    let path = project_root.join(&def.cwd);
    if no_link_metadata(&path).is_some_and(|m| m.is_dir()) {
        Ok(path)
    } else {
        Err(format!(
            "working directory {} is not a directory in the project",
            def.cwd
        ))
    }
}

/// Everything needed to launch the worker of runtime `name` for a run.
pub fn worker_spec(
    project_root: &Path,
    name: &str,
    def: &RuntimeDef,
    run_dir: &Path,
    extra_env: &[(String, String)],
) -> Result<WorkerSpec, Reason> {
    let start_failed = |message: String| {
        Reason::new(FLOW_RUNTIME_START_FAILED)
            .with("runtime", name)
            .with("message", message)
    };
    let working_dir = resolve_cwd(project_root, def).map_err(start_failed)?;
    let log_dir = run_dir.join("runtimes").join(name);
    std::fs::create_dir_all(&log_dir).map_err(|e| start_failed(e.to_string()))?;
    let mut env: Vec<(String, String)> = def
        .env
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    env.push(("PYTHONUTF8".into(), "1".into()));
    env.push((
        "MDIUM_PROJECT_ROOT".into(),
        project_root.to_string_lossy().into_owned(),
    ));
    env.extend(extra_env.iter().cloned());
    Ok(WorkerSpec {
        python_candidates: def
            .python
            .candidates()
            .iter()
            .map(|c| project_root.join(c))
            .collect(),
        module: def.module.clone(),
        working_dir,
        env,
        stderr: log_dir.join("stderr.log"),
        stdout_log: log_dir.join("stdout.log"),
    })
}

pub struct PipedWorkerLauncher;

impl WorkerLauncher for PipedWorkerLauncher {
    fn launch(&self, spec: &WorkerSpec) -> std::io::Result<Box<dyn WorkerHandle>> {
        let python = spec
            .python_candidates
            .iter()
            .find(|p| no_link_metadata(p).is_some_and(|m| m.is_file()))
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!(
                        "no interpreter found among {}",
                        spec.python_candidates
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                )
            })?;
        let mut cmd = Command::new(python);
        cmd.args(["-m", "mdium_worker", "--module", &spec.module])
            .current_dir(&spec.working_dir)
            .envs(spec.env.iter().cloned())
            .stderr(File::create(&spec.stderr)?);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        spawn_piped(cmd)
    }
}

/// Launches a worker only to read its manifest (`flow_runtime_describe`).
pub fn describe_runtime(
    launcher: &dyn WorkerLauncher,
    spec: &WorkerSpec,
    timeout: Duration,
) -> Result<Manifest, Reason> {
    let fail = |message: String| Reason::new(FLOW_RUNTIME_START_FAILED).with("message", message);
    let mut handle = launcher.launch(spec).map_err(|e| fail(e.to_string()))?;
    if let Err(e) = handle.send(&describe_request("1")) {
        handle.kill_tree();
        return Err(fail(e.to_string()));
    }
    let deadline = Instant::now() + timeout;
    let result = loop {
        match handle.try_recv() {
            Some(WorkerEvent::Line(line)) => match parse_worker_line(&line) {
                WorkerMessage::Manifest {
                    request_id,
                    manifest,
                } if request_id == "1" => break Ok(manifest),
                WorkerMessage::Error { message, .. } => break Err(fail(message)),
                _ => {}
            },
            Some(WorkerEvent::Exited(_)) => {
                break Err(fail("the worker exited before answering describe".into()))
            }
            None => {
                if Instant::now() >= deadline {
                    break Err(fail("timed out waiting for the manifest".into()));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    };
    let _ = handle.send(&shutdown_request());
    let grace = Instant::now() + Duration::from_secs(1);
    while Instant::now() < grace {
        if matches!(handle.try_wait(), Ok(Some(_))) {
            return result;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    handle.kill_tree();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::process::{ProtocolItem, ProtocolOutcome};
    use serde_json::json;

    fn manifest() -> Manifest {
        serde_json::from_value(json!({
            "module": "demo",
            "stages": [{
                "name": "video.render",
                "description": "Render",
                "inputs": {
                    "videoDir": { "type": "path", "required": true },
                    "title": { "type": "string", "default": "video" },
                    "n": { "type": "number" },
                    "flags": { "type": "object" }
                },
                "outputs": { "videoPath": { "type": "path" } },
                "artifacts": [{ "label": "video", "mediaType": "video/mp4" }]
            }]
        }))
        .unwrap()
    }

    #[test]
    fn parses_manifest_error_log_and_items() {
        let m = parse_worker_line(
            r#"{"v":1,"type":"manifest","requestId":"1","module":"demo","stages":[]}"#,
        );
        assert!(
            matches!(m, WorkerMessage::Manifest { ref request_id, ref manifest } if request_id == "1" && manifest.module == "demo")
        );
        let e = parse_worker_line(
            r#"{"v":1,"type":"error","requestId":"2","code":"FLOW_PYTHON_ENTRY_UNKNOWN","message":"no such stage"}"#,
        );
        assert!(
            matches!(e, WorkerMessage::Error { ref code, .. } if code == "FLOW_PYTHON_ENTRY_UNKNOWN")
        );
        let l = parse_worker_line(
            r#"{"v":1,"type":"log","callId":"c1","level":"warning","text":"hi"}"#,
        );
        assert!(
            matches!(l, WorkerMessage::Log { ref level, ref text, .. } if level == "warning" && text == "hi")
        );
        let p = parse_worker_line(
            r#"{"v":1,"type":"progress","callId":"c1","text":"t","fraction":0.5}"#,
        );
        match p {
            WorkerMessage::Item {
                call_id,
                item: ProtocolItem::Progress { text, fraction },
                line,
            } => {
                assert_eq!(call_id.as_deref(), Some("c1"));
                assert_eq!((text.as_str(), fraction), ("t", Some(0.5)));
                assert!(!line.contains("callId"), "{line}");
                assert!(line.contains("\"type\":\"progress\""));
            }
            other => panic!("{other:?}"),
        }
        let o = parse_worker_line(
            r#"{"v":1,"type":"outcome","callId":"c1","status":"needs_approval","message":"ok?"}"#,
        );
        assert!(
            matches!(o, WorkerMessage::Item { item: ProtocolItem::Outcome(ProtocolOutcome::NeedsApproval(Some(ref m))), .. } if m == "ok?")
        );
        let a = parse_worker_line(
            r#"{"v":1,"type":"artifact","callId":"c1","path":"out/x.mp4","label":"video","mediaType":"video/mp4"}"#,
        );
        assert!(matches!(
            a,
            WorkerMessage::Item {
                item: ProtocolItem::Artifact { .. },
                ..
            }
        ));
    }

    #[test]
    fn rejects_bad_lines_with_a_reason() {
        // Review Focus 1: a stray print() is an invalid line, never a panic.
        assert!(matches!(
            parse_worker_line("hello from print()"),
            WorkerMessage::Invalid {
                reason: "invalid-json"
            }
        ));
        assert!(matches!(
            parse_worker_line(r#"{"v":2,"type":"log"}"#),
            WorkerMessage::Invalid {
                reason: "unsupported-version"
            }
        ));
        assert!(matches!(
            parse_worker_line(r#"{"v":1,"type":"dance"}"#),
            WorkerMessage::Invalid {
                reason: "unknown-type"
            }
        ));
        assert!(matches!(
            parse_worker_line(r#"{"v":1,"type":"output","key":"bad key","value":1}"#),
            WorkerMessage::Invalid { .. }
        ));
    }

    #[test]
    fn validates_inputs_against_the_stage() {
        let stage = manifest().stage("video.render").unwrap().clone();
        let given = json!({ "videoDir": "/v", "n": 2, "flags": { "a": true } });
        let filled = validate_inputs(&stage, given.as_object().unwrap()).unwrap();
        assert_eq!(filled["title"], "video");
        assert_eq!(filled["n"], 2);
        let bad = json!({ "title": "t", "n": "3", "extra": 1 });
        let errs = validate_inputs(&stage, bad.as_object().unwrap()).unwrap_err();
        let reasons: Vec<(String, String)> = errs
            .iter()
            .map(|r| {
                (
                    r.params["input"].as_str().unwrap().to_string(),
                    r.params["reason"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert!(
            reasons.contains(&("videoDir".into(), "missing".into())),
            "{reasons:?}"
        );
        assert!(
            reasons.contains(&("n".into(), "type".into())),
            "{reasons:?}"
        );
        assert!(
            reasons.contains(&("extra".into(), "unknown".into())),
            "{reasons:?}"
        );
        assert!(errs.iter().all(|r| r.code == FLOW_PYTHON_INPUT_INVALID));
        let null_default = json!({ "videoDir": "/v", "title": null });
        assert_eq!(
            validate_inputs(&stage, null_default.as_object().unwrap()).unwrap()["title"],
            "video"
        );
    }

    #[test]
    fn builds_requests_as_single_lines() {
        let ctx = CallContext {
            run_id: "r".into(),
            node_key: "a".into(),
            node_dir: "/d".into(),
            project_root: "/p".into(),
            stop_file: "/p/STOP".into(),
            attempt: 1,
        };
        let call = call_request(
            "7",
            "c7",
            "video.render",
            json!({ "x": 1 }).as_object().unwrap(),
            &ctx,
        );
        let v: Value = serde_json::from_str(&call).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["type"], "call");
        assert_eq!(v["requestId"], "7");
        assert_eq!(v["callId"], "c7");
        assert_eq!(v["entry"], "video.render");
        assert_eq!(v["inputs"]["x"], 1);
        assert_eq!(v["context"]["nodeKey"], "a");
        assert_eq!(v["context"]["attempt"], 1);
        assert!(!call.contains('\n'));
        assert_eq!(
            serde_json::from_str::<Value>(&describe_request("1")).unwrap()["type"],
            "describe"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&cancel_request("c7")).unwrap()["callId"],
            "c7"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&shutdown_request()).unwrap()["type"],
            "shutdown"
        );
    }

    #[test]
    fn extra_protocol_edge_cases() {
        let a = parse_worker_line(
            r#"{"v":1,"type":"artifact","callId":"c1","path":"out/x.mp4","label":"video","mediaType":"video/mp4"}"#,
        );
        match a {
            WorkerMessage::Item { line, .. } => {
                assert!(line.contains("\"mediaType\":\"video/mp4\""), "{line}")
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse_worker_line(r#"{"v":"1","type":"log"}"#),
            WorkerMessage::Invalid {
                reason: "unsupported-version"
            }
        ));
        assert!(matches!(
            parse_worker_line(r#"{"v":1}"#),
            WorkerMessage::Invalid {
                reason: "unknown-type"
            }
        ));
        let stage = manifest().stage("video.render").unwrap().clone();
        let given = json!({ "videoDir": "/v", "n": true });
        let errs = validate_inputs(&stage, given.as_object().unwrap()).unwrap_err();
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].params["input"], "n");
        assert_eq!(errs[0].params["reason"], "type");
        let nulls = json!({ "videoDir": "/v", "n": null });
        let filled = validate_inputs(&stage, nulls.as_object().unwrap()).unwrap();
        assert!(!filled.contains_key("n"));
        let ctx = CallContext {
            run_id: "r".into(),
            node_key: "a".into(),
            node_dir: "/d".into(),
            project_root: "/p".into(),
            stop_file: "/p/STOP".into(),
            attempt: 1,
        };
        let call = call_request("1", "c1", "we\"ird\\name", &Map::new(), &ctx);
        let v: Value = serde_json::from_str(&call).unwrap();
        assert_eq!(v["entry"], "we\"ird\\name");
    }

    use crate::project::{check_project_text, RuntimeDef};
    use crate::run::test_helper::fake_worker_launcher;
    use std::time::Duration;

    fn runtime(text: &str) -> RuntimeDef {
        let project = check_project_text(&format!(
            "schemaVersion: 1\nid: p\nname: P\nruntimes:\n  r: {text}\n"
        ))
        .project
        .unwrap();
        project.runtimes["r"].clone()
    }

    #[test]
    fn resolves_the_first_existing_regular_file_candidate() {
        // Review Focus 2.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".venv/bin")).unwrap();
        std::fs::write(root.join(".venv/bin/python"), "").unwrap();
        let def = runtime(
            "{ kind: python, python: [.venv/Scripts/python.exe, .venv/bin/python], module: m }",
        );
        assert_eq!(
            resolve_python(root, &def).unwrap(),
            root.join(".venv/bin/python")
        );
        let none = runtime("{ kind: python, python: [.venv/Scripts/python.exe], module: m }");
        let err = resolve_python(root, &none).unwrap_err();
        assert!(err.contains(".venv/Scripts/python.exe"), "{err}");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let cwd = runtime("{ kind: python, python: .venv/bin/python, module: m, cwd: sub }");
        assert_eq!(resolve_cwd(root, &cwd).unwrap(), root.join("sub"));
        let bad_cwd =
            runtime("{ kind: python, python: .venv/bin/python, module: m, cwd: missing }");
        assert!(resolve_cwd(root, &bad_cwd).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_interpreter_and_cwd_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("real-python"), "").unwrap();
        std::os::unix::fs::symlink(root.join("real-python"), root.join("link-python")).unwrap();
        let def = runtime("{ kind: python, python: link-python, module: m }");
        assert!(resolve_python(root, &def).is_err());
    }

    #[test]
    fn describe_runtime_returns_the_manifest_from_a_live_worker() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let script = serde_json::json!({ "stages": [{ "name": "a.b", "inputs": {}, "outputs": {} }], "behaviour": {} });
        let launcher = fake_worker_launcher(script);
        let def = runtime("{ kind: python, python: nope, module: m }");
        let spec = worker_spec(root, "r", &def, &root.join(".mdium/flow-runs/x"), &[]).unwrap();
        let manifest = describe_runtime(launcher.as_ref(), &spec, Duration::from_secs(10)).unwrap();
        assert_eq!(manifest.stages[0].name, "a.b");
        assert!(root
            .join(".mdium/flow-runs/x/runtimes/r/stderr.log")
            .exists());
    }

    #[test]
    fn describe_runtime_fails_when_the_worker_exits_or_times_out() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let def = runtime("{ kind: python, python: nope, module: m }");
        let spec = worker_spec(root, "r", &def, &root.join("run"), &[]).unwrap();
        let exits = fake_worker_launcher(serde_json::json!({ "exit_on_describe": 3 }));
        let err = describe_runtime(exits.as_ref(), &spec, Duration::from_secs(10)).unwrap_err();
        assert_eq!(err.code, FLOW_RUNTIME_START_FAILED);
        let silent = fake_worker_launcher(serde_json::json!({ "ignore_describe": true }));
        let err = describe_runtime(silent.as_ref(), &spec, Duration::from_millis(300)).unwrap_err();
        assert_eq!(err.code, FLOW_RUNTIME_START_FAILED);
    }

    /// Reads lines from `handle` until `done` accepts one (10 s limit).
    fn read_until(
        handle: &mut dyn WorkerHandle,
        mut done: impl FnMut(&Value) -> bool,
    ) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            match handle.try_recv() {
                Some(WorkerEvent::Line(line)) => {
                    let v: Value = serde_json::from_str(&line).unwrap_or(Value::String(line));
                    let stop = done(&v);
                    seen.push(v);
                    if stop {
                        return seen;
                    }
                }
                Some(WorkerEvent::Exited(_)) => return seen,
                None => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        panic!("timed out; saw {seen:?}");
    }

    #[test]
    fn the_fake_worker_runs_call_steps_and_keeps_bookkeeping() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let script = json!({
            "stages": [],
            "behaviour": {
                "a": [
                    { "log": { "level": "info", "text": "hi" } },
                    { "emit": { "type": "output", "key": "k", "value": 1 } },
                    { "fail_before_attempt": 2 },
                    { "outcome": { "status": "ok" } }
                ],
                "w": [ { "wait_cancel_ms": 5000 } ],
                "x": [ { "exit": 7 } ]
            }
        });
        let launcher = fake_worker_launcher(script);
        let def = runtime("{ kind: python, python: nope, module: m }");
        let spec = worker_spec(root, "r", &def, &root.join("run"), &[]).unwrap();
        let mut h = launcher.launch(&spec).unwrap();
        let ctx = |attempt| CallContext {
            run_id: "r".into(),
            node_key: "n".into(),
            node_dir: "/d".into(),
            project_root: "/p".into(),
            stop_file: "/p/STOP".into(),
            attempt,
        };
        let is_outcome = |v: &Value| v["type"] == "outcome" || v["type"] == "error";
        h.send(&call_request("1", "c1", "a", &Map::new(), &ctx(1)))
            .unwrap();
        let seen = read_until(h.as_mut(), is_outcome);
        assert_eq!(seen.last().unwrap()["reason"], "attempt too low");
        assert!(seen
            .iter()
            .any(|v| v["type"] == "output" && v["callId"] == "c1"));
        h.send(&call_request("2", "c2", "a", &Map::new(), &ctx(2)))
            .unwrap();
        assert_eq!(
            read_until(h.as_mut(), is_outcome).last().unwrap()["status"],
            "ok"
        );
        h.send(&call_request("3", "c3", "nope", &Map::new(), &ctx(1)))
            .unwrap();
        assert_eq!(
            read_until(h.as_mut(), is_outcome).last().unwrap()["code"],
            FLOW_PYTHON_ENTRY_UNKNOWN
        );
        h.send(&call_request("4", "c4", "w", &Map::new(), &ctx(1)))
            .unwrap();
        h.send(&cancel_request("c4")).unwrap();
        assert_eq!(
            read_until(h.as_mut(), is_outcome).last().unwrap()["status"],
            "stopped"
        );
        h.send(&describe_request("5")).unwrap();
        read_until(h.as_mut(), |v| v["type"] == "manifest");
        let dir = root.join("run/runtimes/r");
        assert_eq!(
            std::fs::read_to_string(dir.join("pid")).unwrap(),
            h.pid().to_string()
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("describes.log"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        h.send(&call_request("6", "c6", "x", &Map::new(), &ctx(1)))
            .unwrap();
        read_until(h.as_mut(), |_| false);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(h.try_wait().unwrap(), Some(7));
    }
}

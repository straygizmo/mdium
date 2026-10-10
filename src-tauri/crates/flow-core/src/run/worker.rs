//! The resident Python worker of `python` nodes (spec 2026-10-10, chapter 3):
//! the `mdium-worker-v1` JSON-line protocol, the manifest a worker returns
//! to `describe`, input validation against a stage, interpreter resolution
//! and the piped child process behind [`WorkerLauncher`].

use crate::project::RuntimeDef;
use crate::run::model::Reason;
use crate::run::process::{parse_line, ProtocolItem, MAX_LINE_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
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
    /// A `manifest` line that does not deserialise (`error` is serde's message).
    BadManifest {
        request_id: Option<String>,
        error: String,
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
            let request_id = s(&obj, "requestId");
            match (serde_json::from_value::<Manifest>(Value::Object(obj)), request_id) {
                (Err(err), request_id) => WorkerMessage::BadManifest {
                    request_id,
                    error: err.to_string(),
                },
                (Ok(_), None) => WorkerMessage::Invalid {
                    reason: "missing-request-id",
                },
                (Ok(manifest), Some(request_id)) => WorkerMessage::Manifest {
                    request_id,
                    manifest,
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
    /// The resolved interpreter (see [`resolve_python`]).
    pub python: PathBuf,
    pub module: String,
    pub working_dir: PathBuf,
    pub env: Vec<(String, String)>,
    pub stderr: PathBuf,
    pub stdout_log: PathBuf,
}

#[derive(Debug)]
pub enum WorkerEvent {
    /// One line, decoded lossily (invalid UTF-8 never ends the reader).
    Line(String),
    /// A line longer than `MAX_LINE_BYTES`; it was dropped.
    TooLong,
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

impl Drop for PipedWorker {
    /// A worker must never outlive its owner (e.g. a panicking driver).
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            self.kill_tree();
        }
    }
}

/// Reads one line into `buf` without its `\n` / `\r\n`, keeping at most
/// `MAX_LINE_BYTES + 1` bytes and discarding the rest of a longer line.
/// `Ok(None)` at EOF; `Ok(Some(false))` when the line was too long.
fn read_capped_line(
    reader: &mut impl BufRead,
    buf: &mut Vec<u8>,
) -> std::io::Result<Option<bool>> {
    buf.clear();
    let cap = MAX_LINE_BYTES + 1;
    let mut read_any = false;
    let mut overflow = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            break;
        }
        read_any = true;
        let newline = available.iter().position(|&b| b == b'\n');
        let content = newline.unwrap_or(available.len());
        let room = cap.saturating_sub(buf.len());
        if content > room {
            overflow = true;
        }
        buf.extend_from_slice(&available[..content.min(room)]);
        reader.consume(newline.map_or(content, |i| i + 1));
        if newline.is_some() {
            break;
        }
    }
    if !read_any {
        return Ok(None);
    }
    if !overflow && buf.last() == Some(&b'\r') {
        buf.pop();
    }
    Ok(Some(!overflow && buf.len() <= MAX_LINE_BYTES))
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
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        // Only EOF or a real I/O error ends the reader.
        while let Ok(Some(fits)) = read_capped_line(&mut reader, &mut buf) {
            let event = if fits {
                WorkerEvent::Line(String::from_utf8_lossy(&buf).into_owned())
            } else {
                WorkerEvent::TooLong
            };
            if tx.send(event).is_err() {
                return;
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

/// Walks `relative` below `project_root` one component at a time (like
/// `load::resolve_in_project`): it must stay inside the root, every
/// component must exist, and none may be a symlink or junction, except the
/// leaf when `leaf_may_link` (a unix venv's `bin/python`). Returns the path
/// and the leaf's metadata with links followed.
fn walk_in_project(
    project_root: &Path,
    relative: &str,
    leaf_may_link: bool,
) -> Option<(PathBuf, std::fs::Metadata)> {
    let mut parts: Vec<&std::ffi::OsStr> = Vec::new();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => parts.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let mut current = project_root.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        current.push(part);
        let meta = std::fs::symlink_metadata(&current).ok()?;
        let leaf = i + 1 == parts.len();
        if meta.file_type().is_symlink() && !(leaf && leaf_may_link) {
            return None;
        }
    }
    let meta = std::fs::metadata(&current).ok()?;
    Some((current, meta))
}

/// The first interpreter candidate that is an existing regular file in the
/// project: no link on the way, though the leaf itself may be one (it must
/// then resolve to a regular file).
pub fn resolve_python(project_root: &Path, def: &RuntimeDef) -> Result<PathBuf, String> {
    let candidates = def.python.candidates();
    for candidate in &candidates {
        if let Some((path, meta)) = walk_in_project(project_root, candidate, true) {
            if meta.is_file() {
                return Ok(path);
            }
        }
    }
    Err(format!(
        "no interpreter found among {}",
        candidates.join(", ")
    ))
}

/// The runtime's working directory (an existing directory, no link anywhere).
pub fn resolve_cwd(project_root: &Path, def: &RuntimeDef) -> Result<PathBuf, String> {
    match walk_in_project(project_root, &def.cwd, false) {
        Some((path, meta)) if meta.is_dir() => Ok(path),
        _ => Err(format!(
            "working directory {} is not a directory in the project",
            def.cwd
        )),
    }
}

/// The last ~2 KB of a worker's `stderr.log`, trimmed; `None` when empty.
pub fn stderr_tail(path: &Path) -> Option<String> {
    const TAIL: u64 = 2048;
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Adds the worker's stderr tail to a start failure: a `stderr` param, also
/// appended to `message`.
pub fn with_stderr_tail(reason: Reason, stderr: &Path) -> Reason {
    let Some(tail) = stderr_tail(stderr) else {
        return reason;
    };
    let message = match reason.params.get("message").and_then(Value::as_str) {
        Some(message) => format!("{message}; stderr: {tail}"),
        None => format!("stderr: {tail}"),
    };
    reason.with("message", message).with("stderr", tail)
}

/// Opens a worker's `stderr.log` for appending, so it spans restarts.
pub fn open_stderr_log(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// Why a worker is gone before answering `describe` (waits briefly for its
/// exit code).
pub fn exited_before_describe(handle: &mut dyn WorkerHandle) -> String {
    let deadline = Instant::now() + Duration::from_millis(500);
    let code = loop {
        match handle.try_wait() {
            Ok(Some(code)) => break Some(code),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10))
            }
            _ => break None,
        }
    };
    match code {
        Some(code) => format!("the worker exited with code {code} before answering describe"),
        None => "the worker exited before answering describe".to_string(),
    }
}

/// The message of a manifest the worker sent but that does not deserialise.
pub fn bad_manifest_message(error: &str) -> String {
    format!("the worker sent an invalid manifest: {error}")
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
    let python = resolve_python(project_root, def).map_err(start_failed)?;
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
        python,
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
        let mut cmd = Command::new(&spec.python);
        cmd.args(["-m", "mdium_worker", "--module", &spec.module])
            .current_dir(&spec.working_dir)
            .envs(spec.env.iter().cloned())
            .stderr(open_stderr_log(&spec.stderr)?);
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
                WorkerMessage::BadManifest { request_id, error }
                    if request_id.as_deref().is_none_or(|id| id == "1") =>
                {
                    break Err(fail(bad_manifest_message(&error)))
                }
                WorkerMessage::Error { message, .. } => break Err(fail(message)),
                _ => {}
            },
            Some(WorkerEvent::TooLong) => {}
            Some(WorkerEvent::Exited(_)) => break Err(fail(exited_before_describe(handle.as_mut()))),
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
    let mut exited = false;
    while Instant::now() < grace {
        if matches!(handle.try_wait(), Ok(Some(_))) {
            exited = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !exited {
        handle.kill_tree();
    }
    // Read once the worker is gone, so its last words are in the file.
    result.map_err(|reason| with_stderr_tail(reason, &spec.stderr))
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
    fn a_manifest_that_does_not_deserialise_is_a_bad_manifest() {
        match parse_worker_line(
            r#"{"v":1,"type":"manifest","requestId":"1","module":"m","stages":[{"name":"a","outputs":{"k":{"type":"file"}}}]}"#,
        ) {
            WorkerMessage::BadManifest { request_id, error } => {
                assert_eq!(request_id.as_deref(), Some("1"));
                assert!(error.contains("file"), "{error}");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse_worker_line(r#"{"v":1,"type":"manifest","module":"m","stages":"x"}"#),
            WorkerMessage::BadManifest { request_id: None, .. }
        ));
        assert!(matches!(
            parse_worker_line(r#"{"v":1,"type":"manifest","module":"m","stages":[]}"#),
            WorkerMessage::Invalid {
                reason: "missing-request-id"
            }
        ));
    }

    #[test]
    fn reads_lines_lossily_and_drops_over_long_ones() {
        let mut data = b"{\"a\":1}\r\n\xff\xfe\n".to_vec();
        data.extend(std::iter::repeat_n(b'x', MAX_LINE_BYTES + 10));
        data.extend_from_slice(b"\nnext\n");
        data.extend(std::iter::repeat_n(b'y', MAX_LINE_BYTES));
        data.extend_from_slice(b"\r\ntail");
        let mut reader = std::io::BufReader::with_capacity(1024, &data[..]);
        let mut buf = Vec::new();
        let mut lines = Vec::new();
        while let Some(fits) = read_capped_line(&mut reader, &mut buf).unwrap() {
            assert!(buf.len() <= MAX_LINE_BYTES + 1);
            lines.push(fits.then(|| String::from_utf8_lossy(&buf).into_owned()));
        }
        let lens: Vec<Option<usize>> = lines.iter().map(|l| l.as_ref().map(String::len)).collect();
        assert_eq!(lines.len(), 6, "{lens:?}");
        assert_eq!(lines[0].as_deref(), Some("{\"a\":1}"));
        assert_eq!(lines[1].as_deref(), Some("\u{FFFD}\u{FFFD}"));
        assert_eq!(lines[2], None, "the over-long line is dropped");
        assert_eq!(lines[3].as_deref(), Some("next"));
        // Exactly the limit (its `\r` stripped) still fits.
        assert_eq!(lens[4], Some(MAX_LINE_BYTES));
        // The unterminated last line still arrives.
        assert_eq!(lines[5].as_deref(), Some("tail"));
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
        // A directory is no interpreter, a file no working directory, and
        // `..` may not leave the root.
        let dir = runtime("{ kind: python, python: sub, module: m }");
        assert!(resolve_python(root, &dir).is_err());
        let file_cwd = runtime("{ kind: python, python: p, module: m, cwd: .venv/bin/python }");
        assert!(resolve_cwd(root, &file_cwd).is_err());
        assert!(walk_in_project(root, "../x", false).is_none());
        assert_eq!(
            walk_in_project(root, "sub/../.venv/bin/python", false).map(|(p, _)| p),
            Some(root.join(".venv").join("bin").join("python"))
        );
        // The spec carries the resolved interpreter.
        let spec = worker_spec(root, "r", &def, &root.join("run"), &[]).unwrap();
        assert_eq!(spec.python, root.join(".venv/bin/python"));
        let missing = runtime("{ kind: python, python: nope, module: m }");
        let err = worker_spec(root, "r", &missing, &root.join("run"), &[]).unwrap_err();
        assert_eq!(err.code, FLOW_RUNTIME_START_FAILED);
    }

    #[cfg(unix)]
    #[test]
    fn links_are_rejected_except_on_the_interpreter_leaf() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // A unix venv: `bin/python` links to the base interpreter (accepted).
        std::fs::write(root.join("real-python"), "").unwrap();
        symlink(root.join("real-python"), root.join("link-python")).unwrap();
        let leaf = runtime("{ kind: python, python: link-python, module: m }");
        assert_eq!(resolve_python(root, &leaf).unwrap(), root.join("link-python"));
        // A dangling leaf link is no interpreter.
        symlink(root.join("gone"), root.join("dangling")).unwrap();
        let dangling = runtime("{ kind: python, python: dangling, module: m }");
        assert!(resolve_python(root, &dangling).is_err());
        // A linked `.venv` directory is rejected.
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("bin")).unwrap();
        std::fs::write(outside.path().join("bin/python"), "").unwrap();
        symlink(outside.path(), root.join(".venv")).unwrap();
        let venv = runtime("{ kind: python, python: .venv/bin/python, module: m }");
        assert!(resolve_python(root, &venv).is_err());
        // A linked `cwd` is rejected, leaf or parent.
        std::fs::create_dir_all(root.join("real-dir/inner")).unwrap();
        symlink(root.join("real-dir"), root.join("link-dir")).unwrap();
        let cwd = runtime("{ kind: python, python: real-python, module: m, cwd: link-dir }");
        assert!(resolve_cwd(root, &cwd).is_err());
        let parent = runtime("{ kind: python, python: real-python, module: m, cwd: link-dir/inner }");
        assert!(resolve_cwd(root, &parent).is_err());
    }

    #[test]
    fn stderr_log_is_appended_and_its_tail_joins_the_reason() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("stderr.log");
        assert!(stderr_tail(&path).is_none());
        writeln!(open_stderr_log(&path).unwrap(), "first").unwrap();
        writeln!(open_stderr_log(&path).unwrap(), "second").unwrap();
        assert_eq!(stderr_tail(&path).as_deref(), Some("first\nsecond"));
        let reason = with_stderr_tail(
            Reason::new(FLOW_RUNTIME_START_FAILED).with("message", "boom"),
            &path,
        );
        assert_eq!(reason.params["message"], "boom; stderr: first\nsecond");
        assert_eq!(reason.params["stderr"], "first\nsecond");
        std::fs::write(&path, "z".repeat(5000)).unwrap();
        assert_eq!(stderr_tail(&path).unwrap().len(), 2048);
    }

    /// A project root holding the interpreter file `nope` (the fake launcher
    /// ignores it, but `worker_spec` resolves it).
    fn fake_root() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("nope"), "").unwrap();
        tmp
    }

    #[test]
    fn describe_runtime_returns_the_manifest_from_a_live_worker() {
        let tmp = fake_root();
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
        let tmp = fake_root();
        let root = tmp.path();
        let def = runtime("{ kind: python, python: nope, module: m }");
        let spec = worker_spec(root, "r", &def, &root.join("run"), &[]).unwrap();
        let exits = fake_worker_launcher(serde_json::json!({ "exit_on_describe": 3 }));
        let err = describe_runtime(exits.as_ref(), &spec, Duration::from_secs(10)).unwrap_err();
        assert_eq!(err.code, FLOW_RUNTIME_START_FAILED);
        let message = err.params["message"].as_str().unwrap();
        assert!(message.contains("code 3"), "{message}");
        // I5: the cause is in the worker's stderr, now part of the reason.
        assert!(message.contains("stderr: fake worker: exiting on describe"), "{message}");
        assert!(err.params["stderr"].as_str().unwrap().contains("exiting on describe"));
        let silent = fake_worker_launcher(serde_json::json!({ "ignore_describe": true }));
        let err = describe_runtime(silent.as_ref(), &spec, Duration::from_millis(300)).unwrap_err();
        assert_eq!(err.code, FLOW_RUNTIME_START_FAILED);
        // I4: an invalid manifest fails at once with serde's message.
        let bad = fake_worker_launcher(serde_json::json!({ "stages": [{ "name": "a", "outputs": { "k": "path" } }] }));
        let started = Instant::now();
        let err = describe_runtime(bad.as_ref(), &spec, Duration::from_secs(20)).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(10));
        let message = err.params["message"].as_str().unwrap();
        assert!(message.contains("invalid manifest"), "{message}");
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
                Some(WorkerEvent::TooLong) => seen.push(Value::String("<too long>".into())),
                Some(WorkerEvent::Exited(_)) => return seen,
                None => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        panic!("timed out; saw {seen:?}");
    }

    #[test]
    fn the_fake_worker_runs_call_steps_and_keeps_bookkeeping() {
        let tmp = fake_root();
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

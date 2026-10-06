//! On-disk layout of flow runs (spec 3): `.mdium/flow-runs/<runId>/`
//! with `run.json`, the append-only `events.jsonl` (the source of truth),
//! the `state.json` checkpoint, the `STOP` file and per-attempt node
//! directories.

use crate::flow::model::FlowDef;
use crate::flow::run::model::{apply, EventBody, FlowEvent, RunState};
use crate::workflow::fsutil;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// Directory of all runs, relative to the project root.
pub const RUNS_DIR: &str = ".mdium/flow-runs";
pub const RUN_SCHEMA_VERSION: u32 = 1;
/// Checkpoint at least every this many events (spec 4.4).
pub const CHECKPOINT_EVERY: u64 = 50;

/// `run.json`: what was started, with which definition and arguments.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMeta {
    pub schema_version: u32,
    pub run_id: String,
    /// Project-relative path of the flow file.
    pub flow_path: String,
    /// SHA-256 of the exact file content that was confirmed and parsed.
    pub flow_sha256: String,
    /// Snapshot of the definition at start (later edits don't affect the run).
    pub flow: FlowDef,
    /// Arguments with defaults applied.
    pub params: BTreeMap<String, Value>,
    pub created_at: String,
    pub started_by: String,
}

/// A run id is 16 lowercase hex characters (never a path).
pub fn is_valid_run_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Directory name for a node key: only `[A-Za-z0-9_.-]`, `/` → `__`,
/// `[i]` → `.i` (spec 3).
pub fn node_dir_name(node_key: &str) -> String {
    let mut out = String::new();
    for c in node_key.chars() {
        match c {
            '/' => out.push_str("__"),
            '[' => out.push('.'),
            ']' => {}
            c if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' => out.push(c),
            _ => out.push('_'),
        }
    }
    if out.is_empty() || out.chars().all(|c| c == '.') {
        out = format!("_{out}");
    }
    out
}

/// Errors of the store.
#[derive(Debug)]
pub enum StoreError {
    InvalidRunId(String),
    NotFound(String),
    Io(io::Error),
    Corrupt(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::InvalidRunId(id) => write!(f, "invalid run id {id:?}"),
            StoreError::NotFound(id) => write!(f, "run {id} not found"),
            StoreError::Io(err) => write!(f, "{err}"),
            StoreError::Corrupt(detail) => write!(f, "corrupt run data: {detail}"),
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(err: io::Error) -> Self {
        StoreError::Io(err)
    }
}

/// Access to one project's runs.
#[derive(Debug, Clone)]
pub struct RunStore {
    project_root: PathBuf,
}

impl RunStore {
    pub fn new(project_root: &Path) -> Self {
        Self {
            project_root: project_root.to_path_buf(),
        }
    }

    pub fn project_root(&self) -> &Path {
        &self.project_root
    }

    pub fn runs_dir(&self) -> PathBuf {
        self.project_root.join(RUNS_DIR)
    }

    pub fn run_dir(&self, run_id: &str) -> Result<PathBuf, StoreError> {
        if !is_valid_run_id(run_id) {
            return Err(StoreError::InvalidRunId(run_id.to_string()));
        }
        Ok(self.runs_dir().join(run_id))
    }

    pub fn stop_file(&self, run_id: &str) -> Result<PathBuf, StoreError> {
        Ok(self.run_dir(run_id)?.join("STOP"))
    }

    /// `nodes/<nodeKey>/<attempt>/` of one attempt.
    pub fn node_attempt_dir(
        &self,
        run_id: &str,
        node_key: &str,
        attempt: u32,
    ) -> Result<PathBuf, StoreError> {
        Ok(self
            .run_dir(run_id)?
            .join("nodes")
            .join(node_dir_name(node_key))
            .join(attempt.to_string()))
    }

    /// Creates the run directory with `run.json` and an empty event log.
    pub fn create(&self, meta: &RunMeta) -> Result<(), StoreError> {
        let dir = self.run_dir(&meta.run_id)?;
        if dir.exists() {
            return Err(StoreError::Corrupt(format!(
                "run {} already exists",
                meta.run_id
            )));
        }
        fs::create_dir_all(&dir)?;
        let json =
            serde_json::to_vec_pretty(meta).map_err(|e| StoreError::Corrupt(e.to_string()))?;
        fsutil::atomic_write(&dir.join("run.json"), &json)?;
        File::create(dir.join("events.jsonl"))?;
        Ok(())
    }

    pub fn load_meta(&self, run_id: &str) -> Result<RunMeta, StoreError> {
        let path = self.run_dir(run_id)?.join("run.json");
        let bytes = fs::read(&path).map_err(|err| match err.kind() {
            io::ErrorKind::NotFound => StoreError::NotFound(run_id.to_string()),
            _ => StoreError::Io(err),
        })?;
        serde_json::from_slice(&bytes).map_err(|e| StoreError::Corrupt(format!("run.json: {e}")))
    }

    /// Ids of all runs (directories with a valid id and a `run.json`).
    pub fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        let dir = self.runs_dir();
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(err) => return Err(err.into()),
        };
        let mut ids = Vec::new();
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_valid_run_id(&name)
                && entry.file_type()?.is_dir()
                && entry.path().join("run.json").is_file()
            {
                ids.push(name);
            }
        }
        ids.sort();
        Ok(ids)
    }

    /// All events; a truncated or unparsable last line is dropped (a crash
    /// while appending), an unparsable line elsewhere is corruption.
    pub fn read_events(&self, run_id: &str) -> Result<Vec<FlowEvent>, StoreError> {
        let path = self.run_dir(run_id)?.join("events.jsonl");
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(err) => return Err(err.into()),
        };
        let mut lines: Vec<String> = Vec::new();
        for line in BufReader::new(file).split(b'\n') {
            lines.push(String::from_utf8_lossy(&line?).into_owned());
        }
        let mut events = Vec::new();
        let last = lines.len().saturating_sub(1);
        for (i, line) in lines.iter().enumerate() {
            let line = line.trim_end_matches('\r');
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<FlowEvent>(line) {
                Ok(event) => events.push(event),
                Err(_) if i == last => break,
                Err(err) => {
                    return Err(StoreError::Corrupt(format!(
                        "events.jsonl line {}: {err}",
                        i + 1
                    )))
                }
            }
        }
        Ok(events)
    }

    /// Current state: the checkpoint plus the events after it, or a full
    /// replay when the checkpoint is missing, unreadable or ahead of the log.
    pub fn load_state(&self, run_id: &str, meta: &RunMeta) -> Result<RunState, StoreError> {
        let events = self.read_events(run_id)?;
        let last_seq = events.last().map(|e| e.seq).unwrap_or(0);
        let checkpoint = fs::read(self.run_dir(run_id)?.join("state.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RunState>(&bytes).ok())
            .filter(|state| state.seq <= last_seq);
        let mut state = checkpoint.unwrap_or_else(|| initial_state(meta));
        let from = state.seq;
        for event in events.iter().filter(|e| e.seq > from) {
            apply(&mut state, event);
        }
        Ok(state)
    }

    pub fn write_checkpoint(&self, run_id: &str, state: &RunState) -> Result<(), StoreError> {
        let json =
            serde_json::to_vec_pretty(state).map_err(|e| StoreError::Corrupt(e.to_string()))?;
        fsutil::atomic_write(&self.run_dir(run_id)?.join("state.json"), &json)?;
        Ok(())
    }

    /// Opens the event log for appending.
    pub fn open_log(&self, run_id: &str) -> Result<EventLog, StoreError> {
        let path = self.run_dir(run_id)?.join("events.jsonl");
        // Drop a torn last line so new events start on a fresh line.
        let bytes = fs::read(&path).unwrap_or_default();
        if !bytes.is_empty() && !bytes.ends_with(b"\n") {
            let keep = bytes
                .iter()
                .rposition(|b| *b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(0);
            let file = OpenOptions::new().write(true).open(&path)?;
            file.set_len(keep as u64)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(EventLog { file })
    }

    /// Deletes a run directory.
    pub fn delete(&self, run_id: &str) -> Result<(), StoreError> {
        let dir = self.run_dir(run_id)?;
        fs::remove_dir_all(&dir)?;
        Ok(())
    }
}

/// State before any event: every top-level node pending.
pub fn initial_state(meta: &RunMeta) -> RunState {
    RunState::new(meta.flow.nodes.iter().map(|n| n.id.as_str()))
}

/// Append handle of `events.jsonl`.
pub struct EventLog {
    file: File,
}

impl EventLog {
    /// Writes one event line; status events are also fsynced.
    pub fn append(&mut self, event: &FlowEvent) -> io::Result<()> {
        let mut line = serde_json::to_vec(event).map_err(io::Error::other)?;
        line.push(b'\n');
        self.file.write_all(&line)?;
        self.file.flush()?;
        if matches!(
            event.body,
            EventBody::RunStatus { .. } | EventBody::NodeStatus { .. }
        ) {
            self.file.sync_data()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::load::check_text;
    use crate::flow::parse::FlowFormat;
    use crate::flow::run::model::{NodeStatus, RunStatus};

    pub(crate) fn meta(run_id: &str) -> RunMeta {
        let yaml = "schemaVersion: 1\nid: t\nname: T\nnodes:\n  - { id: a, kind: command, run: [x] }\n  - { id: b, kind: command, run: [y] }\nedges:\n  - { from: a, to: b }\n";
        let (flow, issues) = check_text(yaml, FlowFormat::Yaml);
        assert!(issues.errors.is_empty());
        RunMeta {
            schema_version: RUN_SCHEMA_VERSION,
            run_id: run_id.into(),
            flow_path: ".mdium/flows/t.flow.yaml".into(),
            flow_sha256: "00".into(),
            flow: flow.unwrap(),
            params: BTreeMap::new(),
            created_at: "now".into(),
            started_by: "test".into(),
        }
    }

    fn ev(seq: u64, node: Option<&str>, body: EventBody) -> FlowEvent {
        FlowEvent {
            seq,
            ts: format!("t{seq}"),
            node_key: node.map(String::from),
            body,
        }
    }

    fn status(seq: u64, node: &str, from: NodeStatus, to: NodeStatus) -> FlowEvent {
        ev(
            seq,
            Some(node),
            EventBody::NodeStatus {
                from,
                to,
                attempt: 1,
                reason: None,
                port: None,
            },
        )
    }

    const ID: &str = "0123456789abcdef";

    #[test]
    fn run_ids_and_node_dirs_are_safe() {
        assert!(is_valid_run_id(ID));
        for bad in [
            "",
            "0123456789ABCDEF",
            "../../etc/passwd",
            "0123456789abcde",
            "0123456789abcdefg",
        ] {
            assert!(!is_valid_run_id(bad), "{bad}");
        }
        let store = RunStore::new(Path::new("/p"));
        assert!(matches!(
            store.run_dir("../x"),
            Err(StoreError::InvalidRunId(_))
        ));
        assert_eq!(node_dir_name("docs[3]/summarize"), "docs.3__summarize");
        assert_eq!(node_dir_name("a b:c"), "a_b_c");
        assert_eq!(node_dir_name(".."), "_..");
        assert_eq!(node_dir_name(""), "_");
    }

    #[test]
    fn create_append_and_replay() {
        let tmp = tempfile::tempdir().unwrap();
        let store = RunStore::new(tmp.path());
        let meta = meta(ID);
        store.create(&meta).unwrap();
        assert!(store.create(&meta).is_err(), "a run id is never reused");
        assert_eq!(store.list_ids().unwrap(), vec![ID.to_string()]);
        assert_eq!(store.load_meta(ID).unwrap(), meta);
        let mut log = store.open_log(ID).unwrap();
        let events = vec![
            ev(
                1,
                None,
                EventBody::RunStatus {
                    from: RunStatus::Pending,
                    to: RunStatus::Running,
                    reason: None,
                },
            ),
            status(2, "a", NodeStatus::Pending, NodeStatus::Ready),
            status(3, "a", NodeStatus::Ready, NodeStatus::Running),
        ];
        for e in &events {
            log.append(e).unwrap();
        }
        assert_eq!(store.read_events(ID).unwrap(), events);
        let state = store.load_state(ID, &meta).unwrap();
        assert_eq!(state.seq, 3);
        assert_eq!(state.status, RunStatus::Running);
        assert_eq!(state.nodes["a"].status, NodeStatus::Running);
        assert_eq!(state.nodes["b"].status, NodeStatus::Pending);
    }

    #[test]
    fn torn_last_line_is_dropped_and_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let store = RunStore::new(tmp.path());
        let meta = meta(ID);
        store.create(&meta).unwrap();
        let mut log = store.open_log(ID).unwrap();
        log.append(&status(1, "a", NodeStatus::Pending, NodeStatus::Ready))
            .unwrap();
        drop(log);
        let path = store.run_dir(ID).unwrap().join("events.jsonl");
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"seq\":2,\"ts\":\"t\",\"type\":\"node_st")
            .unwrap();
        drop(file);
        assert_eq!(store.read_events(ID).unwrap().len(), 1);
        // Reopening truncates the torn line; the next event lands on its own line.
        let mut log = store.open_log(ID).unwrap();
        log.append(&status(2, "a", NodeStatus::Ready, NodeStatus::Running))
            .unwrap();
        let events = store.read_events(ID).unwrap();
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn corruption_before_the_end_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let store = RunStore::new(tmp.path());
        store.create(&meta(ID)).unwrap();
        let path = store.run_dir(ID).unwrap().join("events.jsonl");
        let good =
            serde_json::to_string(&status(2, "a", NodeStatus::Pending, NodeStatus::Ready)).unwrap();
        fs::write(&path, format!("garbage\n{good}\n")).unwrap();
        assert!(matches!(store.read_events(ID), Err(StoreError::Corrupt(_))));
    }

    #[test]
    fn checkpoint_is_used_and_rebuilt_when_broken() {
        let tmp = tempfile::tempdir().unwrap();
        let store = RunStore::new(tmp.path());
        let meta = meta(ID);
        store.create(&meta).unwrap();
        let mut log = store.open_log(ID).unwrap();
        let first = status(1, "a", NodeStatus::Pending, NodeStatus::Ready);
        log.append(&first).unwrap();
        let mut state = initial_state(&meta);
        apply(&mut state, &first);
        store.write_checkpoint(ID, &state).unwrap();
        let second = status(2, "a", NodeStatus::Ready, NodeStatus::Running);
        log.append(&second).unwrap();
        // Checkpoint (seq 1) + replay of seq 2.
        let loaded = store.load_state(ID, &meta).unwrap();
        assert_eq!(loaded.seq, 2);
        assert_eq!(loaded.nodes["a"].status, NodeStatus::Running);
        // A checkpoint that is ahead of the log (log lost its tail) is ignored.
        let mut ahead = loaded.clone();
        ahead.seq = 99;
        store.write_checkpoint(ID, &ahead).unwrap();
        assert_eq!(store.load_state(ID, &meta).unwrap(), loaded);
        // A broken checkpoint is rebuilt from the events.
        fs::write(store.run_dir(ID).unwrap().join("state.json"), b"{nope").unwrap();
        assert_eq!(store.load_state(ID, &meta).unwrap(), loaded);
    }

    #[test]
    fn missing_runs_and_bad_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let store = RunStore::new(tmp.path());
        assert!(store.list_ids().unwrap().is_empty());
        assert!(matches!(store.load_meta(ID), Err(StoreError::NotFound(_))));
        fs::create_dir_all(store.runs_dir().join("not-a-run")).unwrap();
        fs::create_dir_all(store.runs_dir().join("fedcba9876543210")).unwrap(); // no run.json
        assert!(store.list_ids().unwrap().is_empty());
        assert_eq!(
            store.node_attempt_dir(ID, "a", 2).unwrap(),
            tmp.path()
                .join(RUNS_DIR)
                .join(ID)
                .join("nodes")
                .join("a")
                .join("2")
        );
    }
}

//! The process-wide flow engine: command confirmation (spec 7.2), run
//! start, user operations (stop / resume / cancel / approve / rerun /
//! mark succeeded / delete), recovery after an app exit or crash, and one
//! driver thread per active run.

use crate::flow::load::{self, check_content, PathProblem, MAX_FLOW_FILE_BYTES};
use crate::flow::model::NodeKind;
use crate::flow::run::driver::{Control, Driver, DriverEnv, Editor, FLOW_APP_EXITED, FLOW_RESUMED};
use crate::flow::run::model::{NodeStatus, Reason, RunState, RunStatus};
use crate::flow::run::prepare::{
    check_runnable, command_summaries, prepare_params, CommandSummary,
};
use crate::flow::run::process::tail_file;
use crate::flow::run::store::{RunMeta, RunStore, StoreError, RUN_SCHEMA_VERSION};
use crate::flow::run::supervise::DetachedProcess;
use crate::workflow::fsutil;
use crate::workflow::state::project_key;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

// Operation error codes.
pub const FLOW_FILE_PATH_INVALID: &str = "FLOW_FILE_PATH_INVALID";
pub const FLOW_FILE_NOT_FOUND: &str = "FLOW_FILE_NOT_FOUND";
pub const FLOW_FILE_CHANGED: &str = "FLOW_FILE_CHANGED";
pub const FLOW_FILE_INVALID: &str = "FLOW_FILE_INVALID";
pub const FLOW_COMMANDS_UNCONFIRMED: &str = "FLOW_COMMANDS_UNCONFIRMED";
pub const FLOW_RUN_NOT_RUNNABLE: &str = "FLOW_RUN_NOT_RUNNABLE";
pub const FLOW_PARAMS_INVALID: &str = "FLOW_PARAMS_INVALID";
pub const FLOW_RUN_NOT_FOUND: &str = "FLOW_RUN_NOT_FOUND";
pub const FLOW_RUN_INVALID_ID: &str = "FLOW_RUN_INVALID_ID";
pub const FLOW_RUN_BUSY: &str = "FLOW_RUN_BUSY";
pub const FLOW_RUN_INVALID_STATE: &str = "FLOW_RUN_INVALID_STATE";
pub const FLOW_NODE_NOT_FOUND: &str = "FLOW_NODE_NOT_FOUND";
pub const FLOW_NODE_INVALID_STATE: &str = "FLOW_NODE_INVALID_STATE";
pub const FLOW_NODE_NEEDS_ACTION: &str = "FLOW_NODE_NEEDS_ACTION";
pub const FLOW_APPROVAL_INVALID: &str = "FLOW_APPROVAL_INVALID";
pub const FLOW_STORE_FAILED: &str = "FLOW_STORE_FAILED";
pub const FLOW_LOG_INVALID: &str = "FLOW_LOG_INVALID";

/// Largest log tail returned at once.
pub const MAX_LOG_BYTES: u64 = 256 * 1024;

/// A failed operation: a code for the UI, a log message, and details
/// (validation problems, nodes needing action, ...).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<Reason>,
}

impl EngineError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: Vec::new(),
        }
    }

    fn with_details(mut self, details: Vec<Reason>) -> Self {
        self.details = details;
        self
    }
}

impl From<StoreError> for EngineError {
    fn from(err: StoreError) -> Self {
        match err {
            StoreError::InvalidRunId(id) => EngineError::new(FLOW_RUN_INVALID_ID, id),
            StoreError::NotFound(id) => EngineError::new(FLOW_RUN_NOT_FOUND, id),
            other => EngineError::new(FLOW_STORE_FAILED, other.to_string()),
        }
    }
}

type Result<T> = std::result::Result<T, EngineError>;

/// The commands of a flow file for confirmation (spec 7.2).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReview {
    pub path: String,
    pub sha256: String,
    pub confirmed: bool,
    pub commands: Vec<CommandSummary>,
}

/// A run in a list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub flow_path: String,
    pub flow_name: String,
    pub status: RunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub cost_usd: f64,
    pub pending_approvals: usize,
}

/// One run with its definition and state.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub meta: RunMeta,
    pub state: RunState,
    /// A driver is working on the run in this app process.
    pub active: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Confirmation {
    project_key: String,
    flow_path: String,
    sha256: String,
    confirmed_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmationFile {
    version: u32,
    entries: Vec<Confirmation>,
}

struct Slot {
    tx: Sender<Control>,
    done: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct Inner {
    slots: HashMap<(PathBuf, String), Slot>,
    attached: HashSet<PathBuf>,
}

pub struct FlowEngine {
    env: DriverEnv,
    confirmations: PathBuf,
    inner: Mutex<Inner>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The flow file's bytes and its project-relative display path.
fn read_flow(root: &Path, rel: &str) -> Result<(PathBuf, String, Vec<u8>)> {
    let file = load::resolve_flow_path(root, rel, true).map_err(|problem| match problem {
        PathProblem::NotFound => EngineError::new(FLOW_FILE_NOT_FOUND, rel),
        PathProblem::Outside(reason) => {
            EngineError::new(FLOW_FILE_PATH_INVALID, format!("{rel} ({reason})"))
        }
    })?;
    let meta = std::fs::metadata(&file)
        .map_err(|e| EngineError::new(FLOW_FILE_NOT_FOUND, e.to_string()))?;
    if meta.len() > MAX_FLOW_FILE_BYTES {
        return Err(EngineError::new(FLOW_FILE_INVALID, "file too large"));
    }
    let bytes =
        std::fs::read(&file).map_err(|e| EngineError::new(FLOW_FILE_NOT_FOUND, e.to_string()))?;
    let display = load::relative_display(root, &file);
    Ok((file, display, bytes))
}

/// A flow file with every flow file it references (sub-flows, file loop
/// bodies), read once: what is confirmed, snapshotted and run.
struct Bundle {
    display: String,
    root_sha: String,
    flow: crate::flow::model::FlowDef,
    /// Referenced files by project-relative path: (sha256, flow).
    others: BTreeMap<String, (String, crate::flow::model::FlowDef)>,
    refs: BTreeMap<String, String>,
}

impl Bundle {
    /// The confirmed hash: the file's own hash when it references nothing,
    /// otherwise a hash over every file's path and hash.
    fn hash(&self) -> String {
        if self.others.is_empty() {
            return self.root_sha.clone();
        }
        let mut text = String::from("mdium-flow-bundle-v1\n");
        let mut files: Vec<(&str, &str)> = vec![(self.display.as_str(), self.root_sha.as_str())];
        files.extend(
            self.others
                .iter()
                .map(|(p, (sha, _))| (p.as_str(), sha.as_str())),
        );
        files.sort();
        for (path, sha) in files {
            text.push_str(&format!("{path}\t{sha}\n"));
        }
        sha256_hex(text.as_bytes())
    }

    fn files(&self) -> Vec<(&str, &crate::flow::model::FlowDef)> {
        let mut out = vec![(self.display.as_str(), &self.flow)];
        out.extend(self.others.iter().map(|(p, (_, f))| (p.as_str(), f)));
        out
    }
}

/// References to other flow files in `nodes` (sub-flows and file bodies, any depth).
fn flow_refs(nodes: &[crate::flow::model::FlowNode], out: &mut Vec<String>) {
    use crate::flow::model::LoopBody;
    for node in nodes {
        match &node.kind {
            NodeKind::Subflow(sub) => out.push(sub.flow.clone()),
            NodeKind::Loop(lp) => match &lp.body {
                LoopBody::File(file) => out.push(file.clone()),
                LoopBody::Inline(body) => flow_refs(&body.nodes, out),
            },
            _ => {}
        }
    }
}

/// Reads, validates and resolves a flow and everything it references.
fn load_bundle(root: &Path, rel: &str) -> Result<Bundle> {
    use crate::flow::load::{check_text, resolve_in_project};
    use crate::flow::parse::FlowFormat;
    let (file, display, bytes) = read_flow(root, rel)?;
    let root_sha = sha256_hex(&bytes);
    let text = String::from_utf8_lossy(&bytes);
    let report = check_content(root, &file, &text);
    if !report.errors.is_empty() {
        let details = report
            .errors
            .iter()
            .map(|i| {
                Reason {
                    code: i.code.clone(),
                    params: i.params.clone(),
                }
                .with("path", i.path.clone())
            })
            .collect();
        return Err(
            EngineError::new(FLOW_FILE_INVALID, "the flow has validation errors")
                .with_details(details),
        );
    }
    let flow = report
        .flow
        .ok_or_else(|| EngineError::new(FLOW_FILE_INVALID, "flow could not be decoded"))?;
    let mut others = BTreeMap::new();
    let mut refs = BTreeMap::new();
    let mut queue = vec![(file, display.clone(), flow.clone())];
    while let Some((abs, owner, def)) = queue.pop() {
        let mut found = Vec::new();
        flow_refs(&def.nodes, &mut found);
        let base = abs.parent().unwrap_or(root).to_path_buf();
        for reference in found {
            let child = resolve_in_project(root, &base, &reference).map_err(|_| {
                EngineError::new(FLOW_FILE_INVALID, format!("cannot resolve {reference}"))
            })?;
            let child_display = load::relative_display(root, &child);
            refs.insert(
                crate::flow::run::scope::ref_key(&owner, &reference),
                child_display.clone(),
            );
            if child_display == display || others.contains_key(&child_display) {
                continue;
            }
            let (_, _, child_bytes) = read_flow(root, &child_display)?;
            let format = child
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(FlowFormat::from_file_name)
                .ok_or_else(|| EngineError::new(FLOW_FILE_INVALID, child_display.clone()))?;
            let (child_flow, issues) = check_text(&String::from_utf8_lossy(&child_bytes), format);
            let child_flow = match child_flow {
                Some(f) if issues.errors.is_empty() => f,
                _ => return Err(EngineError::new(FLOW_FILE_INVALID, child_display)),
            };
            others.insert(
                child_display.clone(),
                (sha256_hex(&child_bytes), child_flow.clone()),
            );
            queue.push((child, child_display, child_flow));
        }
    }
    Ok(Bundle {
        display,
        root_sha,
        flow,
        others,
        refs,
    })
}

impl FlowEngine {
    /// `confirmations`: per-machine file of confirmed command lists.
    pub fn new(env: DriverEnv, confirmations: PathBuf) -> Self {
        Self {
            env,
            confirmations,
            inner: Mutex::new(Inner::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn key(root: &Path) -> PathBuf {
        project_key(root)
    }

    /// True while a driver thread works on the run (finished slots are reaped).
    fn is_active(inner: &mut Inner, root: &Path, run_id: &str) -> bool {
        let key = (Self::key(root), run_id.to_string());
        if let Some(slot) = inner.slots.get_mut(&key) {
            if slot.done.load(Ordering::SeqCst) {
                if let Some(join) = slot.join.take() {
                    let _ = join.join();
                }
                inner.slots.remove(&key);
                return false;
            }
            return true;
        }
        false
    }

    fn spawn_driver(
        &self,
        inner: &mut Inner,
        root: &Path,
        run_id: &str,
        reason: Option<Reason>,
    ) -> Result<()> {
        let (tx, rx) = channel();
        let driver = Driver::open(RunStore::new(root), run_id, rx, self.env.clone())
            .map_err(|e| EngineError::new(FLOW_STORE_FAILED, e))?;
        let done = Arc::new(AtomicBool::new(false));
        let done_flag = done.clone();
        let join = std::thread::Builder::new()
            .name(format!("flow-run-{run_id}"))
            .spawn(move || {
                driver.run(reason);
                done_flag.store(true, Ordering::SeqCst);
            })
            .map_err(|e| EngineError::new(FLOW_STORE_FAILED, e.to_string()))?;
        inner.slots.insert(
            (Self::key(root), run_id.to_string()),
            Slot {
                tx,
                done,
                join: Some(join),
            },
        );
        Ok(())
    }

    fn editor(&self, root: &Path, run_id: &str) -> Result<Editor> {
        Editor::open(RunStore::new(root), run_id, self.env.clone())
            .map_err(|e| EngineError::new(FLOW_STORE_FAILED, e))
    }

    /// First contact with a project in this process: recover runs that were
    /// active when the app last exited (spec 4.6; detached reconnect is PR 3b).
    pub fn attach(&self, root: &Path) -> Result<()> {
        let mut inner = self.lock();
        if !inner.attached.insert(Self::key(root)) {
            return Ok(());
        }
        let store = RunStore::new(root);
        for run_id in store.list_ids()? {
            if Self::is_active(&mut inner, root, &run_id) {
                continue;
            }
            let Ok(meta) = store.load_meta(&run_id) else {
                continue;
            };
            let Ok(state) = store.load_state(&run_id, &meta) else {
                continue;
            };
            match state.status {
                RunStatus::Running | RunStatus::Stopping => {
                    let mut editor = self.editor(root, &run_id)?;
                    // Detached commands may still run (or have left their exit
                    // record): a driver reconnects to them, provided this
                    // machine confirmed the run's commands (spec 7.2).
                    let reconnectable = editor.state().nodes.values().any(|n| {
                        n.status == NodeStatus::Running
                            && n.process.as_ref().is_some_and(|p| {
                                p.exit_file.as_ref().is_some_and(|exit| {
                                    DetachedProcess::reconnect(
                                        p.pid,
                                        &p.started_at,
                                        Path::new(exit),
                                    )
                                    .is_some()
                                })
                            })
                    });
                    if reconnectable && self.require_confirmed(root, editor.meta()).is_ok() {
                        drop(editor);
                        self.spawn_driver(&mut inner, root, &run_id, None)?;
                        continue;
                    }
                    let running: Vec<String> = editor
                        .state()
                        .nodes
                        .iter()
                        .filter(|(_, n)| n.status == NodeStatus::Running)
                        .map(|(k, _)| k.clone())
                        .collect();
                    for key in running {
                        editor.set_node(
                            &key,
                            NodeStatus::Interrupted,
                            Some(Reason::new(FLOW_APP_EXITED)),
                            None,
                        );
                    }
                    editor.set_run(RunStatus::Interrupted, Some(Reason::new(FLOW_APP_EXITED)));
                    editor.finish();
                }
                // A pending run is never started automatically: run data may come from a
                // cloned repository and must not execute without this machine's confirmation.
                // Approvals survive restarts; a driver starts when one is answered.
                _ => {}
            }
        }
        Ok(())
    }

    // -------------------------------------------------- confirmation

    fn load_confirmations(&self) -> ConfirmationFile {
        std::fs::read(&self.confirmations)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(ConfirmationFile {
                version: 1,
                entries: Vec::new(),
            })
    }

    fn is_confirmed(&self, root: &Path, rel: &str, sha256: &str) -> bool {
        let key = Self::key(root).to_string_lossy().into_owned();
        self.load_confirmations()
            .entries
            .iter()
            .any(|c| c.project_key == key && c.flow_path == rel && c.sha256 == sha256)
    }

    /// Every driver that is not started by [`Self::start`] runs a stored
    /// snapshot: it needs this machine's confirmation of that exact content.
    fn require_confirmed(&self, root: &Path, meta: &RunMeta) -> Result<()> {
        let mut files = vec![(meta.flow_path.as_str(), &meta.flow)];
        files.extend(meta.subflows.iter().map(|(p, f)| (p.as_str(), f)));
        let has_commands = !command_summaries(&files).is_empty();
        if has_commands && !self.is_confirmed(root, &meta.flow_path, &meta.flow_sha256) {
            return Err(EngineError::new(
                FLOW_COMMANDS_UNCONFIRMED,
                "the commands of this run's flow were not confirmed on this machine",
            ));
        }
        Ok(())
    }

    /// The commands of a flow file as written, for the confirmation dialog.
    pub fn review_commands(&self, root: &Path, rel: &str) -> Result<CommandReview> {
        let bundle = load_bundle(root, rel)?;
        let sha256 = bundle.hash();
        let commands = command_summaries(&bundle.files());
        let confirmed = commands.is_empty() || self.is_confirmed(root, &bundle.display, &sha256);
        Ok(CommandReview {
            path: bundle.display,
            sha256,
            confirmed,
            commands,
        })
    }

    /// Records that the user reviewed the commands of exactly this content.
    pub fn confirm_commands(&self, root: &Path, rel: &str, sha256: &str) -> Result<()> {
        let bundle = load_bundle(root, rel)?;
        let display = bundle.display.clone();
        if bundle.hash() != sha256 {
            return Err(EngineError::new(
                FLOW_FILE_CHANGED,
                "the file changed since it was reviewed",
            ));
        }
        let key = Self::key(root).to_string_lossy().into_owned();
        let mut file = self.load_confirmations();
        file.version = 1;
        file.entries
            .retain(|c| !(c.project_key == key && c.flow_path == display));
        file.entries.push(Confirmation {
            project_key: key,
            flow_path: display,
            sha256: sha256.to_string(),
            confirmed_at: fsutil::now(),
        });
        let json = serde_json::to_vec_pretty(&file)
            .map_err(|e| EngineError::new(FLOW_STORE_FAILED, e.to_string()))?;
        if let Some(parent) = self.confirmations.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| EngineError::new(FLOW_STORE_FAILED, e.to_string()))?;
        }
        fsutil::atomic_write(&self.confirmations, &json)
            .map_err(|e| EngineError::new(FLOW_STORE_FAILED, e.to_string()))
    }

    // ------------------------------------------------------- runs

    /// Starts a run of the flow file whose reviewed content hash is `sha256`.
    pub fn start(
        &self,
        root: &Path,
        rel: &str,
        params: &BTreeMap<String, Value>,
        sha256: &str,
    ) -> Result<RunSummary> {
        self.attach(root)?;
        let bundle = load_bundle(root, rel)?;
        let actual = bundle.hash();
        if actual != sha256 {
            return Err(EngineError::new(
                FLOW_FILE_CHANGED,
                "the file changed since it was reviewed",
            ));
        }
        let problems = check_runnable(&bundle.files());
        if !problems.is_empty() {
            return Err(EngineError::new(
                FLOW_RUN_NOT_RUNNABLE,
                "the flow uses features this version cannot run",
            )
            .with_details(problems));
        }
        let has_commands = !command_summaries(&bundle.files()).is_empty();
        let display = bundle.display.clone();
        if has_commands && !self.is_confirmed(root, &display, &actual) {
            return Err(EngineError::new(
                FLOW_COMMANDS_UNCONFIRMED,
                "review and confirm the commands first",
            ));
        }
        let Bundle {
            flow, others, refs, ..
        } = bundle;
        let params = prepare_params(&flow, params).map_err(|details| {
            EngineError::new(FLOW_PARAMS_INVALID, "invalid parameters").with_details(details)
        })?;
        let run_id = fsutil::new_id();
        let meta = RunMeta {
            schema_version: RUN_SCHEMA_VERSION,
            run_id: run_id.clone(),
            flow_path: display,
            flow_sha256: actual,
            flow,
            params,
            created_at: fsutil::now(),
            started_by: "user".into(),
            subflows: others.into_iter().map(|(p, (_, f))| (p, f)).collect(),
            refs,
        };
        let store = RunStore::new(root);
        store.create(&meta)?;
        let mut inner = self.lock();
        self.spawn_driver(&mut inner, root, &run_id, None)?;
        drop(inner);
        self.summary(root, &run_id)
    }

    fn summary(&self, root: &Path, run_id: &str) -> Result<RunSummary> {
        let store = RunStore::new(root);
        let meta = store.load_meta(run_id)?;
        let state = store.load_state(run_id, &meta)?;
        Ok(RunSummary {
            run_id: run_id.to_string(),
            flow_path: meta.flow_path.clone(),
            flow_name: meta.flow.name.clone(),
            status: state.status,
            reason: state.reason.clone(),
            created_at: meta.created_at.clone(),
            updated_at: state.updated_at.clone(),
            cost_usd: state.cost.total(),
            pending_approvals: state.approvals.len(),
        })
    }

    /// All runs of the project, newest first.
    pub fn list(&self, root: &Path) -> Result<Vec<RunSummary>> {
        self.attach(root)?;
        let mut out: Vec<RunSummary> = RunStore::new(root)
            .list_ids()?
            .iter()
            .filter_map(|id| self.summary(root, id).ok())
            .collect();
        out.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then(b.run_id.cmp(&a.run_id))
        });
        Ok(out)
    }

    pub fn get(&self, root: &Path, run_id: &str) -> Result<RunSnapshot> {
        self.attach(root)?;
        let store = RunStore::new(root);
        let meta = store.load_meta(run_id)?;
        let state = store.load_state(run_id, &meta)?;
        let active = Self::is_active(&mut self.lock(), root, run_id);
        Ok(RunSnapshot {
            meta,
            state,
            active,
        })
    }

    fn snapshot_locked(
        &self,
        inner: &mut Inner,
        root: &Path,
        run_id: &str,
    ) -> Result<(RunState, bool)> {
        let store = RunStore::new(root);
        let meta = store.load_meta(run_id)?;
        let state = store.load_state(run_id, &meta)?;
        Ok((state, Self::is_active(inner, root, run_id)))
    }

    fn send(inner: &Inner, root: &Path, run_id: &str, control: Control) {
        if let Some(slot) = inner.slots.get(&(Self::key(root), run_id.to_string())) {
            let _ = slot.tx.send(control);
        }
    }

    /// Cooperative stop: creates the STOP file; the run pauses at the next boundary.
    pub fn stop(&self, root: &Path, run_id: &str) -> Result<()> {
        self.attach(root)?;
        let mut inner = self.lock();
        let (state, active) = self.snapshot_locked(&mut inner, root, run_id)?;
        if !state.status.is_active() {
            return Err(EngineError::new(
                FLOW_RUN_INVALID_STATE,
                format!("{:?}", state.status),
            ));
        }
        let stop_file = RunStore::new(root).stop_file(run_id)?;
        std::fs::write(&stop_file, b"")
            .map_err(|e| EngineError::new(FLOW_STORE_FAILED, e.to_string()))?;
        if active {
            Self::send(&inner, root, run_id, Control::Stop);
        } else {
            let mut editor = self.editor(root, run_id)?;
            editor.set_run(
                RunStatus::Stopping,
                Some(Reason::new(crate::flow::run::driver::FLOW_STOP_REQUESTED)),
            );
            editor.set_run(
                RunStatus::Paused,
                Some(Reason::new(crate::flow::run::driver::FLOW_STOP_REQUESTED)),
            );
            editor.finish();
        }
        Ok(())
    }

    /// Cancels the run (kills its running process tree).
    pub fn cancel(&self, root: &Path, run_id: &str) -> Result<()> {
        self.attach(root)?;
        let mut inner = self.lock();
        let (state, active) = self.snapshot_locked(&mut inner, root, run_id)?;
        if state.status.is_finished() {
            return Err(EngineError::new(
                FLOW_RUN_INVALID_STATE,
                format!("{:?}", state.status),
            ));
        }
        if active {
            Self::send(&inner, root, run_id, Control::Cancel);
        } else {
            let mut editor = self.editor(root, run_id)?;
            editor.set_run(
                RunStatus::Cancelled,
                Some(Reason::new(crate::flow::run::driver::FLOW_RUN_CANCELLED)),
            );
            editor.finish();
        }
        Ok(())
    }

    /// Nodes that must be re-run or marked succeeded before the run can continue.
    fn nodes_needing_action(editor: &Editor) -> Vec<Reason> {
        editor
            .state()
            .nodes
            .iter()
            // Only current instances in live scopes count (older passes are history).
            .filter(|(key, _)| editor.is_live_instance(key))
            .filter(|(key, n)| match n.status {
                NodeStatus::Interrupted | NodeStatus::Cancelled => true,
                NodeStatus::Failed => !editor.has_failure_edge(key),
                _ => false,
            })
            .map(|(key, n)| {
                Reason::new(FLOW_NODE_NEEDS_ACTION)
                    .with("node", key.clone())
                    .with("status", serde_json::to_value(n.status).unwrap_or_default())
            })
            .collect()
    }

    /// Continues a paused, interrupted or failed run (or a waiting run
    /// without a driver after a restart).
    pub fn resume(&self, root: &Path, run_id: &str) -> Result<()> {
        self.attach(root)?;
        let mut inner = self.lock();
        self.resume_locked(&mut inner, root, run_id)
    }

    fn resume_locked(&self, inner: &mut Inner, root: &Path, run_id: &str) -> Result<()> {
        if Self::is_active(inner, root, run_id) {
            return Err(EngineError::new(FLOW_RUN_BUSY, run_id));
        }
        let editor = self.editor(root, run_id)?;
        let status = editor.state().status;
        if !matches!(
            status,
            RunStatus::Pending
                | RunStatus::Paused
                | RunStatus::Interrupted
                | RunStatus::Failed
                | RunStatus::AwaitingApproval
        ) {
            return Err(EngineError::new(
                FLOW_RUN_INVALID_STATE,
                format!("{status:?}"),
            ));
        }
        let blocked = Self::nodes_needing_action(&editor);
        if !blocked.is_empty() {
            return Err(EngineError::new(
                FLOW_NODE_NEEDS_ACTION,
                "re-run or mark these nodes first",
            )
            .with_details(blocked));
        }
        self.require_confirmed(root, editor.meta())?;
        drop(editor);
        let stop_file = RunStore::new(root).stop_file(run_id)?;
        let _ = std::fs::remove_file(stop_file);
        self.spawn_driver(inner, root, run_id, Some(Reason::new(FLOW_RESUMED)))
    }

    /// Answers a pending approval (node, or the budget when `node_key` is `None`).
    pub fn approve(
        &self,
        root: &Path,
        run_id: &str,
        node_key: Option<&str>,
        choice: &str,
        comment: Option<String>,
    ) -> Result<()> {
        self.attach(root)?;
        let mut inner = self.lock();
        let (state, active) = self.snapshot_locked(&mut inner, root, run_id)?;
        let request = state
            .approvals
            .iter()
            .find(|a| a.node_key.as_deref() == node_key)
            .ok_or_else(|| EngineError::new(FLOW_APPROVAL_INVALID, "no such pending approval"))?;
        if !request.options.iter().any(|o| o == choice) {
            return Err(EngineError::new(
                FLOW_APPROVAL_INVALID,
                format!("unknown option {choice:?}"),
            ));
        }
        let control = Control::Approve {
            node_key: node_key.map(String::from),
            choice: choice.to_string(),
            comment: comment.clone(),
            by: "user".into(),
        };
        if active {
            Self::send(&inner, root, run_id, control);
            return Ok(());
        }
        if state.status == RunStatus::AwaitingApproval {
            // After a restart: a driver picks the waiting run up again.
            self.require_confirmed(root, &RunStore::new(root).load_meta(run_id)?)?;
            self.spawn_driver(&mut inner, root, run_id, None)?;
            Self::send(&inner, root, run_id, control);
            return Ok(());
        }
        let mut editor = self.editor(root, run_id)?;
        editor.approve(node_key, choice, comment, "user");
        editor.finish();
        Ok(())
    }

    fn node_op(&self, root: &Path, run_id: &str, key: &str, to: NodeStatus) -> Result<()> {
        self.attach(root)?;
        let mut inner = self.lock();
        if Self::is_active(&mut inner, root, run_id) {
            return Err(EngineError::new(FLOW_RUN_BUSY, run_id));
        }
        let mut editor = self.editor(root, run_id)?;
        let run_status = editor.state().status;
        if !matches!(
            run_status,
            RunStatus::Paused | RunStatus::Interrupted | RunStatus::Failed
        ) {
            return Err(EngineError::new(
                FLOW_RUN_INVALID_STATE,
                format!("{run_status:?}"),
            ));
        }
        self.require_confirmed(root, editor.meta())?;
        let node = editor
            .state()
            .nodes
            .get(key)
            .cloned()
            .ok_or_else(|| EngineError::new(FLOW_NODE_NOT_FOUND, key))?;
        // Older passes and nodes of finished scopes cannot be changed.
        if !editor.is_live_instance(key) {
            return Err(EngineError::new(
                FLOW_NODE_INVALID_STATE,
                "not a live instance",
            ));
        }
        let allowed = match (node.status, to) {
            (NodeStatus::Interrupted | NodeStatus::Cancelled, NodeStatus::Ready) => true,
            // Only failures that stopped the flow; handled ones already moved on.
            (NodeStatus::Failed, NodeStatus::Ready | NodeStatus::Succeeded) => {
                !editor.has_failure_edge(key)
            }
            _ => false,
        };
        if !allowed {
            return Err(EngineError::new(
                FLOW_NODE_INVALID_STATE,
                format!("{:?}", node.status),
            ));
        }
        if to == NodeStatus::Succeeded {
            editor.mark_succeeded(key);
        } else if editor.is_composite(key) {
            // A loop or sub-flow starts over as a fresh instance.
            editor.new_pass(key);
        } else {
            editor.set_node(key, to, None, None);
        }
        editor.finish();
        // Continue right away when nothing else needs attention.
        // Other nodes may still need attention; the run then stays as it is.
        let _ = self.resume_locked(&mut inner, root, run_id);
        Ok(())
    }

    /// "Re-run from this node": an interrupted, cancelled or failed node becomes ready.
    pub fn rerun_node(&self, root: &Path, run_id: &str, key: &str) -> Result<()> {
        self.node_op(root, run_id, key, NodeStatus::Ready)
    }

    /// Treats a failed node as succeeded (its outputs stay empty).
    pub fn mark_succeeded(&self, root: &Path, run_id: &str, key: &str) -> Result<()> {
        self.node_op(root, run_id, key, NodeStatus::Succeeded)
    }

    /// Deletes a run that is not active.
    pub fn delete(&self, root: &Path, run_id: &str) -> Result<()> {
        self.attach(root)?;
        let mut inner = self.lock();
        let (state, active) = self.snapshot_locked(&mut inner, root, run_id)?;
        if active || state.status.is_active() || state.status == RunStatus::Pending {
            return Err(EngineError::new(FLOW_RUN_BUSY, run_id));
        }
        RunStore::new(root).delete(run_id)?;
        Ok(())
    }

    /// Tail of a node attempt's `stdout.log` / `stderr.log`.
    pub fn log(
        &self,
        root: &Path,
        run_id: &str,
        key: &str,
        attempt: u32,
        stream: &str,
        max_bytes: u64,
    ) -> Result<String> {
        let file = match stream {
            "stdout" => "stdout.log",
            "stderr" => "stderr.log",
            _ => return Err(EngineError::new(FLOW_LOG_INVALID, stream)),
        };
        let store = RunStore::new(root);
        let meta = store.load_meta(run_id)?;
        let state = store.load_state(run_id, &meta)?;
        if !state.nodes.contains_key(key) {
            return Err(EngineError::new(FLOW_NODE_NOT_FOUND, key));
        }
        let path = store.node_attempt_dir(run_id, key, attempt)?.join(file);
        tail_file(&path, max_bytes.min(MAX_LOG_BYTES))
            .map_err(|e| EngineError::new(FLOW_STORE_FAILED, e.to_string()))
    }

    /// App exit: every driver kills its process and records `interrupted`.
    pub fn shutdown(&self, wait: Duration) {
        let mut slots: Vec<Slot> = {
            let mut inner = self.lock();
            inner.slots.drain().map(|(_, slot)| slot).collect()
        };
        for slot in &slots {
            let _ = slot.tx.send(Control::Shutdown);
        }
        let deadline = Instant::now() + wait;
        for slot in &mut slots {
            while !slot.done.load(Ordering::SeqCst) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            if slot.done.load(Ordering::SeqCst) {
                if let Some(join) = slot.join.take() {
                    let _ = join.join();
                }
            }
        }
    }

    /// Waits until the run has no active driver (tests).
    #[cfg(test)]
    pub fn wait_idle(&self, root: &Path, run_id: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if !Self::is_active(&mut self.lock(), root, run_id) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

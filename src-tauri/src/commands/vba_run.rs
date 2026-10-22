//! VBA run & verify core: request/result types, per-workbook run state,
//! run-copy folders and parsing of the PowerShell runner / shim protocol.
//! The Excel orchestration (approval relay, run-copy build, PowerShell runner
//! with dialog watch, result assembly) and the Tauri commands follow.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::vba::{
    add_module, apply_changes, macros_dir_for, plan_push, project_sources, require_macro_workbook, vba_error,
    canonical_workbook_key, vba_project_bin_from_zip, PushWarning,
};
use super::vba_lint::{has_procedure, resolve_macro, scan_side_effects, side_effects_fingerprint, SideEffectHit};
use super::vba_shim::{
    render_shim, vba_arg_literal, MacroCall, MsgBoxResponse, ShimSpec, FIELD_SEP, RECORD_SEP, SHIM_MODULE_NAME,
};
use super::vba_streams::ModuleKind;
use super::xlsx_read::{cell_error_label, CellBlock, RangeSpec};

pub use super::vba_runner::{spawn_and_watch, RunnerOutcome};

// ---- constants ----

/// Runs allowed per workbook between two user instructions.
pub const VBA_RUN_BUDGET: u32 = 6;
/// Number of run-copy folders kept per workbook.
pub const RUN_COPY_KEEP: usize = 5;
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 300_000;
pub const APPROVAL_TIMEOUT_MS: u64 = 120_000;
pub const WATCH_INTERVAL_MS: u64 = 250;

// ---- request types ----

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunSource {
    /// Import the modules from the macros dir into the run copy.
    #[default]
    MacrosDir,
    /// Run the code already stored in the workbook.
    Workbook,
}

#[derive(Deserialize, Debug, Clone)]
pub struct MacroSpec {
    pub name: String,
    #[serde(default)]
    pub args: Vec<serde_json::Value>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct RunRequest {
    pub xlsm_path: String,
    #[serde(default)]
    pub source: RunSource,
    #[serde(default)]
    pub macros: Vec<MacroSpec>,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub msgbox_responses: Vec<MsgBoxResponse>,
    #[serde(default)]
    pub read: Vec<RangeSpec>,
    #[serde(default)]
    pub allow_side_effects: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

impl RunRequest {
    /// Requested timeout, defaulted and clamped to 1..=MAX_TIMEOUT_MS.
    pub fn effective_timeout_ms(&self) -> u64 {
        self.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, MAX_TIMEOUT_MS)
    }
}

// ---- result types ----

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DialogRecord {
    Msgbox { prompt: String, title: String, response: String },
    Inputbox { prompt: String, title: String, response: String, exhausted: bool },
    Window { class: String, title: String, text: String, clicked: Option<String> },
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MacroStatus {
    Ok,
    Error,
    DialogInterrupted,
    Timeout,
    NotRun,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ErrorFrom {
    /// Caught by the shim's error handler.
    Handler,
    /// Read from a VBE run-time error dialog.
    Dialog,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct MacroError {
    pub number: i64,
    pub source: Option<String>,
    pub description: String,
    pub from: ErrorFrom,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacroResult {
    #[serde(rename = "macro")]
    pub macro_name: String,
    pub status: MacroStatus,
    pub duration_ms: Option<u64>,
    pub error: Option<MacroError>,
    pub dialogs: Vec<DialogRecord>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct BudgetInfo {
    pub used: u32,
    pub limit: u32,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub ok: bool,
    pub run_copy_path: String,
    pub source: RunSource,
    pub warnings: Vec<PushWarning>,
    pub open_dialogs: Vec<DialogRecord>,
    pub results: Vec<MacroResult>,
    pub cells: Vec<CellBlock>,
    pub run_budget: BudgetInfo,
    /// Agent-facing English notes (timeout, leaked Excel process, ...).
    pub notes: Vec<String>,
}

// ---- state (managed by Tauri as VbaRunShared) ----

/// Per-workbook run state, keyed by `vba::canonical_workbook_key`.
#[derive(Default)]
pub struct VbaRunState {
    budget: HashMap<String, u32>,
    /// (workbook key, side-effect fingerprint) pairs the user approved.
    approvals: HashSet<(String, String)>,
    in_progress: HashSet<String>,
    /// Approval requests waiting for the user's answer, by request id.
    pub pending_approvals: HashMap<String, std::sync::mpsc::Sender<bool>>,
}

pub type VbaRunShared = Arc<Mutex<VbaRunState>>;

pub fn new_vba_run_state() -> VbaRunShared {
    Arc::new(Mutex::new(VbaRunState::default()))
}

impl VbaRunState {
    fn used(&self, key: &str) -> u32 {
        self.budget.get(key).copied().unwrap_or(0)
    }

    pub fn check_budget(&self, key: &str) -> Result<(), String> {
        if self.used(key) >= VBA_RUN_BUDGET {
            return Err(vba_error(
                "run_budget_exhausted",
                format!(
                    "The run budget for this workbook ({} runs) is exhausted. Stop running macros and report the current results to the user; the budget resets when the user sends the next instruction.",
                    VBA_RUN_BUDGET
                ),
            ));
        }
        Ok(())
    }

    /// Counts one run against the budget. Call only for runs that actually started.
    pub fn consume(&mut self, key: &str) -> BudgetInfo {
        let used = self.budget.entry(key.to_string()).or_insert(0);
        *used += 1;
        BudgetInfo { used: *used, limit: VBA_RUN_BUDGET }
    }

    /// Clears both the run budget and the side-effect approvals of a workbook.
    pub fn reset(&mut self, key: &str) {
        self.budget.remove(key);
        self.approvals.retain(|(k, _)| k != key);
    }

    pub fn is_approved(&self, key: &str, fingerprint: &str) -> bool {
        self.approvals.contains(&(key.to_string(), fingerprint.to_string()))
    }

    pub fn approve(&mut self, key: &str, fingerprint: &str) {
        self.approvals.insert((key.to_string(), fingerprint.to_string()));
    }

    pub fn begin(&mut self, key: &str) -> Result<(), String> {
        if !self.in_progress.insert(key.to_string()) {
            return Err(vba_error(
                "run_in_progress",
                "A macro run for this workbook is already in progress. Wait for it to finish before starting another.",
            ));
        }
        Ok(())
    }

    pub fn end(&mut self, key: &str) {
        self.in_progress.remove(key);
    }
}

// ---- run copies ----

/// `<stem>_assets/runs` next to the workbook (sibling of the macros dir).
pub fn runs_dir_for(xlsm_path: &Path) -> Result<PathBuf, String> {
    let macros_dir = macros_dir_for(xlsm_path)?;
    let assets_dir = macros_dir
        .parent()
        .ok_or_else(|| vba_error("invalid_workbook", "Cannot determine assets directory"))?;
    Ok(assets_dir.join("runs"))
}

/// `<yyyymmdd-hhmmss>_<proc>` where proc is the part after the last '.' of the
/// first macro name sanitized to `[A-Za-z0-9_]`, or `read` when no macro runs.
pub fn run_dir_name(now: chrono::NaiveDateTime, first_macro: Option<&str>) -> String {
    let suffix = match first_macro {
        Some(name) => name
            .rsplit('.')
            .next()
            .unwrap_or("")
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
            .collect::<String>(),
        None => "read".to_string(),
    };
    format!("{}_{}", now.format("%Y%m%d-%H%M%S"), suffix)
}

/// Creates `runs_dir/base_name`, or `base_name-2`, `-3`, ... when taken.
pub fn new_run_dir(runs_dir: &Path, base_name: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(runs_dir).map_err(|e| vba_error("io", format!("Cannot create {}: {}", runs_dir.display(), e)))?;
    let mut n = 1u32;
    loop {
        let name = if n == 1 { base_name.to_string() } else { format!("{}-{}", base_name, n) };
        let dir = runs_dir.join(name);
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(vba_error("io", format!("Cannot create {}: {}", dir.display(), e))),
        }
    }
}

/// Removes all but the newest `keep` run folders (by name). Best-effort: a
/// folder that cannot be removed (e.g. a run copy open in Excel) is skipped.
/// Returns the removed paths and one agent-facing note per failure.
pub fn prune_run_dirs(runs_dir: &Path, keep: usize) -> (Vec<PathBuf>, Vec<String>) {
    let entries = match fs::read_dir(runs_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (vec![], vec![]),
        Err(e) => return (vec![], vec![format!("Could not list old run copies in {}: {}", runs_dir.display(), e)]),
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    let excess = dirs.len().saturating_sub(keep);
    let mut removed = Vec::new();
    let mut failed = Vec::new();
    for dir in dirs.into_iter().take(excess) {
        match fs::remove_dir_all(&dir) {
            Ok(()) => removed.push(dir),
            Err(e) => failed.push(format!("Could not remove old run copy {}: {}", dir.display(), e)),
        }
    }
    (removed, failed)
}

/// Prunes old run folders (best-effort), then writes `bytes` as `file_name`
/// into a new run folder named after `dir_name`. Returns the copy path and
/// the pruning notes.
pub(crate) fn write_run_copy(
    runs_dir: &Path,
    dir_name: &str,
    file_name: &std::ffi::OsStr,
    bytes: &[u8],
) -> Result<(PathBuf, Vec<String>), String> {
    // Prune first so the folder created below can never be the one removed.
    let (_, notes) = prune_run_dirs(runs_dir, RUN_COPY_KEEP - 1);
    let run_dir = new_run_dir(runs_dir, dir_name)?;
    let copy_path = run_dir.join(file_name);
    fs::write(&copy_path, bytes).map_err(|e| vba_error("io", format!("Cannot write {}: {}", copy_path.display(), e)))?;
    Ok((copy_path, notes))
}

// ---- runner stdout protocol ----

#[derive(Debug, Clone, PartialEq)]
pub enum RunnerEvent {
    Hwnd(isize),
    OpenLog(String),
    Result { index: usize, payload: String },
    RunExc { index: usize, message: String },
    Cells { index: usize, address: String, json: serde_json::Value },
}

fn decode_b64(s: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(s).ok()?;
    String::from_utf8(bytes).ok()
}

/// Parses one stdout line of the PowerShell runner; non-protocol lines give None.
pub fn parse_runner_line(line: &str) -> Option<RunnerEvent> {
    let line = line.trim_end_matches(['\r', '\n']);
    let (tag, rest) = line.split_once(' ')?;
    match tag {
        "HWND" => rest.trim().parse().ok().map(RunnerEvent::Hwnd),
        "OPENLOG" => decode_b64(rest.trim()).map(RunnerEvent::OpenLog),
        "RESULT" | "RUNEXC" => {
            let (index, b64) = rest.split_once(' ')?;
            let index = index.parse().ok()?;
            let text = decode_b64(b64.trim())?;
            Some(if tag == "RESULT" {
                RunnerEvent::Result { index, payload: text }
            } else {
                RunnerEvent::RunExc { index, message: text }
            })
        }
        "CELLS" => {
            let mut parts = rest.splitn(3, ' ');
            let index = parts.next()?.parse().ok()?;
            let address = parts.next()?.to_string();
            let json = serde_json::from_str(&decode_b64(parts.next()?.trim())?).ok()?;
            Some(RunnerEvent::Cells { index, address, json })
        }
        _ => None,
    }
}

/// Parses the shim's dialog log: records split by RECORD_SEP, fields by FIELD_SEP.
pub fn parse_dialog_log(log: &str) -> Vec<DialogRecord> {
    log.split(RECORD_SEP)
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let f: Vec<&str> = record.split(FIELD_SEP).collect();
            let field = |i: usize| f.get(i).copied().unwrap_or("").to_string();
            match f[0] {
                "msgbox" => Some(DialogRecord::Msgbox { prompt: field(1), title: field(2), response: field(3) }),
                "inputbox" => Some(DialogRecord::Inputbox {
                    prompt: field(1),
                    title: field(2),
                    response: field(3),
                    exhausted: field(4) == "exhausted",
                }),
                _ => None,
            }
        })
        .collect()
}

pub enum ShimOutcome {
    Ok { duration_ms: u64, dialogs: Vec<DialogRecord> },
    Error { error: MacroError, dialogs: Vec<DialogRecord> },
    /// Nothing returned (the macro never reached the shim's exit).
    Empty,
}

/// Parses the shim wrapper's return string: `ok|ms|log` or `error|number|source|description|log`.
/// The dialog log itself contains FIELD_SEP, so the leading fields are split off with splitn.
pub fn parse_shim_payload(payload: &str) -> ShimOutcome {
    let (kind, rest) = payload.split_once(FIELD_SEP).unwrap_or((payload, ""));
    match kind {
        "ok" => {
            let mut f = rest.splitn(2, FIELD_SEP);
            let duration_ms = f.next().unwrap_or("").parse().unwrap_or(0);
            ShimOutcome::Ok { duration_ms, dialogs: parse_dialog_log(f.next().unwrap_or("")) }
        }
        "error" => {
            let mut f = rest.splitn(4, FIELD_SEP);
            let number = f.next().unwrap_or("").parse().unwrap_or(0);
            let source = f.next().filter(|s| !s.is_empty()).map(str::to_string);
            let description = f.next().unwrap_or("").to_string();
            let dialogs = parse_dialog_log(f.next().unwrap_or(""));
            ShimOutcome::Error { error: MacroError { number, source, description, from: ErrorFrom::Handler }, dialogs }
        }
        _ => ShimOutcome::Empty,
    }
}

fn cell_value(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => match map.get("err").and_then(|e| e.as_i64()) {
            Some(code) => serde_json::Value::String(cell_error_label(code).unwrap_or("#ERR").to_string()),
            None => serde_json::Value::Null,
        },
        other => other.clone(),
    }
}

/// Converts the runner's CELLS payload into a CellBlock (scalar → 1x1, flat array → one row).
pub fn cells_from_json(sheet: &str, address: &str, v: &serde_json::Value) -> CellBlock {
    let values = match v {
        serde_json::Value::Array(items) if items.iter().all(|i| i.is_array()) && !items.is_empty() => items
            .iter()
            .map(|row| row.as_array().map(|r| r.iter().map(cell_value).collect()).unwrap_or_default())
            .collect(),
        serde_json::Value::Array(items) => vec![items.iter().map(cell_value).collect()],
        scalar => vec![vec![cell_value(scalar)]],
    };
    CellBlock { sheet: sheet.to_string(), range: address.to_string(), values }
}

/// Extracts (number, description) from a VBE run-time error dialog text.
pub fn parse_vbe_error_text(text: &str) -> Option<(i64, String)> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"(?s)(?:実行時エラー|Run-time error)\s*'(\d+)'\s*:?\s*(.+)").expect("valid regex")
    });
    let caps = re.captures(text)?;
    let number = caps[1].parse().ok()?;
    Some((number, caps[2].trim().to_string()))
}

// ---- orchestration helpers ----

fn lock_state(state: &VbaRunShared) -> Result<MutexGuard<'_, VbaRunState>, String> {
    state.lock().map_err(|_| vba_error("run_failed", "state lock poisoned"))
}

/// Marks a workbook as running for its lifetime; `end` runs on every exit path.
struct InProgressGuard<'a> {
    state: &'a VbaRunShared,
    key: String,
}

impl Drop for InProgressGuard<'_> {
    fn drop(&mut self) {
        // A poisoned lock still holds valid data; clearing the flag must not be skipped.
        let mut s = match self.state.lock() {
            Ok(s) => s,
            Err(poisoned) => poisoned.into_inner(),
        };
        s.end(&self.key);
    }
}

// ---- approval relay ----

/// Event asking the webview to show the side-effect approval dialog.
pub const APPROVAL_EVENT: &str = "vba-run-approval-request";

/// Asks the user to approve running code with side effects, unless the same
/// (workbook, fingerprint) pair was approved before. `emit` delivers the
/// request payload to the webview; the answer arrives through
/// `vba_run_approval_reply`. Waits at most `timeout`.
pub(crate) fn request_approval(
    state: &VbaRunShared,
    key: &str,
    xlsm_path: &str,
    macros: &[String],
    hits: &[SideEffectHit],
    emit: &dyn Fn(serde_json::Value) -> Result<(), String>,
    timeout: Duration,
) -> Result<(), String> {
    let fingerprint = side_effects_fingerprint(hits);
    if lock_state(state)?.is_approved(key, &fingerprint) {
        return Ok(());
    }
    let id = crate::http_bridge::generate_token();
    let (tx, rx) = mpsc::channel::<bool>();
    lock_state(state)?.pending_approvals.insert(id.clone(), tx);
    let remove_pending = || {
        if let Ok(mut s) = state.lock() {
            s.pending_approvals.remove(&id);
        }
    };
    let payload = serde_json::json!({ "id": id, "xlsmPath": xlsm_path, "macros": macros, "matches": hits });
    if let Err(e) = emit(payload) {
        remove_pending();
        return Err(vba_error("run_failed", format!("Could not ask the user for approval: {}", e)));
    }
    match rx.recv_timeout(timeout) {
        Ok(true) => {
            lock_state(state)?.approve(key, &fingerprint);
            Ok(())
        }
        Ok(false) => Err(vba_error(
            "approval_denied",
            "The user denied running this code with side effects. Do not retry; ask the user how to proceed.",
        )),
        Err(_) => {
            remove_pending();
            Err(vba_error(
                "approval_timeout",
                format!(
                    "The user did not answer the approval dialog within {} seconds. Do not retry; report the situation and stop.",
                    timeout.as_secs()
                ),
            ))
        }
    }
}

/// Delivers the user's answer to the waiting `request_approval`; unknown (or expired) ids are an error.
pub(crate) fn reply_approval(state: &VbaRunShared, id: &str, granted: bool) -> Result<(), String> {
    let tx = lock_state(state)?.pending_approvals.remove(id);
    match tx {
        Some(tx) => {
            let _ = tx.send(granted);
            Ok(())
        }
        None => Err(format!("unknown vba run approval id: {}", id)),
    }
}

// ---- run-copy build ----

/// What a run executes: the workbook bytes before the shim is added, push
/// lint warnings, the resolved macros and the side-effect lines of the code.
pub(crate) struct Prepared {
    pub base: Vec<u8>,
    pub warnings: Vec<PushWarning>,
    pub macros: Vec<MacroCall>,
    pub side_effects: Vec<SideEffectHit>,
}

/// Builds the code to run and performs every static check that needs no Excel.
/// Check order: source, shim conflict, macro_not_found, invalid_request, side effects.
pub(crate) fn prepare_run(req: &RunRequest, data: &[u8], macros_dir: &Path) -> Result<Prepared, String> {
    let (base, modules, warnings) = match req.source {
        RunSource::MacrosDir => {
            if !macros_dir.is_dir() {
                return Err(vba_error(
                    "macros_dir_not_found",
                    format!("Macros directory not found: {} (run vba_pull first)", macros_dir.display()),
                ));
            }
            let plan = plan_push(data, macros_dir)?;
            let base = if plan.changes.is_empty() { data.to_vec() } else { apply_changes(data, &plan.changes)? };
            (base, plan.after, plan.warnings)
        }
        RunSource::Workbook => {
            vba_project_bin_from_zip(data).map_err(|e| vba_error("no_vba_project", e))?;
            let modules = project_sources(data).map_err(|e| vba_error("run_failed", e))?;
            (data.to_vec(), modules, Vec::new())
        }
    };

    if modules.iter().any(|m| m.name.eq_ignore_ascii_case(SHIM_MODULE_NAME))
        || has_procedure(&modules, "MsgBox")
        || has_procedure(&modules, "InputBox")
    {
        return Err(vba_error(
            "shim_name_conflict",
            format!(
                "The project already has a '{}' module or a procedure named MsgBox / InputBox, which the run shim needs. Rename it and try again.",
                SHIM_MODULE_NAME
            ),
        ));
    }

    let mut macros = Vec::with_capacity(req.macros.len());
    for (i, m) in req.macros.iter().enumerate() {
        let (module, proc) = resolve_macro(&modules, &m.name)
            .map_err(|e| vba_error("macro_not_found", format!("macros[{}] '{}': {}", i, m.name, e)))?;
        macros.push(MacroCall { module, proc, args: m.args.clone() });
    }

    // render_shim silently renders unsupported arguments as Empty, so refuse them here.
    for (i, m) in req.macros.iter().enumerate() {
        for (j, arg) in m.args.iter().enumerate() {
            if vba_arg_literal(arg).is_err() {
                return Err(vba_error("invalid_request", format!("macros[{}].args[{}]: unsupported argument type", i, j)));
            }
        }
    }

    let side_effects = scan_side_effects(&modules);
    Ok(Prepared { base, warnings, macros, side_effects })
}

fn side_effects_message(hits: &[SideEffectHit]) -> String {
    let mut msg = String::from(
        "The code to run has lines that may affect things outside the workbook. Explain them to the user, then call again with allow_side_effects: true to ask the user for approval:",
    );
    for h in hits {
        msg.push_str(&format!("\n{}:{}: {}", h.module, h.line, h.text));
    }
    msg
}

// ---- result assembly ----

pub const NOTE_EXCEL_LEFT_RUNNING: &str = "No Excel window handle was received; an EXCEL.EXE process may still be running.";

/// Note for an Excel whose pid is known but which could not be ended.
fn excel_not_terminated_note(pid: u32) -> String {
    format!("Excel (pid {}) could not be terminated; it may still be running.", pid)
}

fn timeout_note(timeout_ms: u64) -> String {
    format!("Timed out after {} ms; the run copy was not saved.", timeout_ms)
}

/// Status and error of a macro whose wrapper returned nothing (or whose
/// Application.Run threw): a VBE run-time error dialog gives `error`.
fn interrupted(windows: &[DialogRecord]) -> (MacroStatus, Option<MacroError>) {
    let vbe = windows.iter().find_map(|w| match w {
        DialogRecord::Window { class, text, .. } if class == "#32770" => parse_vbe_error_text(text),
        _ => None,
    });
    match vbe {
        Some((number, description)) => {
            (MacroStatus::Error, Some(MacroError { number, source: None, description, from: ErrorFrom::Dialog }))
        }
        None => (MacroStatus::DialogInterrupted, None),
    }
}

/// Turns the runner's observations into the tool result. Pure.
pub fn assemble_result(
    req: &RunRequest,
    macro_names: &[String],
    outcome: &RunnerOutcome,
    run_copy_path: &str,
    warnings: Vec<PushWarning>,
    budget: BudgetInfo,
) -> RunResult {
    let windows_of = |phase: usize| -> Vec<DialogRecord> {
        outcome.windows.iter().filter(|(p, _)| *p == phase).map(|(_, r)| r.clone()).collect()
    };

    let mut open_dialogs = Vec::new();
    for ev in &outcome.events {
        if let RunnerEvent::OpenLog(log) = ev {
            open_dialogs.extend(parse_dialog_log(log));
        }
    }
    open_dialogs.extend(windows_of(0));

    let mut timeout_assigned = false;
    let mut results = Vec::with_capacity(macro_names.len());
    for (i0, name) in macro_names.iter().enumerate() {
        let i = i0 + 1;
        let windows = windows_of(i);
        let event = outcome.events.iter().find(|ev| match ev {
            RunnerEvent::Result { index, .. } | RunnerEvent::RunExc { index, .. } => *index == i,
            _ => false,
        });
        let (status, duration_ms, error, mut dialogs) = match event {
            Some(RunnerEvent::Result { payload, .. }) => match parse_shim_payload(payload) {
                ShimOutcome::Ok { duration_ms, dialogs } => (MacroStatus::Ok, Some(duration_ms), None, dialogs),
                ShimOutcome::Error { error, dialogs } => (MacroStatus::Error, None, Some(error), dialogs),
                ShimOutcome::Empty => {
                    let (status, error) = interrupted(&windows);
                    (status, None, error, Vec::new())
                }
            },
            Some(_) => {
                let (status, error) = interrupted(&windows);
                (status, None, error, Vec::new())
            }
            None if outcome.timed_out && !timeout_assigned => {
                timeout_assigned = true;
                (MacroStatus::Timeout, None, None, Vec::new())
            }
            None => (MacroStatus::NotRun, None, None, Vec::new()),
        };
        dialogs.extend(windows);
        results.push(MacroResult { macro_name: name.clone(), status, duration_ms, error, dialogs });
    }

    let cells = outcome
        .events
        .iter()
        .filter_map(|ev| match ev {
            RunnerEvent::Cells { index, address, json } => {
                let sheet = req.read.get(*index).map(|r| r.sheet.as_str()).unwrap_or("");
                Some(cells_from_json(sheet, address, json))
            }
            _ => None,
        })
        .collect();

    let mut notes = Vec::new();
    if outcome.timed_out {
        notes.push(timeout_note(req.effective_timeout_ms()));
    }
    if outcome.excel_left_running {
        notes.push(match outcome.excel_pid {
            Some(pid) => excel_not_terminated_note(pid),
            None => NOTE_EXCEL_LEFT_RUNNING.to_string(),
        });
    }

    RunResult {
        ok: !outcome.timed_out && results.iter().all(|r| r.status == MacroStatus::Ok),
        run_copy_path: run_copy_path.to_string(),
        source: req.source,
        warnings,
        open_dialogs,
        results,
        cells,
        run_budget: budget,
        notes,
    }
}

/// First non-empty stderr line, or a fallback.
fn first_stderr_line(stderr: &str) -> String {
    stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("unknown error").to_string()
}

// ---- run ----

/// Runs `req` on a fresh run copy of `resolved_path`; `emit` delivers approval requests.
pub(crate) fn run_vba_macros_with(
    state: &VbaRunShared,
    req: &RunRequest,
    resolved_path: &str,
    emit: &dyn Fn(serde_json::Value) -> Result<(), String>,
) -> Result<RunResult, String> {
    // Canonical so that no spelling of the path gets a budget of its own.
    let key = canonical_workbook_key(resolved_path);
    {
        let mut s = lock_state(state)?;
        s.check_budget(&key)?;
        s.begin(&key)?;
    }
    let _guard = InProgressGuard { state, key: key.clone() };

    let original = require_macro_workbook(resolved_path)?;
    let data = fs::read(original).map_err(|e| vba_error("run_failed", format!("Cannot read {}: {}", resolved_path, e)))?;
    let prepared = prepare_run(req, &data, &macros_dir_for(original)?)?;
    let macro_names: Vec<String> = prepared.macros.iter().map(|m| format!("{}.{}", m.module, m.proc)).collect();

    if !prepared.side_effects.is_empty() {
        if !req.allow_side_effects {
            return Err(vba_error("side_effects_detected", side_effects_message(&prepared.side_effects)));
        }
        request_approval(
            state,
            &key,
            resolved_path,
            &macro_names,
            &prepared.side_effects,
            emit,
            Duration::from_millis(APPROVAL_TIMEOUT_MS),
        )?;
    }

    let shim = render_shim(&ShimSpec {
        macros: prepared.macros.clone(),
        inputs: req.inputs.clone(),
        msgbox_responses: req.msgbox_responses.clone(),
    });
    let copy_bytes = add_module(&prepared.base, SHIM_MODULE_NAME, ModuleKind::Standard, &shim)?;

    let runs_dir = runs_dir_for(original)?;
    let first = req.macros.first().map(|m| m.name.as_str());
    let file_name = original
        .file_name()
        .ok_or_else(|| vba_error("invalid_workbook", "Invalid file name"))?;
    let (copy_path, prune_notes) = write_run_copy(
        &runs_dir,
        &run_dir_name(chrono::Local::now().naive_local(), first),
        file_name,
        &copy_bytes,
    )?;

    let outcome = spawn_and_watch(&copy_path, prepared.macros.len(), &req.read, req.effective_timeout_ms())?;
    if outcome.exit_code == Some(2) || outcome.stderr.contains("EXCEL_NOT_AVAILABLE") {
        return Err(vba_error("excel_not_available", first_stderr_line(&outcome.stderr)));
    }
    let any_result = outcome
        .events
        .iter()
        .any(|ev| matches!(ev, RunnerEvent::Result { .. } | RunnerEvent::RunExc { .. }));
    if outcome.exit_code == Some(1) && !any_result {
        return Err(vba_error("run_failed", first_stderr_line(&outcome.stderr)));
    }

    let budget = lock_state(state)?.consume(&key);
    let mut result = assemble_result(
        req,
        &macro_names,
        &outcome,
        &copy_path.to_string_lossy(),
        prepared.warnings,
        budget,
    );
    if outcome.exit_code == Some(1) {
        result.notes.push(format!("The runner failed after the macros ran: {}", first_stderr_line(&outcome.stderr)));
    }
    result.notes.extend(prune_notes);
    Ok(result)
}

/// Runs macros on a disposable copy of the workbook. Err is `vba_error` JSON.
pub fn run_vba_macros(app: &AppHandle, state: &VbaRunShared, req: &RunRequest, resolved_path: &str) -> Result<RunResult, String> {
    let emit = |payload: serde_json::Value| app.emit(APPROVAL_EVENT, payload).map_err(|e| e.to_string());
    run_vba_macros_with(state, req, resolved_path, &emit)
}

// ---- Tauri commands ----

/// Clears the run budget and side-effect approvals of a workbook (the user sent a new instruction).
#[tauri::command]
pub fn reset_vba_run_budget(state: tauri::State<VbaRunShared>, xlsm_path: String) -> Result<(), String> {
    reset_run_budget_for(state.inner(), &xlsm_path)
}

pub(crate) fn reset_run_budget_for(state: &VbaRunShared, xlsm_path: &str) -> Result<(), String> {
    lock_state(state)?.reset(&canonical_workbook_key(xlsm_path));
    Ok(())
}

/// The user's answer to a `vba-run-approval-request` event.
#[tauri::command]
pub fn vba_run_approval_reply(state: tauri::State<VbaRunShared>, id: String, granted: bool) -> Result<(), String> {
    reply_approval(state.inner(), &id, granted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;

    fn err_code(err: &str) -> String {
        serde_json::from_str::<serde_json::Value>(err).map(|v| v["error"].as_str().unwrap_or("").to_string()).unwrap_or_default()
    }

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
    }

    fn request(timeout_ms: Option<u64>) -> RunRequest {
        let mut v = json!({ "xlsm_path": "c:/w/book.xlsm" });
        if let Some(t) = timeout_ms {
            v["timeout_ms"] = json!(t);
        }
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn budget_counts_to_limit_and_resets() {
        let mut s = VbaRunState::default();
        let k = "c:/w/book.xlsm";
        for i in 1..=VBA_RUN_BUDGET {
            s.check_budget(k).unwrap();
            assert_eq!(s.consume(k), BudgetInfo { used: i, limit: VBA_RUN_BUDGET });
        }
        assert_eq!(err_code(&s.check_budget(k).unwrap_err()), "run_budget_exhausted");
        s.approve(k, "fp");
        s.reset(k);
        s.check_budget(k).unwrap();
        assert!(!s.is_approved(k, "fp"));
    }

    #[test]
    fn approvals_are_per_workbook_and_fingerprint() {
        let mut s = VbaRunState::default();
        s.approve("a", "fp1");
        assert!(s.is_approved("a", "fp1"));
        assert!(!s.is_approved("a", "fp2"));
        assert!(!s.is_approved("b", "fp1"));
        s.consume("b");
        s.reset("a");
        // Resetting one workbook leaves the other's budget alone.
        assert_eq!(s.consume("b"), BudgetInfo { used: 2, limit: VBA_RUN_BUDGET });
    }

    #[test]
    fn begin_twice_is_run_in_progress() {
        let mut s = VbaRunState::default();
        let k = "c:/w/book.xlsm";
        s.begin(k).unwrap();
        assert_eq!(err_code(&s.begin(k).unwrap_err()), "run_in_progress");
        s.begin("c:/w/other.xlsm").unwrap();
        s.end(k);
        s.begin(k).unwrap();
    }

    #[test]
    fn effective_timeout_defaults_and_clamps() {
        assert_eq!(request(None).effective_timeout_ms(), 120_000);
        assert_eq!(request(Some(900_000)).effective_timeout_ms(), 300_000);
        assert_eq!(request(Some(0)).effective_timeout_ms(), 1);
        assert_eq!(request(Some(5_000)).effective_timeout_ms(), 5_000);
    }

    #[test]
    fn run_request_defaults_and_macro_specs() {
        let r: RunRequest = serde_json::from_value(json!({
            "xlsm_path": "c:/w/book.xlsm",
            "source": "workbook",
            "macros": [{ "name": "Module1.Main", "args": [1, "x"] }, { "name": "Module1.Other" }],
            "msgbox_responses": ["yes"],
            "read": [{ "sheet": "S", "range": "A1:B2" }]
        }))
        .unwrap();
        assert_eq!(r.source, RunSource::Workbook);
        assert_eq!(r.macros[0].args, vec![json!(1), json!("x")]);
        assert!(r.macros[1].args.is_empty());
        assert!(r.inputs.is_empty());
        assert!(!r.allow_side_effects);
        assert_eq!(request(None).source, RunSource::MacrosDir);
        assert_eq!(serde_json::to_value(RunSource::MacrosDir).unwrap(), json!("macros_dir"));
    }

    #[test]
    fn runs_dir_is_sibling_of_macros_dir() {
        let p = Path::new("C:/w/book.xlsm");
        assert_eq!(runs_dir_for(p).unwrap(), Path::new("C:/w").join("book_assets").join("runs"));
    }

    #[test]
    fn run_dir_name_uses_proc_part_or_read() {
        let t = chrono::NaiveDate::from_ymd_opt(2026, 10, 21).unwrap().and_hms_opt(14, 30, 12).unwrap();
        assert_eq!(run_dir_name(t, Some("Module1.Main")), "20261021-143012_Main");
        assert_eq!(run_dir_name(t, None), "20261021-143012_read");
        assert_eq!(run_dir_name(t, Some("Module1.集計")), "20261021-143012___");
    }

    #[test]
    fn new_run_dir_appends_suffix_on_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let first = new_run_dir(tmp.path(), "20261021-143012_Main").unwrap();
        assert_eq!(first, tmp.path().join("20261021-143012_Main"));
        assert!(first.is_dir());
        let second = new_run_dir(tmp.path(), "20261021-143012_Main").unwrap();
        assert_eq!(second, tmp.path().join("20261021-143012_Main-2"));
        assert!(second.is_dir());
        let third = new_run_dir(tmp.path(), "20261021-143012_Main").unwrap();
        assert_eq!(third, tmp.path().join("20261021-143012_Main-3"));
    }

    #[test]
    fn prune_keeps_the_newest_five() {
        let tmp = tempfile::tempdir().unwrap();
        for i in (1..=7).rev() {
            std::fs::create_dir(tmp.path().join(format!("20260101-00000{}", i))).unwrap();
        }
        // Plain files are not run copies and are left alone.
        std::fs::write(tmp.path().join("00000000-note.txt"), "x").unwrap();
        let (removed, failed) = prune_run_dirs(tmp.path(), RUN_COPY_KEEP);
        assert_eq!(removed, vec![tmp.path().join("20260101-000001"), tmp.path().join("20260101-000002")]);
        assert!(failed.is_empty(), "{failed:?}");
        assert!(!tmp.path().join("20260101-000002").exists());
        assert!(tmp.path().join("20260101-000003").is_dir());
        assert!(tmp.path().join("00000000-note.txt").is_file());
        let (removed, failed) = prune_run_dirs(&tmp.path().join("missing"), 5);
        assert!(removed.is_empty() && failed.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_old_run_copy_does_not_stop_a_new_run() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let runs = tmp.path().join("runs");
        for i in 1..=6 {
            std::fs::create_dir_all(runs.join(format!("20260101-00000{}", i))).unwrap();
        }
        let locked_dir = runs.join("20260101-000001");
        let locked = locked_dir.join("Book1.xlsm");
        std::fs::write(&locked, b"old").unwrap();
        // Share mode 0: like a copy open in Excel, the file cannot be deleted.
        let _held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&locked).unwrap();

        let (copy, notes) =
            write_run_copy(&runs, "20260102-000000_Main", std::ffi::OsStr::new("Book1.xlsm"), b"new").unwrap();
        assert_eq!(copy, runs.join("20260102-000000_Main").join("Book1.xlsm"));
        assert_eq!(std::fs::read(&copy).unwrap(), b"new");
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(
            notes[0].starts_with(&format!("Could not remove old run copy {}: ", locked_dir.display())),
            "{}",
            notes[0]
        );
        // The other excess folder was still removed; the locked one stays.
        assert!(!runs.join("20260101-000002").exists());
        assert!(locked.exists());
        assert!(runs.join("20260101-000003").is_dir());
    }

    #[test]
    fn parses_runner_lines() {
        assert_eq!(parse_runner_line("HWND 1234"), Some(RunnerEvent::Hwnd(1234)));
        assert_eq!(
            parse_runner_line(&format!("RESULT 2 {}", b64("ok\u{1f}12\u{1f}"))),
            Some(RunnerEvent::Result { index: 2, payload: "ok\u{1f}12\u{1f}".into() })
        );
        assert!(matches!(
            parse_runner_line(&format!("CELLS 0 A1:B1 {}", b64("[[1,\"a\"]]"))),
            Some(RunnerEvent::Cells { index: 0, .. })
        ));
        assert_eq!(parse_runner_line("noise"), None);
    }

    #[test]
    fn parses_other_runner_lines() {
        assert_eq!(parse_runner_line(&format!("OPENLOG {}", b64("log"))), Some(RunnerEvent::OpenLog("log".into())));
        assert_eq!(parse_runner_line("OPENLOG "), Some(RunnerEvent::OpenLog(String::new())));
        assert_eq!(
            parse_runner_line(&format!("RUNEXC 1 {}", b64("Exception 0x800A03EC"))),
            Some(RunnerEvent::RunExc { index: 1, message: "Exception 0x800A03EC".into() })
        );
        assert_eq!(
            parse_runner_line(&format!("CELLS 3 A1:B1 {}\r", b64("[[1,\"a\"]]"))),
            Some(RunnerEvent::Cells { index: 3, address: "A1:B1".into(), json: json!([[1, "a"]]) })
        );
        assert_eq!(parse_runner_line("RESULT x abc"), None);
        assert_eq!(parse_runner_line("RESULT 1 !!!not-base64"), None);
        assert_eq!(parse_runner_line("HWND abc"), None);
        assert_eq!(parse_runner_line(&format!("CELLS 0 A1 {}", b64("not json"))), None);
    }

    #[test]
    fn parses_shim_payloads() {
        let log = "msgbox\u{1f}完了\u{1f}\u{1f}1\u{1e}inputbox\u{1f}件数は?\u{1f}\u{1f}42\u{1f}exhausted";
        match parse_shim_payload(&format!("ok\u{1f}812\u{1f}{log}")) {
            ShimOutcome::Ok { duration_ms, dialogs } => {
                assert_eq!(duration_ms, 812);
                assert_eq!(
                    dialogs,
                    vec![
                        DialogRecord::Msgbox { prompt: "完了".into(), title: "".into(), response: "1".into() },
                        DialogRecord::Inputbox { prompt: "件数は?".into(), title: "".into(), response: "42".into(), exhausted: true }
                    ]
                );
            }
            _ => panic!(),
        }
        match parse_shim_payload("error\u{1f}9\u{1f}VBAProject\u{1f}インデックスが有効範囲にありません。\u{1f}") {
            ShimOutcome::Error { error, .. } => {
                assert_eq!(error.number, 9);
                assert_eq!(error.from, ErrorFrom::Handler);
                assert_eq!(error.source.as_deref(), Some("VBAProject"));
                assert_eq!(error.description, "インデックスが有効範囲にありません。");
            }
            _ => panic!(),
        }
        assert!(matches!(parse_shim_payload(""), ShimOutcome::Empty));
    }

    #[test]
    fn dialog_log_skips_unknown_kinds_and_empty_source_is_none() {
        let log = "\u{1e}bogus\u{1f}x\u{1e}inputbox\u{1f}p\u{1f}t\u{1f}r\u{1f}\u{1e}";
        assert_eq!(
            parse_dialog_log(log),
            vec![DialogRecord::Inputbox { prompt: "p".into(), title: "t".into(), response: "r".into(), exhausted: false }]
        );
        assert!(parse_dialog_log("").is_empty());
        match parse_shim_payload("error\u{1f}1004\u{1f}\u{1f}desc\u{1f}msgbox\u{1f}a\u{1f}b\u{1f}6") {
            ShimOutcome::Error { error, dialogs } => {
                assert_eq!(error.source, None);
                assert_eq!(dialogs, vec![DialogRecord::Msgbox { prompt: "a".into(), title: "b".into(), response: "6".into() }]);
            }
            _ => panic!(),
        }
        assert!(matches!(parse_shim_payload("garbage"), ShimOutcome::Empty));
    }

    #[test]
    fn cells_payload_single_value_becomes_one_by_one() {
        assert_eq!(cells_from_json("S", "B2", &json!(5)).values, vec![vec![json!(5)]]);
        assert_eq!(
            cells_from_json("S", "A1:B1", &json!([[1, {"err": -2146826246}]])).values,
            vec![vec![json!(1), json!("#N/A")]]
        );
    }

    #[test]
    fn cells_payload_shapes_and_unknown_errors() {
        let b = cells_from_json("S", "A1:C1", &json!([1, "a", null]));
        assert_eq!(b.sheet, "S");
        assert_eq!(b.range, "A1:C1");
        assert_eq!(b.values, vec![vec![json!(1), json!("a"), json!(null)]]);
        assert_eq!(cells_from_json("S", "A1", &json!({"err": 1})).values, vec![vec![json!("#ERR")]]);
        assert_eq!(cells_from_json("S", "A1", &json!({"x": 1})).values, vec![vec![json!(null)]]);
    }

    #[test]
    fn parses_vbe_error_text_in_japanese_and_english() {
        assert_eq!(
            parse_vbe_error_text("実行時エラー '9':\r\n\r\nインデックスが有効範囲にありません。"),
            Some((9, "インデックスが有効範囲にありません。".into()))
        );
        assert_eq!(
            parse_vbe_error_text("Run-time error '1004':\r\nApplication-defined error"),
            Some((1004, "Application-defined error".into()))
        );
        assert_eq!(parse_vbe_error_text("完了しました"), None);
    }

    #[test]
    fn result_serializes_with_spec_field_names() {
        let v = serde_json::to_value(MacroResult {
            macro_name: "Module1.Main".into(),
            status: MacroStatus::DialogInterrupted,
            duration_ms: None,
            error: None,
            dialogs: vec![DialogRecord::Window { class: "#32770".into(), title: "t".into(), text: "x".into(), clicked: Some("終了".into()) }],
        })
        .unwrap();
        assert_eq!(v["macro"], "Module1.Main");
        assert_eq!(v["status"], "dialog_interrupted");
        assert_eq!(v["dialogs"][0]["kind"], "window");
        assert!(v.get("durationMs").is_some());
    }

    #[test]
    fn run_result_uses_camel_case() {
        let v = serde_json::to_value(RunResult {
            ok: true,
            run_copy_path: "p".into(),
            source: RunSource::MacrosDir,
            warnings: vec![],
            open_dialogs: vec![],
            results: vec![],
            cells: vec![],
            run_budget: BudgetInfo { used: 1, limit: VBA_RUN_BUDGET },
            notes: vec![],
        })
        .unwrap();
        for k in ["runCopyPath", "openDialogs", "runBudget", "notes", "cells", "warnings"] {
            assert!(v.get(k).is_some(), "missing {k}");
        }
        assert_eq!(v["source"], "macros_dir");
        assert_eq!(serde_json::to_value(ErrorFrom::Dialog).unwrap(), json!("dialog"));
    }

    // ---- Excel-openable synthetic workbook (no Excel COM / VBOM access needed) ----

    use crate::commands::vba::tests::make_record;
    use crate::commands::vba::vba_compress;
    use crate::commands::vba_streams::{DirStream, ModuleKind, ProjectStream, ProjectWm};
    use std::io::Write;

    const VBA_LIBID: &str = r"*\G{000204EF-0000-0000-C000-000000000046}#4.2#9#C:\PROGRA~1\COMMON~1\MICROS~1\VBA\VBA7.1\VBE7.DLL#Visual Basic For Applications";
    const EXCEL_LIBID: &str = r"*\G{00020813-0000-0000-C000-000000000046}#1.9#0#C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE#Microsoft Excel 16.0 Object Library";
    const STDOLE_LIBID: &str = r"*\G{00020430-0000-0000-C000-000000000046}#2.0#0#C:\Windows\System32\stdole2.tlb#OLE Automation";

    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    /// A complete MS-OVBA dir stream header (project information + references), no modules yet.
    fn full_dir_header(code_page: u16) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend(make_record(0x0001, &3u32.to_le_bytes())); // SYSKIND: Win64
        v.extend(make_record(0x004A, &2u32.to_le_bytes())); // COMPATVERSION
        v.extend(make_record(0x0002, &0x0411u32.to_le_bytes())); // LCID
        v.extend(make_record(0x0014, &0x0411u32.to_le_bytes())); // LCIDINVOKE
        v.extend(make_record(0x0003, &code_page.to_le_bytes())); // CODEPAGE
        v.extend(make_record(0x0004, b"VBAProject")); // NAME
        v.extend(make_record(0x0005, &[])); // DOCSTRING
        v.extend(make_record(0x0040, &[])); // DOCSTRING (Unicode)
        v.extend(make_record(0x0006, &[])); // HELPFILEPATH
        v.extend(make_record(0x003D, &[])); // HELPFILEPATH 2
        v.extend(make_record(0x0007, &0u32.to_le_bytes())); // HELPCONTEXT
        v.extend(make_record(0x0008, &0u32.to_le_bytes())); // LIBFLAGS
        // VERSION: declared size 4, followed by major (u32) and minor (u16).
        v.extend_from_slice(&0x0009u16.to_le_bytes());
        v.extend_from_slice(&4u32.to_le_bytes());
        v.extend_from_slice(&0x6F11_6A3Fu32.to_le_bytes());
        v.extend_from_slice(&0x0010u16.to_le_bytes());
        v.extend(make_record(0x000C, &[])); // CONSTANTS
        v.extend(make_record(0x003C, &[])); // CONSTANTS (Unicode)
        for (name, libid) in [("VBA", VBA_LIBID), ("Excel", EXCEL_LIBID), ("stdole", STDOLE_LIBID)] {
            v.extend(make_record(0x0016, name.as_bytes())); // REFERENCENAME
            v.extend(make_record(0x003E, &utf16(name)));
            let mut reg = Vec::new();
            reg.extend_from_slice(&(libid.len() as u32).to_le_bytes());
            reg.extend_from_slice(libid.as_bytes());
            reg.extend_from_slice(&0u32.to_le_bytes());
            reg.extend_from_slice(&0u16.to_le_bytes());
            v.extend(make_record(0x000D, &reg)); // REFERENCEREGISTERED
        }
        v.extend(make_record(0x000F, &0u16.to_le_bytes())); // PROJECTMODULES
        v.extend(make_record(0x0013, &0xFFFFu16.to_le_bytes())); // PROJECTCOOKIE
        v.extend(make_record(0x0010, &[])); // TERMINATOR
        v
    }

    const THIS_WORKBOOK_SRC: &str = "Attribute VB_Name = \"ThisWorkbook\"\r\nAttribute VB_Base = \"0{00020819-0000-0000-C000-000000000046}\"\r\nAttribute VB_GlobalNameSpace = False\r\nAttribute VB_Creatable = False\r\nAttribute VB_PredeclaredId = True\r\nAttribute VB_Exposed = True\r\nAttribute VB_TemplateDerived = False\r\nAttribute VB_Customizable = True\r\n";
    const SHEET1_SRC: &str = "Attribute VB_Name = \"Sheet1\"\r\nAttribute VB_Base = \"0{00020820-0000-0000-C000-000000000046}\"\r\nAttribute VB_GlobalNameSpace = False\r\nAttribute VB_Creatable = False\r\nAttribute VB_PredeclaredId = True\r\nAttribute VB_Exposed = True\r\nAttribute VB_TemplateDerived = False\r\nAttribute VB_Customizable = True\r\n";

    /// vbaProject.bin with ThisWorkbook / Sheet1 document modules plus `extra` modules.
    fn excel_vba_bin(code_page: u16, extra: &[(&str, ModuleKind, &str)]) -> Vec<u8> {
        let mut comp = cfb::CompoundFile::create(std::io::Cursor::new(Vec::new())).unwrap();
        comp.create_storage("/VBA").unwrap();
        let mut project = ProjectStream {
            lines: vec![
                "ID=\"{5F1A2B3C-4D5E-4F60-8172-93A4B5C6D7E8}\"".into(),
                "Name=\"VBAProject\"".into(),
                "HelpContextID=\"0\"".into(),
                "VersionCompatible32=\"393222000\"".into(),
                "".into(),
                "[Host Extender Info]".into(),
                "&H00000001={3832D640-CF90-11CF-8E43-00A0C911005A};VBE;&H00000000".into(),
                "".into(),
            ],
        };
        let mut wm = ProjectWm { names: vec![] };
        let mut dir = DirStream::parse(&full_dir_header(code_page)).unwrap();
        // `extra` may replace the default document modules (e.g. Sheet1 with code).
        let mut all: Vec<(&str, ModuleKind, &str)> =
            vec![("ThisWorkbook", ModuleKind::Document, THIS_WORKBOOK_SRC), ("Sheet1", ModuleKind::Document, SHEET1_SRC)];
        all.retain(|(name, _, _)| !extra.iter().any(|(n, _, _)| n == name));
        all.extend_from_slice(extra);
        for (name, kind, source) in all {
            project.add_module(name, kind);
            wm.add(name);
            dir.append_module(name, name, kind, 0, false, code_page).unwrap();
            let encoded = crate::commands::vba::encode_string(source, code_page).unwrap();
            comp.create_stream(&format!("/VBA/{}", name)).unwrap().write_all(&vba_compress(&encoded)).unwrap();
        }
        comp.create_stream("/PROJECT").unwrap().write_all(&project.serialize(code_page).unwrap()).unwrap();
        comp.create_stream("/PROJECTwm").unwrap().write_all(&wm.serialize(code_page).unwrap()).unwrap();
        comp.create_stream("/VBA/dir").unwrap().write_all(&vba_compress(&dir.serialize())).unwrap();
        comp.create_stream("/VBA/_VBA_PROJECT").unwrap().write_all(&[0xCC, 0x61, 0xFF, 0xFF, 0x00, 0x00, 0x00]).unwrap();
        comp.flush().unwrap();
        comp.into_inner().into_inner()
    }

    /// A minimal but complete .xlsm (one sheet "Sheet1") that Excel opens, with `extra` VBA modules.
    pub(crate) fn excel_workbook(dir: &Path, file_name: &str, extra: &[(&str, ModuleKind, &str)]) -> PathBuf {
        const CT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#;
        const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;
        const WB: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr codeName="ThisWorkbook"/><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        const WB_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>"#;
        const SHEET: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr codeName="Sheet1"/><sheetData/></worksheet>"#;
        let path = dir.join(file_name);
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (name, body) in [
            ("[Content_Types].xml", CT.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("xl/workbook.xml", WB.as_bytes()),
            ("xl/_rels/workbook.xml.rels", WB_RELS.as_bytes()),
            ("xl/worksheets/sheet1.xml", SHEET.as_bytes()),
        ] {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.start_file("xl/vbaProject.bin", opts).unwrap();
        zip.write_all(&excel_vba_bin(932, extra)).unwrap();
        zip.finish().unwrap();
        path
    }

    // ---- real Excel (manual: `cargo test --lib -- --ignored vba_run_excel`) ----

    fn std_src(name: &str, body: &str) -> String {
        format!("Attribute VB_Name = \"{}\"\r\n{}", name, body.replace('\n', "\r\n"))
    }

    /// Builds an Excel-openable workbook with `modules`, runs `req` (source = workbook)
    /// through the orchestration and checks the original stays untouched.
    fn excel_run(dir: &Path, modules: &[(&str, ModuleKind, &str)], mut req: serde_json::Value) -> RunResult {
        let xlsm = excel_workbook(dir, "Book1.xlsm", modules);
        let path = xlsm.to_string_lossy().into_owned();
        let before = std::fs::read(&xlsm).unwrap();
        req["xlsm_path"] = json!(path);
        req["source"] = json!("workbook");
        let req: RunRequest = serde_json::from_value(req).unwrap();
        let state = new_vba_run_state();
        let never = |_: serde_json::Value| Err("no approval expected".to_string());
        let result = run_vba_macros_with(&state, &req, &path, &never).unwrap();
        assert_eq!(std::fs::read(&xlsm).unwrap(), before, "the original workbook must not change");
        assert!(Path::new(&result.run_copy_path).is_file());
        assert!(result.run_copy_path.starts_with(&*runs_dir_for(&xlsm).unwrap().to_string_lossy()));
        assert_eq!(result.run_budget, BudgetInfo { used: 1, limit: VBA_RUN_BUDGET });
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
        result
    }

    #[test]
    #[ignore]
    fn vba_run_excel_msgbox_and_inputbox_complete_without_dialogs() {
        let tmp = tempfile::tempdir().unwrap();
        let src = std_src(
            "Module1",
            "Sub Main()\nDim s\ns = InputBox(\"n\")\nMsgBox \"done \" & s\nRange(\"A1\").Value = CLng(s) * 2\nRange(\"B1\").Value = \"東京\"\nRange(\"A2\").Formula = \"=1/0\"\nEnd Sub\n",
        );
        let r = excel_run(
            tmp.path(),
            &[("Module1", ModuleKind::Standard, &src)],
            json!({
                "macros": [{ "name": "Main" }],
                "inputs": ["42"],
                "read": [{ "sheet": "Sheet1", "range": "A1" }, { "sheet": "Sheet1", "range": "A1:B2" }, { "sheet": "Sheet1" }]
            }),
        );
        assert!(r.ok, "{:?}", r.results);
        assert_eq!(r.results[0].status, MacroStatus::Ok);
        assert_eq!(
            r.results[0].dialogs,
            vec![
                DialogRecord::Inputbox { prompt: "n".into(), title: "".into(), response: "42".into(), exhausted: false },
                DialogRecord::Msgbox { prompt: "done 42".into(), title: "".into(), response: "1".into() },
            ]
        );
        assert_eq!(r.cells.len(), 3);
        assert_eq!((r.cells[0].sheet.as_str(), r.cells[0].range.as_str()), ("Sheet1", "A1"));
        assert_eq!(r.cells[0].values[0][0].as_f64(), Some(84.0));
        // A 2-D block keeps strings, maps error codes and leaves empty cells null.
        let block = &r.cells[1];
        assert_eq!(block.range, "A1:B2");
        assert_eq!(block.values.len(), 2);
        assert_eq!(block.values[0][0].as_f64(), Some(84.0));
        assert_eq!(block.values[0][1], json!("東京"));
        assert_eq!(block.values[1][0], json!("#DIV/0!"));
        assert_eq!(block.values[1][1], json!(null));
        // Without a range the used range is read.
        assert_eq!(r.cells[2].range, "A1:B2");
        assert!(r.notes.is_empty(), "{:?}", r.notes);
        // The run copy was saved with the macro's result.
        let saved = crate::commands::xlsx_read::read_ranges(
            Path::new(&r.run_copy_path),
            &[RangeSpec { sheet: "Sheet1".into(), range: Some("A1".into()) }],
        )
        .unwrap();
        assert_eq!(saved[0].values[0][0].as_f64(), Some(84.0));
    }

    #[test]
    #[ignore]
    fn vba_run_excel_unhandled_error_in_standard_module_is_reported_from_handler() {
        let tmp = tempfile::tempdir().unwrap();
        let src = std_src("Module1", "Sub Boom()\nDim a(1)\na(5) = 1\nEnd Sub\nSub Fine()\nEnd Sub\n");
        let r = excel_run(tmp.path(), &[("Module1", ModuleKind::Standard, &src)], json!({ "macros": [{ "name": "Boom" }, { "name": "Fine" }] }));
        assert!(!r.ok);
        assert_eq!(r.results[0].status, MacroStatus::Error);
        let e = r.results[0].error.as_ref().unwrap();
        assert_eq!((e.number, e.from), (9, ErrorFrom::Handler));
        assert!(!e.description.is_empty());
        // Later macros still run after an error.
        assert_eq!(r.results[1].status, MacroStatus::Ok);
    }

    #[test]
    #[ignore]
    fn vba_run_excel_unhandled_error_in_an_event_handler_is_read_from_the_vbe_dialog() {
        // An error inside an event procedure never reaches the shim's handler:
        // VBE shows its run-time error dialog, the watch presses End and the
        // error is read from the dialog text.
        let tmp = tempfile::tempdir().unwrap();
        let sheet = format!("{}Private Sub Worksheet_Change(ByVal Target As Range)\r\nDim a(1)\r\na(5) = 1\r\nEnd Sub\r\n", SHEET1_SRC);
        let poke = std_src("Module1", "Sub Poke()\nRange(\"A1\").Value = 1\nEnd Sub\nSub Fine()\nEnd Sub\n");
        let r = excel_run(
            tmp.path(),
            &[("Sheet1", ModuleKind::Document, &sheet), ("Module1", ModuleKind::Standard, &poke)],
            json!({ "macros": [{ "name": "Poke" }, { "name": "Fine" }] }),
        );
        assert_eq!(r.results[0].status, MacroStatus::Error, "{:?}", r.results[0]);
        let e = r.results[0].error.as_ref().unwrap();
        assert_eq!((e.number, e.from, e.source.clone()), (9, ErrorFrom::Dialog, None));
        assert!(!e.description.is_empty());
        assert!(r.results[0].dialogs.iter().any(|d| matches!(d, DialogRecord::Window { class, .. } if class == "#32770")));
        assert_eq!(r.results[1].status, MacroStatus::Ok);
    }

    #[test]
    #[ignore]
    fn vba_run_excel_end_statement_interrupts_only_that_macro() {
        // `End` unwinding the wrapper must not take Excel down (it does for a
        // Function wrapper): the next macro still runs and the copy is saved.
        let tmp = tempfile::tempdir().unwrap();
        let src = std_src("Module1", "Sub Stop1()\nEnd\nEnd Sub\nSub Fine()\nRange(\"A1\").Value = 7\nEnd Sub\n");
        let r = excel_run(
            tmp.path(),
            &[("Module1", ModuleKind::Standard, &src)],
            json!({ "macros": [{ "name": "Stop1" }, { "name": "Fine" }], "read": [{ "sheet": "Sheet1", "range": "A1" }] }),
        );
        assert_eq!(r.results.iter().map(|m| m.status).collect::<Vec<_>>(), vec![MacroStatus::DialogInterrupted, MacroStatus::Ok]);
        assert_eq!(r.cells[0].values[0][0].as_f64(), Some(7.0));
        assert!(r.notes.is_empty(), "{:?}", r.notes);
    }

    #[test]
    #[ignore]
    fn vba_run_excel_qualified_vba_msgbox_is_dismissed_by_the_watch() {
        let tmp = tempfile::tempdir().unwrap();
        let src = std_src("Module1", "Sub Hi()\nVBA.MsgBox \"hi\"\nEnd Sub\n");
        let r = excel_run(tmp.path(), &[("Module1", ModuleKind::Standard, &src)], json!({ "macros": [{ "name": "Hi" }] }));
        assert_eq!(r.results[0].status, MacroStatus::Ok, "{:?}", r.results[0]);
        assert!(
            r.results[0].dialogs.iter().any(|d| matches!(
                d,
                DialogRecord::Window { class, text, clicked: Some(c), .. } if class == "#32770" && text.contains("hi") && c == "OK"
            )),
            "{:?}",
            r.results[0].dialogs
        );
    }

    #[test]
    #[ignore]
    fn vba_run_excel_timeout_kills_excel() {
        let tmp = tempfile::tempdir().unwrap();
        let src = std_src("Module1", "Sub Spin()\nDo\nDoEvents\nLoop\nEnd Sub\nSub After()\nEnd Sub\n");
        let r = excel_run(
            tmp.path(),
            &[("Module1", ModuleKind::Standard, &src)],
            json!({ "macros": [{ "name": "Spin" }, { "name": "After" }], "timeout_ms": 15000, "read": [{ "sheet": "Sheet1" }] }),
        );
        assert_eq!(r.results.iter().map(|m| m.status).collect::<Vec<_>>(), vec![MacroStatus::Timeout, MacroStatus::NotRun]);
        assert!(!r.ok);
        assert!(r.cells.is_empty());
        assert_eq!(r.notes, vec!["Timed out after 15000 ms; the run copy was not saved.".to_string()]);

        // Same copy straight through the runner, to see the Excel process id go away.
        // 3000 ms expires during Excel start-up here (~3 s); the HWND grace still finds the pid.
        let outcome = spawn_and_watch(Path::new(&r.run_copy_path), 2, &[], 3000).unwrap();
        assert!(outcome.timed_out);
        assert!(!outcome.excel_left_running);
        let pid = outcome.excel_pid.expect("HWND line gives the Excel pid");
        // The runner already waited for termination; a still-open EXCEL.EXE under this pid means it leaked.
        if let Some(p) = crate::commands::vba_dialog_watch::HeldProcess::open(pid) {
            let excel = p.image_path().is_some_and(|i| crate::commands::vba_dialog_watch::image_matches(&i, "EXCEL.EXE"));
            assert!(!excel || p.wait_for_exit(5000), "EXCEL.EXE {pid} is still running");
        }
    }

    // ---- orchestration (Task 7) ----

    use crate::commands::vba::tests::{build_vba_bin, build_workbook, std_module, three_module_workbook};
    use crate::commands::vba::pull_vba_modules;

    fn win(class: &str, text: &str) -> DialogRecord {
        DialogRecord::Window { class: class.into(), title: "t".into(), text: text.into(), clicked: Some("OK".into()) }
    }

    fn names(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("Module1.M{}", i)).collect()
    }

    fn budget() -> BudgetInfo {
        BudgetInfo { used: 1, limit: VBA_RUN_BUDGET }
    }

    #[test]
    fn assemble_maps_events_to_statuses() {
        let outcome = RunnerOutcome {
            events: vec![
                RunnerEvent::Hwnd(1),
                RunnerEvent::OpenLog(String::new()),
                RunnerEvent::Result { index: 1, payload: "ok\u{1f}812\u{1f}".into() },
                RunnerEvent::RunExc { index: 2, message: "Exception from HRESULT: 0x800A9C68".into() },
            ],
            windows: vec![(2, win("#32770", "実行時エラー '1004':\r\nx"))],
            timed_out: true,
            ..Default::default()
        };
        let r = assemble_result(&request(Some(3000)), &names(3), &outcome, "c:/w/run/Book.xlsm", vec![], budget());
        assert_eq!(r.results.iter().map(|m| m.status).collect::<Vec<_>>(), vec![MacroStatus::Ok, MacroStatus::Error, MacroStatus::Timeout]);
        assert_eq!(r.results[0].duration_ms, Some(812));
        assert_eq!(
            r.results[1].error,
            Some(MacroError { number: 1004, source: None, description: "x".into(), from: ErrorFrom::Dialog })
        );
        assert_eq!(r.results[1].dialogs.len(), 1);
        assert_eq!(r.results[0].macro_name, "Module1.M1");
        assert!(!r.ok);
        assert_eq!(r.notes, vec!["Timed out after 3000 ms; the run copy was not saved.".to_string()]);
        assert_eq!(r.run_copy_path, "c:/w/run/Book.xlsm");
        assert_eq!(r.run_budget, budget());
    }

    #[test]
    fn assemble_marks_empty_result_without_error_text_as_dialog_interrupted() {
        let outcome = RunnerOutcome {
            events: vec![RunnerEvent::OpenLog(String::new()), RunnerEvent::Result { index: 1, payload: String::new() }],
            windows: vec![(1, win("#32770", "完了"))],
            exit_code: Some(0),
            ..Default::default()
        };
        let r = assemble_result(&request(None), &names(1), &outcome, "p", vec![], budget());
        assert_eq!(r.results[0].status, MacroStatus::DialogInterrupted);
        assert_eq!(r.results[0].error, None);
        assert_eq!(r.results[0].dialogs, vec![win("#32770", "完了")]);
        assert!(!r.ok);
        assert!(r.notes.is_empty());
    }

    #[test]
    fn assemble_puts_open_phase_windows_and_openlog_into_open_dialogs() {
        let outcome = RunnerOutcome {
            events: vec![
                RunnerEvent::OpenLog("msgbox\u{1f}hello\u{1f}\u{1f}1\u{1e}".into()),
                RunnerEvent::Result { index: 1, payload: "ok\u{1f}5\u{1f}msgbox\u{1f}done\u{1f}\u{1f}1\u{1e}".into() },
                RunnerEvent::Cells { index: 0, address: "A1:B1".into(), json: json!([[1, "a"]]) },
            ],
            windows: vec![(0, win("ThunderDFrame", "")), (1, win("#32770", "hi"))],
            exit_code: Some(0),
            ..Default::default()
        };
        let mut req = request(None);
        req.read = vec![RangeSpec { sheet: "Data".into(), range: Some("A1:B1".into()) }];
        let r = assemble_result(&req, &names(1), &outcome, "p", vec![], budget());
        assert_eq!(
            r.open_dialogs,
            vec![
                DialogRecord::Msgbox { prompt: "hello".into(), title: "".into(), response: "1".into() },
                win("ThunderDFrame", "")
            ]
        );
        assert_eq!(
            r.results[0].dialogs,
            vec![DialogRecord::Msgbox { prompt: "done".into(), title: "".into(), response: "1".into() }, win("#32770", "hi")]
        );
        assert_eq!(r.results[0].status, MacroStatus::Ok);
        assert!(r.ok);
        assert_eq!(r.cells.len(), 1);
        assert_eq!(r.cells[0].sheet, "Data");
        assert_eq!(r.cells[0].values, vec![vec![json!(1), json!("a")]]);
    }

    #[test]
    fn assemble_not_run_without_timeout_when_runner_died() {
        let outcome = RunnerOutcome { exit_code: Some(1), ..Default::default() };
        let r = assemble_result(&request(None), &names(2), &outcome, "p", vec![], budget());
        assert_eq!(r.results.iter().map(|m| m.status).collect::<Vec<_>>(), vec![MacroStatus::NotRun, MacroStatus::NotRun]);
        assert!(!r.ok);
        assert!(r.notes.is_empty());
    }

    #[test]
    fn assemble_handler_error_and_left_running_note() {
        let outcome = RunnerOutcome {
            events: vec![RunnerEvent::Result { index: 1, payload: "error\u{1f}9\u{1f}VBAProject\u{1f}bad\u{1f}".into() }],
            timed_out: true,
            excel_left_running: true,
            ..Default::default()
        };
        let r = assemble_result(&request(Some(5000)), &names(3), &outcome, "p", vec![], budget());
        assert_eq!(r.results.iter().map(|m| m.status).collect::<Vec<_>>(), vec![MacroStatus::Error, MacroStatus::Timeout, MacroStatus::NotRun]);
        assert_eq!(r.results[0].error.as_ref().map(|e| e.from), Some(ErrorFrom::Handler));
        assert_eq!(
            r.notes,
            vec![
                "Timed out after 5000 ms; the run copy was not saved.".to_string(),
                "No Excel window handle was received; an EXCEL.EXE process may still be running.".to_string()
            ]
        );
    }

    #[test]
    fn assemble_names_the_pid_when_a_received_excel_could_not_be_terminated() {
        let outcome = RunnerOutcome { timed_out: true, excel_pid: Some(4321), excel_left_running: true, ..Default::default() };
        let r = assemble_result(&request(Some(5000)), &names(1), &outcome, "p", vec![], budget());
        assert_eq!(
            r.notes,
            vec![
                "Timed out after 5000 ms; the run copy was not saved.".to_string(),
                "Excel (pid 4321) could not be terminated; it may still be running.".to_string()
            ]
        );
        // A pid that was ended cleanly adds no note.
        let outcome = RunnerOutcome { exit_code: Some(0), excel_pid: Some(4321), ..Default::default() };
        let r = assemble_result(&request(None), &names(1), &outcome, "p", vec![], budget());
        assert!(r.notes.is_empty(), "{:?}", r.notes);
    }

    fn macro_req(source: RunSource, macros: &[&str]) -> RunRequest {
        let specs: Vec<serde_json::Value> = macros.iter().map(|m| json!({ "name": m })).collect();
        let source = serde_json::to_value(source).unwrap();
        serde_json::from_value(json!({ "xlsm_path": "unused", "source": source, "macros": specs })).unwrap()
    }

    fn workbook_with(dir: &Path, modules: &[crate::commands::vba::tests::TestModule]) -> Vec<u8> {
        std::fs::read(build_workbook(dir, "Book1.xlsm", &build_vba_bin(1252, modules))).unwrap()
    }

    #[test]
    fn prepare_rejects_shim_name_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let none = tmp.path().join("none");
        let data = workbook_with(tmp.path(), &[std_module("MdiumShim", "Attribute VB_Name = \"MdiumShim\"\r\nSub A()\r\nEnd Sub\r\n")]);
        let err = prepare_run(&macro_req(RunSource::Workbook, &[]), &data, &none).err().unwrap();
        assert_eq!(err_code(&err), "shim_name_conflict");
        let data = workbook_with(tmp.path(), &[std_module("Module1", "Attribute VB_Name = \"Module1\"\r\nPrivate Function MsgBox()\r\nEnd Function\r\n")]);
        let err = prepare_run(&macro_req(RunSource::Workbook, &[]), &data, &none).err().unwrap();
        assert_eq!(err_code(&err), "shim_name_conflict");
        let data = workbook_with(tmp.path(), &[std_module("Module1", "Attribute VB_Name = \"Module1\"\r\nPublic Function InputBox(p)\r\nEnd Function\r\n")]);
        let err = prepare_run(&macro_req(RunSource::Workbook, &[]), &data, &none).err().unwrap();
        assert_eq!(err_code(&err), "shim_name_conflict");
    }

    #[test]
    fn prepare_reports_macro_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let data = std::fs::read(three_module_workbook(tmp.path())).unwrap();
        let none = tmp.path().join("none");
        let err = prepare_run(&macro_req(RunSource::Workbook, &["Module1.Nope"]), &data, &none).err().unwrap();
        assert_eq!(err_code(&err), "macro_not_found");
        assert!(err.contains("Module1.Nope"), "{err}");
        let p = prepare_run(&macro_req(RunSource::Workbook, &["hello"]), &data, &none).unwrap();
        assert_eq!(p.macros.len(), 1);
        assert_eq!((p.macros[0].module.as_str(), p.macros[0].proc.as_str()), ("Module1", "Hello"));
        assert!(p.side_effects.is_empty());
    }

    #[test]
    fn prepare_rejects_unsupported_args_before_rendering() {
        let tmp = tempfile::tempdir().unwrap();
        let data = std::fs::read(three_module_workbook(tmp.path())).unwrap();
        let req: RunRequest = serde_json::from_value(json!({
            "xlsm_path": "unused", "source": "workbook",
            "macros": [{ "name": "Module1.Hello", "args": [1, "x"] }, { "name": "Module1.Hello", "args": [true, [1]] }]
        }))
        .unwrap();
        let err = prepare_run(&req, &data, &tmp.path().join("none")).err().unwrap();
        assert_eq!(err_code(&err), "invalid_request");
        assert!(err.contains("macros[1].args[1]: unsupported argument type"), "{err}");
    }

    #[test]
    fn earlier_checks_win_over_a_bad_argument() {
        let tmp = tempfile::tempdir().unwrap();
        let data = std::fs::read(three_module_workbook(tmp.path())).unwrap();
        let bad = |source: &str, name: &str| -> RunRequest {
            serde_json::from_value(json!({
                "xlsm_path": "unused", "source": source, "macros": [{ "name": name, "args": [[1]] }]
            }))
            .unwrap()
        };
        let none = tmp.path().join("none");
        assert_eq!(err_code(&prepare_run(&bad("macros_dir", "Hello"), &data, &none).err().unwrap()), "macros_dir_not_found");
        assert_eq!(err_code(&prepare_run(&bad("workbook", "Nope"), &data, &none).err().unwrap()), "macro_not_found");
        assert_eq!(err_code(&prepare_run(&bad("workbook", "Hello"), &data, &none).err().unwrap()), "invalid_request");
    }

    #[test]
    fn workbook_source_ignores_macros_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        pull_vba_modules(xlsm.to_string_lossy().into_owned()).unwrap();
        let macros_dir = macros_dir_for(&xlsm).unwrap();
        std::fs::write(
            macros_dir.join("Module1.bas"),
            "Attribute VB_Name = \"Module1\"\r\nSub Hello()\r\nOn Error Resume Next\r\nEnd Sub\r\nSub Added()\r\nEnd Sub\r\n",
        )
        .unwrap();
        let data = std::fs::read(&xlsm).unwrap();

        let wb = prepare_run(&macro_req(RunSource::Workbook, &[]), &data, &macros_dir).unwrap();
        assert!(wb.warnings.is_empty());
        assert_eq!(wb.base, data);
        assert_eq!(err_code(&prepare_run(&macro_req(RunSource::Workbook, &["Added"]), &data, &macros_dir).err().unwrap()), "macro_not_found");

        let md = prepare_run(&macro_req(RunSource::MacrosDir, &["Added"]), &data, &macros_dir).unwrap();
        assert_eq!((md.macros[0].module.as_str(), md.macros[0].proc.as_str()), ("Module1", "Added"));
        assert_eq!(md.warnings.len(), 1, "plan_push lint warning expected: {:?}", md.warnings);
        assert_ne!(md.base, data, "macros_dir changes are applied to the run copy");
        assert_eq!(std::fs::read(&xlsm).unwrap(), data, "the original is never written");
    }

    #[test]
    fn prepare_without_macros_dir_is_macros_dir_not_found_only_for_macros_dir_source() {
        let tmp = tempfile::tempdir().unwrap();
        let xlsm = three_module_workbook(tmp.path());
        let data = std::fs::read(&xlsm).unwrap();
        let macros_dir = macros_dir_for(&xlsm).unwrap();
        assert!(!macros_dir.exists());
        let err = prepare_run(&macro_req(RunSource::MacrosDir, &["Hello"]), &data, &macros_dir).err().unwrap();
        assert_eq!(err_code(&err), "macros_dir_not_found");
        assert!(prepare_run(&macro_req(RunSource::Workbook, &["Hello"]), &data, &macros_dir).is_ok());
    }

    #[test]
    fn prepare_lists_side_effects() {
        let tmp = tempfile::tempdir().unwrap();
        let data = workbook_with(tmp.path(), &[std_module("Module1", "Attribute VB_Name = \"Module1\"\r\nSub A()\r\nKill \"c:\\x.txt\"\r\nEnd Sub\r\n")]);
        let p = prepare_run(&macro_req(RunSource::Workbook, &["A"]), &data, &tmp.path().join("none")).unwrap();
        assert_eq!(p.side_effects.len(), 1);
        assert_eq!(p.side_effects[0].line, 3);
    }

    // -- approval relay and run gate (no Excel: these stop before the runner starts) --

    fn side_effect_workbook(dir: &Path) -> String {
        let bin = build_vba_bin(1252, &[std_module("Module1", "Attribute VB_Name = \"Module1\"\r\nSub A()\r\nKill \"c:\\x.txt\"\r\nEnd Sub\r\n")]);
        build_workbook(dir, "Book1.xlsm", &bin).to_string_lossy().into_owned()
    }

    fn run_req(path: &str, allow: bool) -> RunRequest {
        serde_json::from_value(json!({ "xlsm_path": path, "source": "workbook", "macros": [{ "name": "A" }], "allow_side_effects": allow })).unwrap()
    }

    /// An emitter that answers every approval request with `granted` from another thread.
    fn answering(state: &VbaRunShared, granted: bool, calls: Arc<Mutex<Vec<serde_json::Value>>>) -> impl Fn(serde_json::Value) -> Result<(), String> {
        let state = state.clone();
        move |payload: serde_json::Value| {
            calls.lock().unwrap().push(payload.clone());
            let state = state.clone();
            let id = payload["id"].as_str().unwrap().to_string();
            std::thread::spawn(move || reply_approval(&state, &id, granted).unwrap());
            Ok(())
        }
    }

    fn used(state: &VbaRunShared, key: &str) -> u32 {
        state.lock().unwrap().used(key)
    }

    #[test]
    fn side_effects_without_allow_are_reported_without_asking() {
        let tmp = tempfile::tempdir().unwrap();
        let path = side_effect_workbook(tmp.path());
        let state = new_vba_run_state();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let emit = answering(&state, true, calls.clone());
        let err = run_vba_macros_with(&state, &run_req(&path, false), &path, &emit).err().unwrap();
        assert_eq!(err_code(&err), "side_effects_detected");
        let msg = serde_json::from_str::<serde_json::Value>(&err).unwrap()["message"].as_str().unwrap().to_string();
        assert!(msg.lines().any(|l| l == "Module1:3: Kill \"c:\\x.txt\""), "{msg}");
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(used(&state, &canonical_workbook_key(&path)), 0);
        // The in-progress flag was released.
        state.lock().unwrap().begin(&canonical_workbook_key(&path)).unwrap();
    }

    #[test]
    fn denied_approval_is_approval_denied_and_consumes_no_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let path = side_effect_workbook(tmp.path());
        let state = new_vba_run_state();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let emit = answering(&state, false, calls.clone());
        let err = run_vba_macros_with(&state, &run_req(&path, true), &path, &emit).err().unwrap();
        assert_eq!(err_code(&err), "approval_denied");
        let payload = calls.lock().unwrap()[0].clone();
        assert_eq!(payload["xlsmPath"], json!(path));
        assert_eq!(payload["macros"], json!(["Module1.A"]));
        assert_eq!(payload["matches"][0]["line"], json!(3));
        let key = canonical_workbook_key(&path);
        assert_eq!(used(&state, &key), 0);
        let s = state.lock().unwrap();
        assert!(s.pending_approvals.is_empty());
        assert!(!s.in_progress.contains(&key));
    }

    #[test]
    fn approval_is_remembered_per_fingerprint_until_reset() {
        let state = new_vba_run_state();
        let hits = vec![SideEffectHit { module: "Module1".into(), line: 3, text: "Kill x".into() }];
        let calls = Arc::new(Mutex::new(Vec::new()));
        let emit = answering(&state, true, calls.clone());
        let ask = |hits: &[SideEffectHit]| request_approval(&state, "k", "p", &[], hits, &emit, Duration::from_secs(5));
        ask(&hits).unwrap();
        ask(&hits).unwrap();
        assert_eq!(calls.lock().unwrap().len(), 1, "the same matches are asked once");
        let more = vec![hits[0].clone(), SideEffectHit { module: "Module1".into(), line: 4, text: "Shell(x)".into() }];
        ask(&more).unwrap();
        assert_eq!(calls.lock().unwrap().len(), 2, "new matches are asked again");
        state.lock().unwrap().reset("k");
        ask(&hits).unwrap();
        assert_eq!(calls.lock().unwrap().len(), 3, "reset forgets approvals");
    }

    #[test]
    fn unanswered_approval_times_out_and_clears_the_pending_slot() {
        let state = new_vba_run_state();
        let hits = vec![SideEffectHit { module: "M".into(), line: 1, text: "Kill x".into() }];
        let ids = Arc::new(Mutex::new(Vec::new()));
        let ids2 = ids.clone();
        let emit = move |p: serde_json::Value| {
            ids2.lock().unwrap().push(p["id"].as_str().unwrap().to_string());
            Ok(())
        };
        let err = request_approval(&state, "k", "p", &[], &hits, &emit, Duration::from_millis(50)).err().unwrap();
        assert_eq!(err_code(&err), "approval_timeout");
        assert!(state.lock().unwrap().pending_approvals.is_empty());
        assert!(!state.lock().unwrap().is_approved("k", &side_effects_fingerprint(&hits)));
        // A late reply for the expired id is an error.
        let id = ids.lock().unwrap()[0].clone();
        assert!(reply_approval(&state, &id, true).is_err());
    }

    #[test]
    fn emit_failure_is_run_failed_and_clears_the_pending_slot() {
        let state = new_vba_run_state();
        let hits = vec![SideEffectHit { module: "M".into(), line: 1, text: "Kill x".into() }];
        let emit = |_: serde_json::Value| Err("no window".to_string());
        let err = request_approval(&state, "k", "p", &[], &hits, &emit, Duration::from_secs(1)).err().unwrap();
        assert_eq!(err_code(&err), "run_failed");
        assert!(state.lock().unwrap().pending_approvals.is_empty());
    }

    #[test]
    fn exhausted_budget_and_concurrent_runs_are_refused_before_reading_the_workbook() {
        let state = new_vba_run_state();
        let path = "c:/nowhere/Book.xlsm";
        let key = canonical_workbook_key(path);
        state.lock().unwrap().begin(&key).unwrap();
        let none = |_: serde_json::Value| Ok(());
        assert_eq!(err_code(&run_vba_macros_with(&state, &run_req(path, false), path, &none).err().unwrap()), "run_in_progress");
        state.lock().unwrap().end(&key);
        for _ in 0..VBA_RUN_BUDGET {
            state.lock().unwrap().consume(&key);
        }
        assert_eq!(err_code(&run_vba_macros_with(&state, &run_req(path, false), path, &none).err().unwrap()), "run_budget_exhausted");
        // Neither refusal left the workbook marked as running.
        state.lock().unwrap().reset(&key);
        assert_eq!(err_code(&run_vba_macros_with(&state, &run_req(path, false), path, &none).err().unwrap()), "invalid_workbook");
        state.lock().unwrap().begin(&key).unwrap();
    }

    #[test]
    fn budget_is_shared_by_every_spelling_of_one_workbook() {
        let tmp = tempfile::tempdir().unwrap();
        let path = side_effect_workbook(tmp.path());
        std::fs::create_dir(tmp.path().join("sub")).unwrap();
        let dir = tmp.path().to_string_lossy().into_owned();
        let dotted = format!("{}/./Book1.xlsm", dir);
        let parent = format!("{}/sub/../Book1.xlsm", dir);
        let state = new_vba_run_state();
        for _ in 0..VBA_RUN_BUDGET {
            state.lock().unwrap().consume(&canonical_workbook_key(&dotted));
        }
        assert_eq!(used(&state, &canonical_workbook_key(&parent)), VBA_RUN_BUDGET);
        let none = |_: serde_json::Value| Ok(());
        for spelling in [&path, &dotted, &parent] {
            let err = run_vba_macros_with(&state, &run_req(spelling, false), spelling, &none).err().unwrap();
            assert_eq!(err_code(&err), "run_budget_exhausted", "{spelling}");
        }
        reset_run_budget_for(&state, &parent).unwrap();
        assert_eq!(used(&state, &canonical_workbook_key(&dotted)), 0);
    }

    #[test]
    fn poisoned_state_lock_is_run_failed() {
        let state = new_vba_run_state();
        let s2 = state.clone();
        let _ = std::thread::spawn(move || {
            let _g = s2.lock().unwrap();
            panic!("poison");
        })
        .join();
        let none = |_: serde_json::Value| Ok(());
        let err = run_vba_macros_with(&state, &run_req("c:/x.xlsm", false), "c:/x.xlsm", &none).err().unwrap();
        assert_eq!(err_code(&err), "run_failed");
        assert!(reply_approval(&state, "id", true).is_err());
    }
}

//! VBA run & verify core: request/result types, per-workbook run state,
//! run-copy folders and parsing of the PowerShell runner / shim protocol.
//! The Excel orchestration that uses these lives further down (Task 7).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::{Deserialize, Serialize};

use super::vba::{macros_dir_for, vba_error, PushWarning};
use super::vba_shim::{MsgBoxResponse, FIELD_SEP, RECORD_SEP};
use super::xlsx_read::{cell_error_label, CellBlock, RangeSpec};

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

/// Per-workbook run state, keyed by `vba::workbook_key`.
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

/// Removes all but the newest `keep` run folders (by name) and returns the removed paths.
pub fn prune_run_dirs(runs_dir: &Path, keep: usize) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(runs_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(vba_error("io", format!("Cannot read {}: {}", runs_dir.display(), e))),
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    let excess = dirs.len().saturating_sub(keep);
    let removed: Vec<PathBuf> = dirs.into_iter().take(excess).collect();
    for dir in &removed {
        fs::remove_dir_all(dir).map_err(|e| vba_error("io", format!("Cannot remove {}: {}", dir.display(), e)))?;
    }
    Ok(removed)
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
        let removed = prune_run_dirs(tmp.path(), RUN_COPY_KEEP).unwrap();
        assert_eq!(removed, vec![tmp.path().join("20260101-000001"), tmp.path().join("20260101-000002")]);
        assert!(!tmp.path().join("20260101-000002").exists());
        assert!(tmp.path().join("20260101-000003").is_dir());
        assert!(tmp.path().join("00000000-note.txt").is_file());
        assert!(prune_run_dirs(&tmp.path().join("missing"), 5).unwrap().is_empty());
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
}

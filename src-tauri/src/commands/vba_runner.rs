//! PowerShell runner for `vba_run`: starts Excel through COM on a run copy,
//! watches its dialogs (Win32) and enforces the timeout. Split out of
//! `vba_run.rs` to keep that file reviewable.

use std::path::Path;
#[cfg(windows)]
use std::sync::mpsc;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
use super::vba_run::{parse_runner_line, WATCH_INTERVAL_MS};
use super::vba::vba_error;
use super::vba_run::{DialogRecord, RunnerEvent};
use super::xlsx_read::RangeSpec;

// ---- PowerShell runner ----

/// The Excel COM runner. Single quotes only (the script travels as one
/// command-line argument); paths and settings arrive through environment
/// variables. Protocol lines on stdout: HWND, OPENLOG, RESULT, RUNEXC, CELLS.
pub const RUNNER_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
function B64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
function CellVal($v) {
  if ($null -eq $v) { return $null }
  if ($v -is [int]) { return @{ err = [int]$v } }
  return $v
}
try { $xl = New-Object -ComObject Excel.Application } catch { [Console]::Error.WriteLine('EXCEL_NOT_AVAILABLE: ' + $_.Exception.Message); exit 2 }
$code = 0
try {
  $xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false; $xl.Interactive = $false
  $xl.AutomationSecurity = 1
  [Console]::Out.WriteLine('HWND ' + $xl.Hwnd)
  $wb = $xl.Workbooks.Open($env:MDIUM_RUN_COPY, 0, $false)
  try {
    [Console]::Out.WriteLine('OPENLOG ' + (B64 ([string]$xl.Run('MdiumShim.MdiumTakeLog'))))
    $n = [int]$env:MDIUM_RUN_COUNT
    for ($i = 1; $i -le $n; $i++) {
      try {
        [void]$xl.Run('MdiumShim.MdiumRun' + $i)
        $r = $xl.Run('MdiumShim.MdiumTakeResult')
        [Console]::Out.WriteLine('RESULT ' + $i + ' ' + (B64 ([string]$r)))
      } catch {
        [Console]::Out.WriteLine('RUNEXC ' + $i + ' ' + (B64 $_.Exception.Message))
      }
    }
    $wb.Save()
    $reads = @()
    if ($env:MDIUM_RUN_READ) { $parsed = ConvertFrom-Json $env:MDIUM_RUN_READ; $reads = @($parsed) }
    for ($k = 0; $k -lt $reads.Count; $k++) {
      $spec = $reads[$k]
      $ws = $wb.Worksheets.Item($spec.sheet)
      if ($spec.range) { $rng = $ws.Range($spec.range) } else { $rng = $ws.UsedRange }
      $addr = $rng.Address($false, $false)
      $v = $rng.Value2
      $rows = @()
      if ($v -is [Array]) {
        for ($r = 1; $r -le $rng.Rows.Count; $r++) { $row = @(); for ($c = 1; $c -le $rng.Columns.Count; $c++) { $row += ,(CellVal $v[$r, $c]) }; $rows += ,$row }
      } else { $rows = @(,@(,(CellVal $v))) }
      [Console]::Out.WriteLine('CELLS ' + $k + ' ' + $addr + ' ' + (B64 (ConvertTo-Json -InputObject $rows -Depth 5 -Compress)))
    }
  } finally { $wb.Close($false) }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message); $code = 1
} finally {
  $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}
exit $code
"#;

/// Everything observed while the runner was alive.
#[derive(Debug, Clone, Default)]
pub struct RunnerOutcome {
    pub events: Vec<RunnerEvent>,
    /// Dismissed windows by phase: 0 = while opening, i = while macro i ran.
    pub windows: Vec<(usize, DialogRecord)>,
    pub timed_out: bool,
    pub exit_code: Option<i32>,
    pub stderr: String,
    pub excel_pid: Option<u32>,
    /// Excel may still be running: no HWND arrived (`excel_pid` is `None`), or
    /// it could not be terminated (`excel_pid` is `Some`).
    pub excel_left_running: bool,
}

#[cfg_attr(not(windows), allow(dead_code))] // only the Windows runner uses it
/// How long Excel may linger after the runner exits before it is terminated.
const EXCEL_EXIT_GRACE_MS: u64 = 10_000;
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows runner uses it
/// How long a timed-out run still waits for the HWND line (Excel start-up).
const HWND_GRACE_MS: u64 = 20_000;

#[cfg_attr(not(windows), allow(dead_code))] // only the Windows runner uses it
/// Phase of a dialog seen now: 0 before OPENLOG, else the macro in flight
/// (finished macros + 1), capped at the macro count.
fn current_phase(open_seen: bool, finished: usize, macro_count: usize) -> usize {
    if !open_seen {
        0
    } else {
        (finished + 1).min(macro_count)
    }
}

#[cfg_attr(not(windows), allow(dead_code))] // only the Windows runner uses it
fn same_window(a: &DialogRecord, b: &DialogRecord) -> bool {
    match (a, b) {
        (
            DialogRecord::Window { class: c1, title: t1, text: x1, .. },
            DialogRecord::Window { class: c2, title: t2, text: x2, .. },
        ) => c1 == c2 && t1 == t2 && x1 == x2,
        _ => false,
    }
}

#[cfg_attr(not(windows), allow(dead_code))] // only the Windows runner uses it
/// Appends one scan's records, skipping a window identical to one recorded
/// by the previous scan in the same phase (a window that refuses to close
/// would otherwise be recorded every interval).
fn push_scan(windows: &mut Vec<(usize, DialogRecord)>, previous: &mut Vec<(usize, DialogRecord)>, phase: usize, scan: Vec<DialogRecord>) {
    let current: Vec<(usize, DialogRecord)> = scan.into_iter().map(|r| (phase, r)).collect();
    for (p, rec) in &current {
        if !previous.iter().any(|(pp, prev)| pp == p && same_window(prev, rec)) {
            windows.push((*p, rec.clone()));
        }
    }
    *previous = current;
}

/// Starts the PowerShell runner on `copy_path` and watches it: dismisses
/// dialogs of its Excel process, enforces the timeout and collects stdout.
#[cfg(windows)]
pub fn spawn_and_watch(copy_path: &Path, macro_count: usize, read: &[RangeSpec], timeout_ms: u64) -> Result<RunnerOutcome, String> {
    use std::io::{BufRead, BufReader, Read};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    use crate::commands::vba_dialog_watch::{EndOutcome, HeldProcess, EXCEL_IMAGE};

    /// Ends the run's Excel through the held handle; `true` when it is gone.
    fn end_excel(excel: &HeldProcess, wait_ms: u64) -> bool {
        matches!(excel.end(wait_ms, EXCEL_IMAGE), EndOutcome::Exited | EndOutcome::Terminated)
    }

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", RUNNER_SCRIPT])
        .env("MDIUM_RUN_COPY", copy_path)
        .env("MDIUM_RUN_COUNT", macro_count.to_string())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if read.is_empty() {
        cmd.env_remove("MDIUM_RUN_READ");
    } else {
        let json = serde_json::to_string(read).map_err(|e| vba_error("run_failed", e.to_string()))?;
        cmd.env("MDIUM_RUN_READ", json);
    }
    let mut child = cmd.spawn().map_err(|e| vba_error("excel_not_available", format!("Cannot start PowerShell: {}", e)))?;

    let (tx, rx) = mpsc::channel::<String>();
    let stdout = child.stdout.take();
    let stdout_thread = std::thread::spawn(move || {
        if let Some(out) = stdout {
            for line in BufReader::new(out).split(b'\n') {
                let Ok(bytes) = line else { break };
                let text = String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').to_string();
                if tx.send(text).is_err() {
                    break;
                }
            }
        }
    });
    let stderr = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut err) = stderr {
            let _ = err.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    });

    let mut outcome = RunnerOutcome::default();
    let mut open_seen = false;
    let mut finished = 0usize;
    let mut previous_scan: Vec<(usize, DialogRecord)> = Vec::new();
    // Opened as soon as the HWND line names the Excel pid and held until the
    // run ends, so the pid cannot be reused while it is scanned, waited on or
    // terminated. Dropping it closes the handle.
    let mut excel: Option<HeldProcess> = None;
    let handle_line = |line: &str, outcome: &mut RunnerOutcome, open_seen: &mut bool, finished: &mut usize, excel: &mut Option<HeldProcess>| {
        if let Some(ev) = parse_runner_line(line) {
            match &ev {
                RunnerEvent::Hwnd(h) => {
                    if excel.is_none() {
                        outcome.excel_pid = crate::commands::vba_dialog_watch::pid_of_window(*h);
                        *excel = outcome.excel_pid.and_then(HeldProcess::open);
                    }
                }
                RunnerEvent::OpenLog(_) => *open_seen = true,
                RunnerEvent::Result { .. } | RunnerEvent::RunExc { .. } => *finished += 1,
                RunnerEvent::Cells { .. } => {}
            }
            outcome.events.push(ev);
        }
    };

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        while let Ok(line) = rx.try_recv() {
            handle_line(&line, &mut outcome, &mut open_seen, &mut finished, &mut excel);
        }
        if let Some(pid) = excel.as_ref().map(HeldProcess::pid) {
            let phase = current_phase(open_seen, finished, macro_count);
            let scan = crate::commands::vba_dialog_watch::scan_and_dismiss(pid);
            push_scan(&mut outcome.windows, &mut previous_scan, phase, scan);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                outcome.exit_code = status.code();
                break;
            }
            Ok(None) => {}
            Err(e) => {
                outcome.stderr = e.to_string();
                // Without a kill the stdout reader below would wait for a live PowerShell.
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
        if Instant::now() >= deadline {
            outcome.timed_out = true;
            // Excel takes seconds to start; a short timeout can expire before the
            // HWND line. Wait a little for it so the instance can be ended
            // instead of leaked (only a pid from our own HWND line is ever killed).
            let grace_end = Instant::now() + Duration::from_millis(HWND_GRACE_MS);
            while outcome.excel_pid.is_none() && Instant::now() < grace_end {
                match rx.recv_timeout(Duration::from_millis(WATCH_INTERVAL_MS)) {
                    Ok(line) => handle_line(&line, &mut outcome, &mut open_seen, &mut finished, &mut excel),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            if !excel.as_ref().is_some_and(|p| end_excel(p, 0)) {
                outcome.excel_left_running = true;
            }
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(WATCH_INTERVAL_MS));
    }

    // The pipes close once PowerShell is gone; collect what is left.
    let _ = stdout_thread.join();
    while let Ok(line) = rx.try_recv() {
        handle_line(&line, &mut outcome, &mut open_seen, &mut finished, &mut excel);
    }
    let stderr_text = stderr_thread.join().unwrap_or_default();
    if outcome.stderr.is_empty() {
        outcome.stderr = stderr_text;
    }

    // Excel normally exits right after Quit; a lingering hidden instance is useless, so end it.
    // Without a held handle there is nothing that can safely be waited on or ended.
    if !outcome.timed_out {
        if let Some(p) = &excel {
            if !end_excel(p, EXCEL_EXIT_GRACE_MS) {
                outcome.excel_left_running = true;
            }
        }
    }
    drop(excel);
    Ok(outcome)
}

#[cfg(not(windows))]
pub fn spawn_and_watch(copy_path: &Path, macro_count: usize, read: &[RangeSpec], timeout_ms: u64) -> Result<RunnerOutcome, String> {
    let _ = (copy_path, macro_count, read, timeout_ms);
    Err(vba_error("excel_not_available", "Running macros needs Windows with desktop Excel."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(class: &str, text: &str) -> DialogRecord {
        DialogRecord::Window { class: class.into(), title: "t".into(), text: text.into(), clicked: Some("OK".into()) }
    }

    #[test]
    fn phase_is_zero_before_openlog_then_follows_finished_macros() {
        assert_eq!(current_phase(false, 0, 3), 0);
        assert_eq!(current_phase(true, 0, 3), 1);
        assert_eq!(current_phase(true, 2, 3), 3);
        assert_eq!(current_phase(true, 3, 3), 3);
        assert_eq!(current_phase(true, 0, 0), 0);
    }

    #[test]
    fn repeated_window_in_the_same_phase_is_recorded_once() {
        let mut windows = Vec::new();
        let mut prev = Vec::new();
        push_scan(&mut windows, &mut prev, 1, vec![win("ThunderDFrame", "")]);
        push_scan(&mut windows, &mut prev, 1, vec![win("ThunderDFrame", "")]);
        push_scan(&mut windows, &mut prev, 1, vec![win("ThunderDFrame", ""), win("#32770", "x")]);
        assert_eq!(windows, vec![(1, win("ThunderDFrame", "")), (1, win("#32770", "x"))]);
        // A new phase records the same window again.
        push_scan(&mut windows, &mut prev, 2, vec![win("#32770", "x")]);
        assert_eq!(windows.len(), 3);
        // An empty scan in between ends the streak.
        push_scan(&mut windows, &mut prev, 2, vec![]);
        push_scan(&mut windows, &mut prev, 2, vec![win("#32770", "x")]);
        assert_eq!(windows.len(), 4);
    }
}

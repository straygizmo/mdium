//! Detects and dismisses dialogs shown by a hidden Excel process during a VBA run.
//!
//! The pure helpers (`pick_button`, `dismiss_plan`) compile on every platform.
//! The Win32 scan lives in the `win` module; other platforms get no-op stubs.

use crate::commands::vba_run::DialogRecord;

/// Buttons to press on a `#32770` dialog, most preferred first.
pub const BUTTON_PREFERENCE: [&str; 7] = ["終了", "End", "キャンセル", "Cancel", "いいえ", "No", "OK"];
/// Buttons to press on an Excel built-in (`bosa_sdm_XL9`) dialog.
pub const CANCEL_PREFERENCE: [&str; 2] = ["キャンセル", "Cancel"];

/// Image file name a run's Excel process must have before it is terminated.
pub const EXCEL_IMAGE: &str = "EXCEL.EXE";

/// How `HeldProcess::end` finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndOutcome {
    /// The process exited by itself within the wait.
    Exited,
    /// The process was terminated.
    Terminated,
    /// The image name did not match, so the process was left alone.
    Refused,
    /// TerminateProcess (or the image query) failed.
    Failed,
}

/// Whether `image_path` names the executable `image` (case-insensitive file-name match).
pub fn image_matches(image_path: &str, image: &str) -> bool {
    let name = image_path.rsplit(['\u{5c}', '/']).next().unwrap_or("");
    name.eq_ignore_ascii_case(image)
}

/// How a detected window should be dismissed.
#[derive(Debug, Clone, PartialEq)]
pub enum Dismiss {
    /// Click the button with this exact label.
    Click(String),
    /// Send `WM_CLOSE`.
    Close,
    /// Leave the window alone.
    Skip,
}

/// Normalizes a button label: drops a trailing mnemonic group such as
/// "(&E)" or "(E)", removes '&' characters, trims and lowercases.
fn normalize_label(label: &str) -> String {
    let mut s = label.trim();
    if let Some(stripped) = s.strip_suffix(')') {
        if let Some(open) = stripped.rfind('(') {
            let inner: String = stripped[open + 1..].chars().filter(|c| *c != '&').collect();
            if inner.chars().count() == 1 {
                s = &stripped[..open];
            }
        }
    }
    s.chars().filter(|c| *c != '&').collect::<String>().trim().to_lowercase()
}

/// Returns the label matching the first entry of `prefs` (in preference
/// order) that matches any label, ignoring mnemonics and case.
pub fn pick_button<'a>(labels: &'a [String], prefs: &[&str]) -> Option<&'a String> {
    let normalized: Vec<String> = labels.iter().map(|l| normalize_label(l)).collect();
    prefs.iter().find_map(|pref| {
        let want = pref.to_lowercase();
        normalized.iter().position(|n| *n == want).map(|i| &labels[i])
    })
}

/// Decides how to dismiss a window of the given class with the given button labels.
pub fn dismiss_plan(class: &str, labels: &[String]) -> Dismiss {
    let click_or_close = |prefs: &[&str]| match pick_button(labels, prefs) {
        Some(label) => Dismiss::Click(label.clone()),
        None => Dismiss::Close,
    };
    match class {
        "#32770" => click_or_close(&BUTTON_PREFERENCE),
        "bosa_sdm_XL9" => click_or_close(&CANCEL_PREFERENCE),
        "XLMAIN" => Dismiss::Skip,
        _ => Dismiss::Close,
    }
}

#[cfg(windows)]
mod win {
    use super::{dismiss_plan, Dismiss};
    use crate::commands::vba_run::DialogRecord;
    use windows_sys::core::BOOL;
    use super::{image_matches, EndOutcome};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetDlgCtrlID, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, PostMessageW, SendMessageTimeoutW, BN_CLICKED,
        SMTO_ABORTIFHUNG, WM_CLOSE, WM_COMMAND, WM_GETTEXT,
    };

    /// Upper bound for any message sent to another process's window.
    const SEND_TIMEOUT_MS: u32 = 2000;
    const TEXT_BUF_LEN: usize = 1024;

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        // SAFETY: the buffer is valid for `buf.len()` u16s; an invalid hwnd only yields 0.
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn text_of(hwnd: HWND) -> String {
        let mut buf = vec![0u16; TEXT_BUF_LEN];
        // SAFETY: the buffer is valid for `buf.len()` u16s. For windows of another
        // process this reads the cached caption without sending a message.
        let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    /// `GetWindowTextW`, falling back to a bounded `WM_GETTEXT` when it returns empty.
    fn control_text(hwnd: HWND) -> String {
        let direct = text_of(hwnd);
        if !direct.is_empty() {
            return direct;
        }
        let mut buf = vec![0u16; TEXT_BUF_LEN];
        let mut copied: usize = 0;
        // SAFETY: WM_GETTEXT writes at most wParam u16s (including the NUL) into the
        // buffer; SMTO_ABORTIFHUNG plus the timeout bound the wait.
        let ok = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_GETTEXT,
                buf.len(),
                buf.as_mut_ptr() as LPARAM,
                SMTO_ABORTIFHUNG,
                SEND_TIMEOUT_MS,
                &mut copied,
            )
        };
        if ok == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..copied.min(buf.len())])
    }

    pub fn pid_of_window(hwnd: isize) -> Option<u32> {
        let mut pid: u32 = 0;
        // SAFETY: `pid` is a valid out pointer; an invalid hwnd only returns 0.
        let tid = unsafe { GetWindowThreadProcessId(hwnd as HWND, &mut pid) };
        if tid == 0 {
            None
        } else {
            Some(pid)
        }
    }

    struct TopLevelCtx {
        pid: u32,
        found: Vec<(HWND, String, String)>,
    }

    unsafe extern "system" fn top_level_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `&mut TopLevelCtx` passed by `scan_and_dismiss`,
        // which outlives the synchronous EnumWindows call.
        let ctx = unsafe { &mut *(lparam as *mut TopLevelCtx) };
        // SAFETY: IsWindowVisible accepts any hwnd value.
        if unsafe { IsWindowVisible(hwnd) } != 0 && pid_of_window(hwnd as isize) == Some(ctx.pid) {
            ctx.found.push((hwnd, class_of(hwnd), text_of(hwnd)));
        }
        1
    }

    #[derive(Default)]
    struct ChildCtx {
        statics: Vec<String>,
        buttons: Vec<(HWND, String)>,
    }

    unsafe extern "system" fn child_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `&mut ChildCtx` passed by `collect_children`,
        // which outlives the synchronous EnumChildWindows call.
        let ctx = unsafe { &mut *(lparam as *mut ChildCtx) };
        let class = class_of(hwnd);
        if class.eq_ignore_ascii_case("Static") {
            let text = control_text(hwnd);
            if !text.trim().is_empty() {
                ctx.statics.push(text);
            }
        } else if class.eq_ignore_ascii_case("Button") {
            let label = control_text(hwnd);
            if !label.is_empty() {
                ctx.buttons.push((hwnd, label));
            }
        }
        1
    }

    fn collect_children(dialog: HWND) -> ChildCtx {
        let mut ctx = ChildCtx::default();
        // SAFETY: the callback only dereferences `lparam` as the `ChildCtx` borrowed here.
        unsafe { EnumChildWindows(dialog, Some(child_proc), &mut ctx as *mut ChildCtx as LPARAM) };
        ctx
    }

    /// Clicks `button` by sending WM_COMMAND/BN_CLICKED to `dialog` (bounded wait).
    fn click(dialog: HWND, button: HWND) -> bool {
        // SAFETY: GetDlgCtrlID accepts any hwnd value.
        let id = unsafe { GetDlgCtrlID(button) } as u32;
        // MAKEWPARAM(id, BN_CLICKED)
        let wparam = (((BN_CLICKED as u32) & 0xFFFF) << 16 | (id & 0xFFFF)) as usize;
        let mut result: usize = 0;
        // SAFETY: plain message send; SMTO_ABORTIFHUNG plus the timeout bound the wait.
        let ok = unsafe {
            SendMessageTimeoutW(
                dialog,
                WM_COMMAND,
                wparam,
                button as LPARAM,
                SMTO_ABORTIFHUNG,
                SEND_TIMEOUT_MS,
                &mut result,
            )
        };
        ok != 0
    }

    fn close(dialog: HWND) -> bool {
        // SAFETY: PostMessageW does not wait for the target thread.
        unsafe { PostMessageW(dialog, WM_CLOSE, 0, 0) != 0 }
    }

    pub fn scan_and_dismiss(pid: u32) -> Vec<DialogRecord> {
        let mut ctx = TopLevelCtx { pid, found: Vec::new() };
        // SAFETY: the callback only dereferences `lparam` as the `TopLevelCtx` borrowed here.
        unsafe { EnumWindows(Some(top_level_proc), &mut ctx as *mut TopLevelCtx as LPARAM) };

        let mut records = Vec::new();
        for (hwnd, class, title) in ctx.found {
            if class == "XLMAIN" {
                continue;
            }
            let children = collect_children(hwnd);
            let labels: Vec<String> = children.buttons.iter().map(|(_, l)| l.clone()).collect();
            let clicked = match dismiss_plan(&class, &labels) {
                Dismiss::Skip => continue,
                Dismiss::Click(label) => {
                    let button = children.buttons.iter().find(|(_, l)| *l == label).map(|(h, _)| *h);
                    match button {
                        Some(b) if click(hwnd, b) => Some(label),
                        // Click failed (hung or timed out): record it as not clicked.
                        _ => None,
                    }
                }
                Dismiss::Close => {
                    close(hwnd);
                    None
                }
            };
            records.push(DialogRecord::Window {
                class,
                title,
                text: children.statics.join("\n"),
                clicked,
            });
        }
        records
    }

    /// An open process handle, held for the rest of a run. While it is open
    /// Windows cannot reuse the pid, so waiting on and terminating through it
    /// can never reach an unrelated process. Closed exactly once on drop.
    pub struct HeldProcess {
        handle: HANDLE,
        pid: u32,
    }

    // SAFETY: a process handle is a kernel object reference usable from any thread.
    unsafe impl Send for HeldProcess {}

    impl HeldProcess {
        /// Opens `pid` for waiting, terminating and querying its image; `None` when
        /// the process is gone or inaccessible.
        pub fn open(pid: u32) -> Option<Self> {
            // SAFETY: plain API call; the result is checked for null.
            let handle = unsafe {
                OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
            };
            if handle.is_null() {
                None
            } else {
                Some(Self { handle, pid })
            }
        }

        pub fn pid(&self) -> u32 {
            self.pid
        }

        /// Waits up to `timeout_ms` for the process to exit; `true` when it has.
        pub fn wait_for_exit(&self, timeout_ms: u64) -> bool {
            let ms = timeout_ms.min(u32::MAX as u64 - 1) as u32;
            // SAFETY: `self.handle` is a valid process handle until drop.
            unsafe { WaitForSingleObject(self.handle, ms) == WAIT_OBJECT_0 }
        }

        /// Full path of the process image, or `None` when it cannot be queried.
        pub fn image_path(&self) -> Option<String> {
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            // SAFETY: the buffer holds `len` u16s; the call writes at most that many.
            let ok = unsafe { QueryFullProcessImageNameW(self.handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) };
            if ok == 0 {
                None
            } else {
                Some(String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]))
            }
        }

        /// Waits up to `wait_ms` for the process to exit, then terminates it, but
        /// only when its image file name is `image`.
        pub fn end(&self, wait_ms: u64, image: &str) -> EndOutcome {
            if self.wait_for_exit(wait_ms) {
                return EndOutcome::Exited;
            }
            match self.image_path() {
                None => EndOutcome::Failed,
                Some(path) if !image_matches(&path, image) => EndOutcome::Refused,
                Some(_) => {
                    // SAFETY: `self.handle` is a valid process handle until drop.
                    if unsafe { TerminateProcess(self.handle, 1) } != 0 {
                        EndOutcome::Terminated
                    } else if self.wait_for_exit(0) {
                        // It exited between the wait and the terminate.
                        EndOutcome::Exited
                    } else {
                        EndOutcome::Failed
                    }
                }
            }
        }
    }

    impl Drop for HeldProcess {
        fn drop(&mut self) {
            // SAFETY: the handle came from OpenProcess and is closed only here.
            unsafe { CloseHandle(self.handle) };
        }
    }
}

#[cfg(windows)]
pub use win::HeldProcess;

/// Returns the process id owning `hwnd`, or `None` for an invalid window.
pub fn pid_of_window(hwnd: isize) -> Option<u32> {
    #[cfg(windows)]
    return win::pid_of_window(hwnd);
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        None
    }
}

/// Records and dismisses every visible top-level window of `pid` (except the
/// Excel main window). Always empty on non-Windows platforms.
pub fn scan_and_dismiss(pid: u32) -> Vec<DialogRecord> {
    #[cfg(windows)]
    return win::scan_and_dismiss(pid);
    #[cfg(not(windows))]
    {
        let _ = pid;
        Vec::new()
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_most_preferred_button_ignoring_mnemonics() {
        let labels = vec!["継続(&C)".to_string(), "終了(&E)".to_string(), "デバッグ(&D)".to_string(), "ヘルプ(&H)".to_string()];
        assert_eq!(pick_button(&labels, &BUTTON_PREFERENCE).unwrap(), "終了(&E)");
        assert_eq!(pick_button(&["&Yes".to_string(), "&No".to_string()], &BUTTON_PREFERENCE).unwrap(), "&No");
        assert!(pick_button(&["Retry".to_string()], &BUTTON_PREFERENCE).is_none());
    }

    #[test]
    fn dismiss_plan_follows_class_table() {
        assert!(matches!(dismiss_plan("#32770", &["OK".into()]), Dismiss::Click(ref l) if l == "OK"));
        assert!(matches!(dismiss_plan("#32770", &[]), Dismiss::Close));
        assert!(matches!(dismiss_plan("bosa_sdm_XL9", &["OK".into(), "キャンセル".into()]), Dismiss::Click(ref l) if l == "キャンセル"));
        assert!(matches!(dismiss_plan("ThunderDFrame", &["OK".into()]), Dismiss::Close));
        assert!(matches!(dismiss_plan("XLMAIN", &[]), Dismiss::Skip));
    }

    #[test]
    fn image_match_compares_the_file_name_only() {
        assert!(image_matches(r"C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE", EXCEL_IMAGE));
        assert!(image_matches(r"C:\x\excel.exe", EXCEL_IMAGE));
        assert!(!image_matches(r"C:\x\NOTEXCEL.EXE", EXCEL_IMAGE));
        assert!(!image_matches(r"C:\EXCEL.EXE\cmd.exe", EXCEL_IMAGE));
        assert!(!image_matches("", EXCEL_IMAGE));
    }

    #[cfg(windows)]
    fn spawn_hidden(program: &str, args: &[&str]) -> std::process::Child {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(program)
            .args(args)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn held_process_reports_exited_for_a_short_lived_child() {
        let mut child = spawn_hidden("cmd", &["/c", "exit"]);
        let proc = HeldProcess::open(child.id()).expect("handle to a just-spawned child");
        assert_eq!(proc.end(10_000, "cmd.exe"), EndOutcome::Exited);
        let _ = child.wait();
    }

    #[cfg(windows)]
    #[test]
    fn held_process_terminates_a_long_lived_child_with_the_expected_image() {
        let mut child = spawn_hidden("powershell", &["-NoProfile", "-Command", "Start-Sleep 30"]);
        let proc = HeldProcess::open(child.id()).expect("handle to a just-spawned child");
        assert!(proc.image_path().unwrap().to_ascii_lowercase().ends_with("powershell.exe"));
        assert_eq!(proc.end(200, "powershell.exe"), EndOutcome::Terminated);
        assert!(proc.wait_for_exit(5_000));
        assert_eq!(child.wait().unwrap().code(), Some(1));
    }

    #[cfg(windows)]
    #[test]
    fn held_process_refuses_to_terminate_another_image() {
        let mut child = spawn_hidden("powershell", &["-NoProfile", "-Command", "Start-Sleep 30"]);
        let proc = HeldProcess::open(child.id()).expect("handle to a just-spawned child");
        assert_eq!(proc.end(0, EXCEL_IMAGE), EndOutcome::Refused);
        assert!(child.try_wait().unwrap().is_none(), "a non-EXCEL.EXE image must be left alone");
        child.kill().unwrap();
        let _ = child.wait();
    }
}

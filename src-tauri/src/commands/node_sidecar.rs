// src-tauri/src/commands/node_sidecar.rs
// Shared plumbing for Node sidecars (Claude sidecar, agent runner, workflow
// runner): spawn a bundled script with `node`, forward stdout/stderr lines as
// Tauri events (or to in-process callbacks), and write JSON lines to stdin.
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Serialize, Clone)]
pub struct SidecarLine {
    pub id: u32,
    pub line: String,
}

#[derive(Serialize, Clone)]
pub struct SidecarExit {
    pub id: u32,
    pub code: Option<i32>,
}

/// Upper bound on how long the reaper waits for stdout/stderr to reach EOF
/// after the child exits before it delivers the exit anyway.
const READER_DRAIN_BUDGET: Duration = Duration::from_secs(2);

// The map holds an Arc<Mutex<ChildStdin>> per sidecar so that a blocking
// write on one sidecar's stdin only holds that sidecar's per-entry lock,
// not the global map lock. This keeps spawn/kill/write for other sidecars
// from stalling behind a single backed-up process.
fn stdin_map() -> &'static Mutex<HashMap<u32, Arc<Mutex<ChildStdin>>>> {
    static MAP: OnceLock<Mutex<HashMap<u32, Arc<Mutex<ChildStdin>>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forward non-empty lines from a reader to a callback. Extracted for testing.
pub fn forward_lines<R: BufRead>(reader: R, mut emit: impl FnMut(String)) {
    for line in reader.lines() {
        match line {
            Ok(l) if !l.trim().is_empty() => emit(l),
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

fn strip_win_prefix(p: &PathBuf) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix("\\\\?\\").map(|x| x.to_string()).unwrap_or(s)
}

/// Locate `resources/<dir>/<file>` in the production bundle or the dev tree.
pub fn resolve_script(app: &AppHandle, dir: &str, file: &str) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    // Production bundle (Tauri copies ../resources/... into _up_/resources/...)
    let candidates = [
        resource_dir.join("_up_").join("resources").join(dir).join(file),
        resource_dir.join(dir).join(file),
        // Dev fallback: repo-root resources dir relative to src-tauri.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join(dir)
            .join(file),
    ];
    for c in candidates.iter() {
        if c.exists() {
            return Ok(strip_win_prefix(c));
        }
    }
    Err(format!("{} not found; run `npm run build:sidecar`", file))
}

pub fn spawn(app: AppHandle, script_path: &str, event_prefix: &'static str) -> Result<u32, String> {
    let line_event = format!("{}://line", event_prefix);
    let app_out = app.clone();
    let on_line = Box::new(move |id: u32, line: String| {
        let _ = app_out.emit(&line_event, SidecarLine { id, line });
    });

    let stderr_event = format!("{}://stderr", event_prefix);
    let app_err = app.clone();
    let on_stderr = Box::new(move |id: u32, line: String| {
        let _ = app_err.emit(&stderr_event, SidecarLine { id, line });
    });

    let exit_event = format!("{}://exit", event_prefix);
    let on_exit = Box::new(move |id: u32, code: Option<i32>| {
        let _ = app.emit(&exit_event, SidecarExit { id, code });
    });

    spawn_impl(script_path, &[], event_prefix, on_line, on_stderr, on_exit)
}

/// Like [`spawn`], but delivers stdout/stderr lines and the exit code to the
/// given callbacks instead of emitting Tauri events, and applies `env` on top
/// of the inherited environment. `write`/`kill` work on the returned id.
#[allow(dead_code)] // Used by the workflow runner once it is wired in.
pub fn spawn_with_handlers(
    script_path: &str,
    env: &[(String, String)],
    on_line: Box<dyn Fn(String) + Send>,
    on_stderr: Box<dyn Fn(String) + Send>,
    on_exit: Box<dyn FnOnce(Option<i32>) + Send>,
) -> Result<u32, String> {
    spawn_impl(
        script_path,
        env,
        "sidecar",
        Box::new(move |_, line| on_line(line)),
        Box::new(move |_, line| on_stderr(line)),
        Box::new(move |_, code| on_exit(code)),
    )
}

/// Shared implementation of [`spawn`] and [`spawn_with_handlers`].
///
/// Every callback receives the sidecar id (the child's pid). The child is
/// always reaped by a dedicated thread, which waits (bounded by
/// [`READER_DRAIN_BUDGET`]) for stdout/stderr to reach EOF so all output is
/// delivered first, then removes its stdin entry from the shared map and
/// calls `on_exit`.
fn spawn_impl(
    script_path: &str,
    env: &[(String, String)],
    label: &str,
    on_line: Box<dyn Fn(u32, String) + Send>,
    on_stderr: Box<dyn Fn(u32, String) + Send>,
    on_exit: Box<dyn FnOnce(u32, Option<i32>) + Send>,
) -> Result<u32, String> {
    // Mirror pty.rs: go through cmd on Windows so PATH lookup of node matches
    // the rest of the app; stdio pipes pass through cmd to node unchanged.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("node").arg(script_path);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("node");
        c.arg(script_path);
        c
    };

    // SECURITY: never run the sidecar process with the user-opened project
    // folder as its working directory. cmd.exe (and node's own module/PATH
    // resolution) search the current directory before PATH, so a malicious
    // node.exe/claude.cmd/etc. planted inside an untrusted opened folder
    // would otherwise get executed in place of the real tool. Instead, use
    // the sidecar script's own (trusted, app-controlled) parent directory as
    // cwd -- or leave cwd unset if it has none. The user's folder is still
    // passed to the sidecar via the `start_session` message, not the OS
    // process cwd.
    if let Some(parent) = PathBuf::from(script_path).parent() {
        cmd.current_dir(parent);
    }
    cmd.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", label, e))?;
    let id = child.id();

    // Take every pipe before registering anything, so a failure here never
    // leaves a stdin entry or an unreaped child behind.
    let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (stdin, stdout, stderr) = match pipes {
        (Some(i), Some(o), Some(e)) => (i, o, e),
        (i, _, _) => {
            let missing = if i.is_none() { "stdin" } else { "stdout/stderr" };
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("sidecar {} unavailable", missing));
        }
    };

    let stdin_entry = Arc::new(Mutex::new(stdin));
    stdin_map().lock().unwrap().insert(id, stdin_entry.clone());

    // Each reader signals EOF so the reaper can deliver all output before
    // the exit notification.
    let (eof_tx, eof_rx) = mpsc::channel::<()>();
    let eof_out = eof_tx.clone();
    std::thread::spawn(move || {
        forward_lines(BufReader::new(stdout), |line| on_line(id, line));
        let _ = eof_out.send(());
    });
    let eof_err = eof_tx;
    std::thread::spawn(move || {
        forward_lines(BufReader::new(stderr), |line| on_stderr(id, line));
        let _ = eof_err.send(());
    });

    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        // Give both readers a bounded time to drain. A grandchild that
        // inherited the pipes can keep them open past the child's exit, so
        // the exit is delivered anyway once the budget runs out.
        let deadline = Instant::now() + READER_DRAIN_BUDGET;
        for _ in 0..2 {
            let left = deadline.saturating_duration_since(Instant::now());
            if eof_rx.recv_timeout(left).is_err() {
                break;
            }
        }
        {
            // Only remove our own entry: once the child is reaped its pid can
            // be reused by a newer sidecar that registered under the same id.
            let mut map = stdin_map().lock().unwrap();
            if map.get(&id).is_some_and(|e| Arc::ptr_eq(e, &stdin_entry)) {
                map.remove(&id);
            }
        }
        drop(stdin_entry);
        on_exit(id, code);
    });

    Ok(id)
}

pub fn write(id: u32, line: &str) -> Result<(), String> {
    // Clone the per-sidecar Arc while holding the global lock only briefly,
    // then drop the global lock before doing the blocking write so other
    // sidecars' spawn/kill/write calls aren't blocked on this one's I/O.
    let stdin_arc = {
        let map = stdin_map().lock().unwrap();
        map.get(&id).ok_or("sidecar not running")?.clone()
    };
    let mut stdin = stdin_arc.lock().unwrap();
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

/// `taskkill` exit code for "process not found".
#[cfg(target_os = "windows")]
const TASKKILL_NOT_FOUND: i32 = 128;

pub fn kill(id: u32) -> Result<(), String> {
    // Dropping stdin lets a healthy sidecar exit on rl "close".
    stdin_map().lock().unwrap().remove(&id);
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("taskkill")
            .args(["/PID", &id.to_string(), "/F", "/T"])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| format!("Failed to run taskkill: {}", e))?;
        // taskkill exits with 128 when the process does not exist (already
        // exited). Match the exit code, not the message, which is localized.
        if !output.status.success() && output.status.code() != Some(TASKKILL_NOT_FOUND) {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            return Err(format!("taskkill failed: {}", stderr));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("kill")
            .args(["-9", &id.to_string()])
            .output()
            .map_err(|e| format!("Failed to run kill: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if !stderr.contains("No such process") {
                return Err(format!("kill failed: {}", stderr));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{forward_lines, kill, spawn_with_handlers, write};
    use crate::workflow::containment::containment_env;
    use std::io::Cursor;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    use tempfile::TempDir;

    #[test]
    fn forward_lines_skips_blank_lines() {
        let input = Cursor::new("a\n\n  \nb\n");
        let mut got: Vec<String> = vec![];
        forward_lines(input, |l| got.push(l));
        assert_eq!(got, vec!["a".to_string(), "b".to_string()]);
    }

    const TIMEOUT: Duration = Duration::from_secs(20);

    fn write_script(dir: &TempDir, name: &str, body: &str) -> String {
        let path = dir.path().join(name);
        std::fs::write(&path, body).unwrap();
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn spawn_with_handlers_applies_env_and_supports_write_and_kill() {
        let tmp = TempDir::new().unwrap();
        let script = write_script(
            &tmp,
            "echo.cjs",
            "process.stdin.on('data', d => process.stdout.write(d));\n\
             console.log(process.env.GIT_CONFIG_VALUE_0);\n",
        );
        let env = containment_env(&tmp.path().join("data")).unwrap();

        let (line_tx, line_rx) = mpsc::channel::<String>();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<i32>>();
        let id = spawn_with_handlers(
            &script,
            &env,
            Box::new(move |line| {
                let _ = line_tx.send(line);
            }),
            Box::new(|line| eprintln!("[test stderr] {line}")),
            Box::new(move |code| {
                let _ = exit_tx.send(code);
            }),
        )
        .expect("spawn node");

        assert_eq!(line_rx.recv_timeout(TIMEOUT).unwrap(), "never");

        write(id, "hello from rust").unwrap();
        assert_eq!(line_rx.recv_timeout(TIMEOUT).unwrap(), "hello from rust");

        kill(id).unwrap();
        exit_rx
            .recv_timeout(TIMEOUT)
            .expect("on_exit must fire after kill");
        // The stdin map entry is gone once the process has exited.
        assert!(write(id, "after exit").is_err());
    }

    #[test]
    fn spawn_with_handlers_delivers_output_before_exit() {
        let tmp = TempDir::new().unwrap();
        let script = write_script(
            &tmp,
            "last-words.cjs",
            "console.log('last words');\nconsole.error('last error');\nprocess.exit(0);\n",
        );
        for _ in 0..10 {
            let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let (exit_tx, exit_rx) = mpsc::channel::<()>();
            let ev_out = events.clone();
            let ev_err = events.clone();
            let ev_exit = events.clone();
            let id = spawn_with_handlers(
                &script,
                &[],
                // Slow handlers widen the race window: without draining the
                // readers, the exit would be recorded before these lines.
                Box::new(move |line| {
                    std::thread::sleep(Duration::from_millis(100));
                    ev_out.lock().unwrap().push(format!("out:{line}"));
                }),
                Box::new(move |line| {
                    std::thread::sleep(Duration::from_millis(100));
                    ev_err.lock().unwrap().push(format!("err:{line}"));
                }),
                Box::new(move |code| {
                    ev_exit.lock().unwrap().push(format!("exit:{code:?}"));
                    let _ = exit_tx.send(());
                }),
            )
            .expect("spawn node");

            exit_rx.recv_timeout(TIMEOUT).expect("on_exit must fire");
            let got = events.lock().unwrap().clone();
            assert_eq!(got.len(), 3, "{got:?}");
            assert_eq!(got[2], "exit:Some(0)", "exit must come last: {got:?}");
            assert!(got.contains(&"out:last words".to_string()), "{got:?}");
            assert!(got.contains(&"err:last error".to_string()), "{got:?}");
            // The reaper removed the stdin entry on self-exit.
            assert!(write(id, "after exit").is_err());
        }
    }

    #[test]
    fn reaper_removes_stdin_entry_when_process_exits_by_itself() {
        let tmp = TempDir::new().unwrap();
        let script = write_script(&tmp, "exit3.cjs", "process.exit(3);\n");
        let (exit_tx, exit_rx) = mpsc::channel::<Option<i32>>();
        let id = spawn_with_handlers(
            &script,
            &[],
            Box::new(|_| {}),
            Box::new(|_| {}),
            Box::new(move |code| {
                let _ = exit_tx.send(code);
            }),
        )
        .expect("spawn node");
        assert_eq!(exit_rx.recv_timeout(TIMEOUT).unwrap(), Some(3));
        assert_eq!(
            write(id, "after exit").unwrap_err(),
            "sidecar not running".to_string()
        );
        // Killing an already-exited sidecar is not an error.
        assert!(kill(id).is_ok());
    }
}

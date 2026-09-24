// src-tauri/src/commands/node_sidecar.rs
// Shared plumbing for Node sidecars (Claude sidecar, agent runner): spawn a
// bundled script with `node`, forward stdout/stderr lines as Tauri events, and
// write JSON lines to stdin.
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
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
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", event_prefix, e))?;
    let id = child.id();

    let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    stdin_map().lock().unwrap().insert(id, Arc::new(Mutex::new(stdin)));

    let line_event = format!("{}://line", event_prefix);
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let app_out = app.clone();
    std::thread::spawn(move || {
        forward_lines(BufReader::new(stdout), |line| {
            let _ = app_out.emit(&line_event, SidecarLine { id, line });
        });
    });

    let stderr_event = format!("{}://stderr", event_prefix);
    let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;
    let app_err = app.clone();
    std::thread::spawn(move || {
        forward_lines(BufReader::new(stderr), |line| {
            let _ = app_err.emit(&stderr_event, SidecarLine { id, line });
        });
    });

    let exit_event = format!("{}://exit", event_prefix);
    let app_exit = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        stdin_map().lock().unwrap().remove(&id);
        let _ = app_exit.emit(&exit_event, SidecarExit { id, code });
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
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            // Ignore "not found" errors (process already exited)
            if !stderr.contains("not found") {
                return Err(format!("taskkill failed: {}", stderr));
            }
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
    use super::forward_lines;
    use std::io::Cursor;

    #[test]
    fn forward_lines_skips_blank_lines() {
        let input = Cursor::new("a\n\n  \nb\n");
        let mut got: Vec<String> = vec![];
        forward_lines(input, |l| got.push(l));
        assert_eq!(got, vec!["a".to_string(), "b".to_string()]);
    }
}

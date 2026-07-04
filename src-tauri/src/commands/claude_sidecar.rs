// src-tauri/src/commands/claude_sidecar.rs
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

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

#[tauri::command]
pub fn resolve_claude_sidecar_path(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    // Production bundle (Tauri copies ../resources/... into _up_/resources/...)
    let candidates = [
        resource_dir
            .join("_up_")
            .join("resources")
            .join("claude-sidecar")
            .join("claude-sidecar.cjs"),
        resource_dir.join("claude-sidecar").join("claude-sidecar.cjs"),
        // Dev fallback: repo-root resources dir relative to src-tauri.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("claude-sidecar")
            .join("claude-sidecar.cjs"),
    ];
    for c in candidates.iter() {
        if c.exists() {
            return Ok(strip_win_prefix(c));
        }
    }
    Err("claude-sidecar.cjs not found; run `npm run build:sidecar`".to_string())
}

#[tauri::command]
pub fn spawn_claude_sidecar(app: AppHandle, script_path: String, cwd: String) -> Result<u32, String> {
    // Mirror pty.rs: go through cmd on Windows so PATH lookup of node matches
    // the rest of the app; stdio pipes pass through cmd to node unchanged.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("node").arg(&script_path);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("node");
        c.arg(&script_path);
        c
    };

    cmd.current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude sidecar: {}", e))?;
    let id = child.id();

    let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    stdin_map().lock().unwrap().insert(id, Arc::new(Mutex::new(stdin)));

    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let app_out = app.clone();
    std::thread::spawn(move || {
        forward_lines(BufReader::new(stdout), |line| {
            let _ = app_out.emit("claude-sidecar://line", SidecarLine { id, line });
        });
    });

    let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;
    let app_err = app.clone();
    std::thread::spawn(move || {
        forward_lines(BufReader::new(stderr), |line| {
            let _ = app_err.emit("claude-sidecar://stderr", SidecarLine { id, line });
        });
    });

    let app_exit = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        stdin_map().lock().unwrap().remove(&id);
        let _ = app_exit.emit("claude-sidecar://exit", SidecarExit { id, code });
    });

    Ok(id)
}

#[tauri::command]
pub fn write_claude_sidecar(id: u32, line: String) -> Result<(), String> {
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

#[tauri::command]
pub fn kill_claude_sidecar(id: u32) -> Result<(), String> {
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

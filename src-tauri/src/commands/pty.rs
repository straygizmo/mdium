use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

struct PtyState {
    writer: Box<dyn Write + Send>,
    pair: portable_pty::PtyPair,
}

type PtyMap = Arc<Mutex<HashMap<String, PtyState>>>;

static PTY_MAP: std::sync::OnceLock<PtyMap> = std::sync::OnceLock::new();

fn pty_store() -> &'static PtyMap {
    PTY_MAP.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
) -> Result<(), String> {
    // Kill existing PTY with same id if any
    {
        let mut guard = pty_store().lock().unwrap();
        guard.remove(&id);
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let cmd = if let Some(ref command_str) = command {
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(["/C", command_str]);
            c
        } else {
            let mut c = CommandBuilder::new("bash");
            c.args(["-c", command_str]);
            c
        };
        cmd.cwd(&cwd);
        cmd
    } else {
        let mut cmd = CommandBuilder::new_default_prog();
        cmd.cwd(&cwd);
        cmd
    };

    pair.slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get writer: {}", e))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get reader: {}", e))?;

    // Read thread - emit events with PTY id
    let event_name = format!("pty-output-{}", id);
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(&event_name, text);
                }
                Err(_) => break,
            }
        }
    });

    let mut guard = pty_store().lock().unwrap();
    guard.insert(id, PtyState { writer, pair });

    Ok(())
}

#[tauri::command]
pub fn write_to_pty(id: String, data: String) -> Result<(), String> {
    let mut guard = pty_store().lock().unwrap();
    if let Some(state) = guard.get_mut(&id) {
        state
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn resize_pty(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let guard = pty_store().lock().unwrap();
    if let Some(state) = guard.get(&id) {
        state
            .pair
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn kill_pty(id: String) -> Result<(), String> {
    let mut guard = pty_store().lock().unwrap();
    guard.remove(&id);
    Ok(())
}

#[tauri::command]
pub fn check_command_exists(name: String) -> bool {
    let result = if cfg!(target_os = "windows") {
        Command::new("where").arg(&name).output()
    } else {
        Command::new("which").arg(&name).output()
    };
    match result {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn install_npm_package(name: String) -> Result<(), String> {
    let npm = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
    let output = Command::new(npm)
        .args(["install", "-g", &name])
        .output()
        .map_err(|e| format!("Failed to run npm: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("npm install failed: {}", stderr))
    }
}

#[tauri::command]
pub fn spawn_background_process(command: String, args: Vec<String>, cwd: Option<String>) -> Result<u32, String> {
    let is_unc = cwd.as_ref().map_or(false, |d| d.starts_with("\\\\"));

    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        if is_unc {
            // cmd.exe cannot use UNC paths as cwd directly.
            // Use pushd which auto-maps UNC paths to a temporary drive letter.
            // raw_arg is required because arg() applies MSVC-style quote escaping
            // (\" for ") which cmd.exe does not understand.
            let args_str: String = args.iter()
                .map(|a| if a.contains(' ') { format!("\"{}\"", a) } else { a.clone() })
                .collect::<Vec<_>>()
                .join(" ");
            c.raw_arg(format!("/C pushd \"{}\" && {} {}", cwd.as_ref().unwrap(), command, args_str));
        } else {
            c.arg("/C").arg(&command).args(&args);
        }
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&command);
        c.args(&args);
        c
    };

    if let Some(dir) = &cwd {
        if !is_unc {
            cmd.current_dir(dir);
        }
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    let child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", command, e))?;
    Ok(child.id())
}

#[tauri::command]
pub fn kill_background_process(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
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
            .args(["-9", &pid.to_string()])
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

#[tauri::command]
pub fn install_claude_code() -> Result<(), String> {
    let output = if cfg!(target_os = "windows") {
        Command::new("powershell")
            .args(["-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex"])
            .output()
    } else {
        Command::new("bash")
            .args(["-c", "curl -fsSL https://claude.ai/install.sh | sh"])
            .output()
    };
    let output = output.map_err(|e| format!("Failed to run installer: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Install failed: {}", stderr))
    }
}

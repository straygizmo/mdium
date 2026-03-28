use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

struct SlidevProcess {
    pid: u32,
    port: u16,
    temp_dir: PathBuf,
}

type SlidevMap = Arc<Mutex<HashMap<String, SlidevProcess>>>;

static SLIDEV_MAP: OnceLock<SlidevMap> = OnceLock::new();

fn slidev_store() -> &'static SlidevMap {
    SLIDEV_MAP.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Find an available port by letting the OS assign one
fn find_available_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to find available port: {}", e))?;
    Ok(listener.local_addr().unwrap().port())
}

/// Create a deterministic hash for a file path
fn hash_path(file_path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// Create a symlink/junction to node_modules
fn link_node_modules(src: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Try symlink first, fall back to junction
        if std::os::windows::fs::symlink_dir(src, dest).is_err() {
            junction::create(src, dest)
                .map_err(|e| format!("Failed to create junction: {}", e))?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::os::unix::fs::symlink(src, dest)
            .map_err(|e| format!("Failed to create symlink: {}", e))?;
    }
    Ok(())
}

/// Kill a process by PID (platform-specific)
fn kill_process(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .output()
            .map_err(|e| format!("Failed to run taskkill: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
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
pub async fn slidev_start(
    app: AppHandle,
    file_path: String,
    markdown: String,
) -> Result<(String, u16), String> {
    let hash = hash_path(&file_path);
    let temp_base = std::env::temp_dir().join("mdium-slidev");
    let temp_dir = temp_base.join(&hash);

    // Clean up existing process for this file if any
    {
        let mut guard = slidev_store().lock().unwrap();
        if let Some(existing) = guard.remove(&file_path) {
            let _ = kill_process(existing.pid);
            let _ = fs::remove_dir_all(&existing.temp_dir);
        }
    }

    // Create temp directory structure
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    fs::create_dir_all(temp_dir.join("public").join("images"))
        .map_err(|e| format!("Failed to create public/images dir: {}", e))?;

    // Locate bundled resources
    // In production: resource_dir contains bundled files
    // In development: fall back to project root's resources/ directory
    let slidev_env_dir = {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;
        let prod_path = resource_dir.join("resources").join("slidev-env");
        if prod_path.join("package.json").exists() {
            prod_path
        } else {
            // Dev mode: resources are relative to the Tauri project root
            let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("resources")
                .join("slidev-env");
            if dev_path.join("package.json").exists() {
                dev_path
            } else {
                return Err(format!(
                    "Slidev environment not found. Checked:\n  {}\n  {}",
                    prod_path.display(),
                    dev_path.display()
                ));
            }
        }
    };

    // Copy package.json
    let package_json_src = slidev_env_dir.join("package.json");
    let package_json_dest = temp_dir.join("package.json");
    fs::copy(&package_json_src, &package_json_dest)
        .map_err(|e| format!("Failed to copy package.json: {}", e))?;

    // Link node_modules (symlink or junction) if bundled node_modules exists
    let node_modules_src = slidev_env_dir.join("node_modules");
    let node_modules_dest = temp_dir.join("node_modules");
    if node_modules_src.exists() && !node_modules_dest.exists() {
        link_node_modules(&node_modules_src, &node_modules_dest)?;
    }

    // Write slides.md
    let slides_path = temp_dir.join("slides.md");
    fs::write(&slides_path, &markdown)
        .map_err(|e| format!("Failed to write slides.md: {}", e))?;

    // Find available port
    let port = find_available_port()?;

    // Spawn slidev dev server
    let npx = if cfg!(target_os = "windows") {
        "npx.cmd"
    } else {
        "npx"
    };

    let temp_dir_str = temp_dir.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    let child = {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .arg("/C")
            .arg(npx)
            .args([
                "slidev",
                "dev",
                "--port",
                &port.to_string(),
                "--open",
                "false",
                "--remote",
                "false",
            ])
            .current_dir(&temp_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Failed to spawn slidev: {}", e))?
    };

    #[cfg(not(target_os = "windows"))]
    let child = {
        Command::new(npx)
            .args([
                "slidev",
                "dev",
                "--port",
                &port.to_string(),
                "--open",
                "false",
                "--remote",
                "false",
            ])
            .current_dir(&temp_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn slidev: {}", e))?
    };

    let pid = child.id();

    // Store process info
    {
        let mut guard = slidev_store().lock().unwrap();
        guard.insert(
            file_path.clone(),
            SlidevProcess {
                pid,
                port,
                temp_dir: temp_dir.clone(),
            },
        );
    }

    // Poll for server readiness in background
    let app_clone = app.clone();
    let file_path_clone = file_path.clone();
    tokio::spawn(async move {
        let url = format!("http://127.0.0.1:{}", port);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();

        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;

            // Check if process is still tracked (might have been stopped)
            {
                let guard = slidev_store().lock().unwrap();
                if !guard.contains_key(&file_path_clone) {
                    return;
                }
            }

            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() || resp.status().is_redirection() => {
                    let _ = app_clone.emit(
                        "slidev-ready",
                        serde_json::json!({
                            "filePath": file_path_clone,
                            "port": port,
                        }),
                    );
                    return;
                }
                _ => continue,
            }
        }

        // Timeout — emit error
        let _ = app_clone.emit(
            "slidev-error",
            serde_json::json!({
                "filePath": file_path_clone,
                "error": "Slidev server failed to start within 60 seconds",
            }),
        );
    });

    Ok((temp_dir_str, port))
}

#[tauri::command]
pub async fn slidev_sync(file_path: String, markdown: String) -> Result<(), String> {
    let slides_path = {
        let guard = slidev_store().lock().unwrap();
        guard
            .get(&file_path)
            .ok_or_else(|| format!("No slidev process found for: {}", file_path))?
            .temp_dir
            .join("slides.md")
    };

    fs::write(&slides_path, &markdown)
        .map_err(|e| format!("Failed to write slides.md: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn slidev_export(
    app: AppHandle,
    file_path: String,
    format: String,
    output_path: String,
) -> Result<String, String> {
    // Validate format against allowlist
    let format = match format.as_str() {
        "pdf" | "pptx" => format,
        _ => return Err(format!("Unsupported export format: {}", format)),
    };

    let (temp_dir, _port) = {
        let guard = slidev_store().lock().unwrap();
        let process = guard
            .get(&file_path)
            .ok_or_else(|| format!("No slidev process found for: {}", file_path))?;
        (process.temp_dir.clone(), process.port)
    };

    let npx = if cfg!(target_os = "windows") {
        "npx.cmd"
    } else {
        "npx"
    };

    let export_filename = "slidev-export";

    #[cfg(target_os = "windows")]
    let output = {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .arg("/C")
            .arg(npx)
            .args([
                "slidev",
                "export",
                "--format",
                &format,
                "--output",
                export_filename,
            ])
            .current_dir(&temp_dir)
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| format!("Failed to run slidev export: {}", e))?
    };

    #[cfg(not(target_os = "windows"))]
    let output = {
        Command::new(npx)
            .args([
                "slidev",
                "export",
                "--format",
                &format,
                "--output",
                export_filename,
            ])
            .current_dir(&temp_dir)
            .output()
            .map_err(|e| format!("Failed to run slidev export: {}", e))?
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("Slidev export failed: {}", stderr));
    }

    // Determine the exported file extension
    let ext = match format.as_str() {
        "pdf" => "pdf",
        "png" => "png",
        "pptx" => "pptx",
        _ => "pdf",
    };
    let export_file = temp_dir.join(format!("{}.{}", export_filename, ext));

    // Copy to user-chosen output path
    fs::copy(&export_file, &output_path)
        .map_err(|e| format!("Failed to copy export to output path: {}", e))?;

    // Suppress unused variable warning — app may be used for future event emission
    let _ = &app;

    Ok(output_path)
}

#[tauri::command]
pub async fn slidev_stop(file_path: String) -> Result<(), String> {
    let process = {
        let mut guard = slidev_store().lock().unwrap();
        guard.remove(&file_path)
    };
    if let Some(process) = process {
        let kill_result = kill_process(process.pid);
        let _ = fs::remove_dir_all(&process.temp_dir);
        kill_result?;
    }
    Ok(())
}

#[tauri::command]
pub async fn slidev_get_temp_dir(file_path: String) -> Result<String, String> {
    let guard = slidev_store().lock().unwrap();
    let process = guard
        .get(&file_path)
        .ok_or_else(|| format!("No slidev process found for: {}", file_path))?;

    Ok(process.temp_dir.to_string_lossy().to_string())
}

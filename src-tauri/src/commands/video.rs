use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};

/// Derive the sidecar `.video.json` path from a markdown file path.
fn video_json_path(md_path: &str) -> PathBuf {
    let p = std::path::Path::new(md_path);
    let stem = p.file_stem().unwrap_or_default();
    let mut out = p.to_path_buf();
    out.set_file_name(format!("{}.video.json", stem.to_string_lossy()));
    out
}

#[tauri::command]
pub async fn video_save_project(md_path: String, project_json: String) -> Result<(), String> {
    let json_path = video_json_path(&md_path);
    fs::write(&json_path, &project_json)
        .map_err(|e| format!("Failed to save video project: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn video_load_project(md_path: String) -> Result<Option<String>, String> {
    let json_path = video_json_path(&md_path);
    if json_path.exists() {
        let content = fs::read_to_string(&json_path)
            .map_err(|e| format!("Failed to read video project: {}", e))?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

fn hash_string(s: &str) -> String {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[tauri::command]
pub async fn video_save_audio(audio_bytes: Vec<u8>) -> Result<serde_json::Value, String> {
    let temp_dir = std::env::temp_dir().join("mdium-video").join("audio");
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Generate unique filename using hash of current time + data length
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seed = format!("{}{}", now.as_nanos(), audio_bytes.len());
    let hash = hash_string(&seed);
    let file_path: PathBuf = temp_dir.join(format!("{}.wav", hash));

    fs::write(&file_path, &audio_bytes)
        .map_err(|e| format!("Failed to write audio file: {}", e))?;

    // Parse WAV header to get duration
    let duration_ms = if audio_bytes.len() >= 44 {
        let sample_rate = u32::from_le_bytes([
            audio_bytes[24],
            audio_bytes[25],
            audio_bytes[26],
            audio_bytes[27],
        ]);
        let channels = u16::from_le_bytes([audio_bytes[22], audio_bytes[23]]);
        let bits_per_sample = u16::from_le_bytes([audio_bytes[34], audio_bytes[35]]);
        let data_size = u32::from_le_bytes([
            audio_bytes[40],
            audio_bytes[41],
            audio_bytes[42],
            audio_bytes[43],
        ]);

        if sample_rate > 0 && channels > 0 && bits_per_sample > 0 {
            let bytes_per_sample = (bits_per_sample / 8) as u32;
            let total_samples = data_size / (bytes_per_sample * channels as u32);
            (total_samples as u64 * 1000 / sample_rate as u64) as u64
        } else {
            0
        }
    } else {
        0
    };

    Ok(serde_json::json!({
        "path": file_path.to_string_lossy(),
        "durationMs": duration_ms
    }))
}

#[tauri::command]
pub async fn video_clean_temp() -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join("mdium-video");
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to remove temp dir: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn video_copy_images(
    source_paths: Vec<String>,
    dest_dir: String,
) -> Result<(), String> {
    let dest = std::path::Path::new(&dest_dir);
    fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dest dir: {}", e))?;

    for src_str in &source_paths {
        let src = std::path::Path::new(src_str);
        let filename = src
            .file_name()
            .ok_or_else(|| format!("Invalid source path (no filename): {}", src_str))?;
        let dest_path = dest.join(filename);
        fs::copy(src, &dest_path)
            .map_err(|e| format!("Failed to copy {} to {}: {}", src_str, dest_path.display(), e))?;
    }

    Ok(())
}

/// Recursively copy a directory
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create dir {}: {}", dst.display(), e))?;
    for entry in fs::read_dir(src)
        .map_err(|e| format!("Failed to read dir {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let dest_path = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), &dest_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }
    Ok(())
}

fn open_motion_dir_valid(dir: &PathBuf) -> bool {
    dir.join("core").join("src").join("index.tsx").exists()
}

#[tauri::command]
pub async fn video_export(
    app: AppHandle,
    project_json: String,
    output_path: String,
    fps: u32,
    concurrency: u32,
    format: String,
) -> Result<String, String> {
    // Validate format
    let format = match format.as_str() {
        "mp4" | "webm" => format,
        _ => return Err(format!("Unsupported video format: {}", format)),
    };

    let temp_base = std::env::temp_dir().join("mdium-video");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let temp_dir = temp_base.join(format!("render-{}", now.as_millis()));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Locate video-env resources
    let video_env_dir = {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;
        let prod_path = resource_dir.join("resources").join("video-env");
        if prod_path.join("package.json").exists() {
            prod_path
        } else {
            let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("resources")
                .join("video-env");
            if dev_path.join("package.json").exists() {
                dev_path
            } else {
                return Err(format!(
                    "Video environment not found. Checked:\n  {}\n  {}",
                    prod_path.display(),
                    dev_path.display()
                ));
            }
        }
    };

    // Locate vendored open-motion packages
    let open_motion_dir = {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("packages")
            .join("open-motion");
        if open_motion_dir_valid(&dev_path) {
            dev_path
        } else {
            let resource_dir = app
                .path()
                .resource_dir()
                .map_err(|e| format!("Failed to get resource dir: {}", e))?;
            resource_dir.join("resources").join("open-motion")
        }
    };

    // Locate mdium video feature source files
    let video_feature_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("src")
        .join("features")
        .join("video");

    // Write project.json
    fs::write(temp_dir.join("project.json"), &project_json)
        .map_err(|e| format!("Failed to write project.json: {}", e))?;

    // Copy template files from video-env
    let template_dir = video_env_dir.join("template");
    if template_dir.exists() {
        copy_dir_recursive(&template_dir, &temp_dir)?;
    }

    // Copy vendored open-motion packages
    let om_dest = temp_dir.join("open-motion");
    copy_dir_recursive(&open_motion_dir, &om_dest)?;
    let _ = fs::remove_dir_all(om_dest.join("core").join("node_modules"));
    let _ = fs::remove_dir_all(om_dest.join("components").join("node_modules"));

    // Copy scene-to-composition.tsx and types.ts into temp src/
    let src_dir = temp_dir.join("src");
    fs::create_dir_all(&src_dir)
        .map_err(|e| format!("Failed to create src dir: {}", e))?;

    let composition_src = video_feature_dir.join("lib").join("scene-to-composition.tsx");
    if composition_src.exists() {
        fs::copy(&composition_src, src_dir.join("scene-to-composition.tsx"))
            .map_err(|e| format!("Failed to copy scene-to-composition.tsx: {}", e))?;
    }
    let types_src = video_feature_dir.join("types.ts");
    if types_src.exists() {
        fs::copy(&types_src, src_dir.join("types.ts"))
            .map_err(|e| format!("Failed to copy types.ts: {}", e))?;
    }

    // Copy video-env package.json
    fs::copy(video_env_dir.join("package.json"), temp_dir.join("package.json"))
        .map_err(|e| format!("Failed to copy package.json: {}", e))?;

    // npm install
    let _ = app.emit("video-progress", serde_json::json!({
        "phase": "setup", "percent": 0, "message": "Installing dependencies..."
    }));

    let npm = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
    let lock_file = temp_dir.join("node_modules").join(".package-lock.json");
    if !lock_file.exists() {
        let install_output = Command::new(npm)
            .args(["install", "--prefer-offline"])
            .current_dir(&temp_dir)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("Failed to run npm install: {}", e))?;

        if !install_output.status.success() {
            let stderr = String::from_utf8_lossy(&install_output.stderr);
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(format!("npm install failed: {}", stderr));
        }
    }

    // Link vendored @open-motion packages into node_modules so Node can resolve them
    let nm_om = temp_dir.join("node_modules").join("@open-motion");
    fs::create_dir_all(&nm_om)
        .map_err(|e| format!("Failed to create @open-motion dir: {}", e))?;
    for pkg in &["core", "renderer", "encoder", "components"] {
        let src = temp_dir.join("open-motion").join(pkg);
        let dest = nm_om.join(pkg);
        if src.exists() && !dest.exists() {
            copy_dir_recursive(&src, &dest)?;
        }
    }

    // Run render script
    let _ = app.emit("video-progress", serde_json::json!({
        "phase": "render", "percent": 0, "message": "Starting video render..."
    }));

    let render_script = video_env_dir.join("render-video.mjs");
    let npx = if cfg!(target_os = "windows") { "npx.cmd" } else { "npx" };

    let app_clone = app.clone();
    let temp_dir_clone = temp_dir.clone();
    let output_path_clone = output_path.clone();

    let render_result = tokio::task::spawn_blocking(move || {
        let temp_dir_str = temp_dir_clone.to_string_lossy().to_string();

        #[cfg(target_os = "windows")]
        let mut child = {
            use std::os::windows::process::CommandExt;
            Command::new(npx)
                .args([
                    "tsx",
                    render_script.to_string_lossy().as_ref(),
                    &temp_dir_str,
                    &output_path_clone,
                    "--fps", &fps.to_string(),
                    "--concurrency", &concurrency.to_string(),
                    "--format", &format,
                ])
                .current_dir(&temp_dir_clone)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|e| format!("Failed to spawn render process: {}", e))?
        };

        #[cfg(not(target_os = "windows"))]
        let mut child = {
            Command::new(npx)
                .args([
                    "tsx",
                    render_script.to_string_lossy().as_ref(),
                    &temp_dir_str,
                    &output_path_clone,
                    "--fps", &fps.to_string(),
                    "--concurrency", &concurrency.to_string(),
                    "--format", &format,
                ])
                .current_dir(&temp_dir_clone)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to spawn render process: {}", e))?
        };

        // Read stdout for progress JSON lines
        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                    let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match msg_type {
                        "progress" | "status" => {
                            let _ = app_clone.emit("video-progress", &json);
                        }
                        "error" => {
                            let err_msg = json
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("Unknown error");
                            return Err(err_msg.to_string());
                        }
                        "done" => {
                            let _ = app_clone.emit("video-progress", serde_json::json!({
                                "phase": "done", "percent": 100
                            }));
                        }
                        _ => {}
                    }
                }
            }
        }

        let status = child.wait().map_err(|e| format!("Render process error: {}", e))?;
        if !status.success() {
            return Err("Video render process failed".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Render task panicked: {}", e))?;

    // Clean up temp dir
    let _ = fs::remove_dir_all(&temp_dir);

    render_result?;
    Ok(output_path)
}

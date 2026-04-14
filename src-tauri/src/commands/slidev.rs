use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

struct SlidevProcess {
    pid: u32,
    port: u16,
    temp_dir: PathBuf,
}

type SlidevMap = Arc<Mutex<HashMap<String, SlidevProcess>>>;

static SLIDEV_MAP: OnceLock<SlidevMap> = OnceLock::new();
static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn slidev_store() -> &'static SlidevMap {
    SLIDEV_MAP.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn install_lock() -> &'static Mutex<()> {
    INSTALL_LOCK.get_or_init(|| Mutex::new(()))
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


/// Rewrite bare relative image paths so Slidev/Vite can resolve them.
///
/// Slidev compiles markdown images into Vite `import` statements. Vite treats any
/// path that does not start with `./`, `../`, or `/` as a bare module specifier
/// (like `import x from 'lodash'`), so `![alt](images/foo.png)` triggers a
/// "Failed to resolve import" error and blocks the slide from rendering. We
/// prepend `./` so Vite treats the path as a local file reference.
fn rewrite_image_paths(markdown: &str) -> String {
    let mut result = String::with_capacity(markdown.len() + 16);
    let mut in_fence = false;
    for line in markdown.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            result.push_str(line);
            continue;
        }
        if in_fence {
            result.push_str(line);
            continue;
        }
        rewrite_line_images(line, &mut result);
    }
    result
}

fn rewrite_line_images(line: &str, out: &mut String) {
    let mut remaining = line;
    loop {
        let Some(bang_pos) = remaining.find("![") else {
            out.push_str(remaining);
            return;
        };
        out.push_str(&remaining[..bang_pos]);
        let after_bang = &remaining[bang_pos..];
        let Some(close_bracket) = after_bang.find("](") else {
            out.push_str(after_bang);
            return;
        };
        let url_start = close_bracket + 2;
        let Some(paren_offset) = after_bang[url_start..].find(')') else {
            out.push_str(after_bang);
            return;
        };
        let url_end = url_start + paren_offset;
        let url_and_title = &after_bang[url_start..url_end];
        let (url, title) = match url_and_title.split_once(char::is_whitespace) {
            Some((u, t)) => (u, Some(t)),
            None => (url_and_title, None),
        };
        let alt = &after_bang[2..close_bracket];
        out.push_str("![");
        out.push_str(alt);
        out.push_str("](");
        if needs_relative_prefix(url) {
            out.push_str("./");
        }
        out.push_str(url);
        if let Some(t) = title {
            out.push(' ');
            out.push_str(t);
        }
        out.push(')');
        remaining = &after_bang[url_end + 1..];
    }
}

fn needs_relative_prefix(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    if path.starts_with("./") || path.starts_with("../") {
        return false;
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    if path.starts_with('#') {
        return false;
    }
    if path.starts_with("data:") {
        return false;
    }
    if path.contains("://") {
        return false;
    }
    // Windows absolute path like "C:\" or "C:/"
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
    {
        return false;
    }
    true
}

/// Extract theme name from Slidev markdown frontmatter
fn extract_theme(markdown: &str) -> Option<String> {
    let content = markdown.strip_prefix("---\n")
        .or_else(|| markdown.strip_prefix("---\r\n"))?;
    let end = content.find("\n---")?;
    let frontmatter = &content[..end];
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("theme:") {
            let theme = value.trim().trim_matches(|c| c == '"' || c == '\'');
            if !theme.is_empty() {
                return Some(theme.to_string());
            }
        }
    }
    None
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

/// Resolve the bundled slidev-env directory (contains package.json only)
fn resolve_slidev_env_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let prod_path = resource_dir.join("resources").join("slidev-env");
    if prod_path.join("package.json").exists() {
        return Ok(prod_path);
    }
    // Dev mode: resources are relative to the Tauri project root
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("resources")
        .join("slidev-env");
    if dev_path.join("package.json").exists() {
        return Ok(dev_path);
    }
    Err(format!(
        "Slidev environment not found. Checked:\n  {}\n  {}",
        prod_path.display(),
        dev_path.display()
    ))
}

/// Read the "dependencies" field from a package.json as a string for comparison
fn read_dependencies_json(package_json_path: &std::path::Path) -> Result<String, String> {
    let content = fs::read_to_string(package_json_path)
        .map_err(|e| format!("Failed to read {}: {}", package_json_path.display(), e))?;
    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", package_json_path.display(), e))?;
    let deps = parsed.get("dependencies").cloned().unwrap_or(serde_json::Value::Null);
    Ok(deps.to_string())
}

/// Ensure Slidev packages are installed in AppData.
/// Returns the path to the AppData slidev-env directory.
fn ensure_slidev_installed(app: &AppHandle) -> Result<PathBuf, String> {
    // Prevent concurrent npm install from multiple Slidev sessions
    let _guard = install_lock().lock().unwrap();

    let slidev_env_dir = resolve_slidev_env_dir(app)?;
    let bundled_package_json = slidev_env_dir.join("package.json");
    let bundled_lock = slidev_env_dir.join("package-lock.json");

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let install_dir = app_data_dir.join("slidev-env");
    let installed_package_json = install_dir.join("package.json");
    let installed_cli = install_dir.join("node_modules").join("@slidev").join("cli").join("package.json");

    // Check if install is needed
    let needs_install = if !installed_package_json.exists() || !installed_cli.exists() {
        true
    } else {
        let bundled_deps = read_dependencies_json(&bundled_package_json)?;
        let installed_deps = read_dependencies_json(&installed_package_json)?;
        bundled_deps != installed_deps
    };

    if !needs_install {
        return Ok(install_dir);
    }

    // Emit install start event
    let _ = app.emit("slidev-install-start", serde_json::json!({}));

    // Prepare install directory
    fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create install dir: {}", e))?;

    // Copy package.json and package-lock.json from bundled resources
    fs::copy(&bundled_package_json, &installed_package_json)
        .map_err(|e| format!("Failed to copy package.json: {}", e))?;
    if bundled_lock.exists() {
        fs::copy(&bundled_lock, install_dir.join("package-lock.json"))
            .map_err(|e| format!("Failed to copy package-lock.json: {}", e))?;
    }

    // Run npm install
    let npm = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
    let mut npm_cmd = Command::new(npm);
    npm_cmd
        .args(["install"])
        .current_dir(&install_dir)
        .stdin(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    npm_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = npm_cmd
        .output()
        .map_err(|e| {
            let msg = format!("Failed to run npm install: {}. If you are behind a proxy, set HTTP_PROXY environment variable or run 'npm config set proxy <url>'.", e);
            let _ = app.emit("slidev-install-error", serde_json::json!({ "message": msg }));
            msg
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let msg = format!(
            "npm install failed: {}. If you are behind a proxy, set HTTP_PROXY environment variable or run 'npm config set proxy <url>'.",
            stderr
        );
        let _ = app.emit("slidev-install-error", serde_json::json!({ "message": msg }));
        // Clean up failed install so next attempt re-tries
        let _ = fs::remove_file(&installed_package_json);
        return Err(msg);
    }

    // Emit install complete event
    let _ = app.emit("slidev-install-complete", serde_json::json!({}));

    Ok(install_dir)
}

/// Create a directory junction (Windows) or symlink (Unix) for node_modules.
///
/// On Windows, uses the native `junction` crate (NTFS reparse points) instead of
/// shelling out to `cmd /C mklink /J`. The shell approach had two problems on
/// Japanese Windows: mklink's stderr is emitted in CP932 and came back as
/// mojibake after `from_utf8_lossy`, and `let _ = fs::remove_dir(dest)` silently
/// masked cleanup failures so a stale directory at `dest` surfaced as "mklink /J
/// failed" with unreadable text. The native path returns proper UTF-8
/// `io::Error`s and lets us handle each dest state explicitly.
fn create_node_modules_link(source: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        clear_junction_dest(dest)?;
        junction::create(source, dest)
            .map_err(|e| format!("Failed to create junction at {}: {}", dest.display(), e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On Unix, remove any stale symlink or file at dest first.
        if dest.symlink_metadata().is_ok() {
            fs::remove_file(dest)
                .map_err(|e| format!("Failed to remove stale link at {}: {}", dest.display(), e))?;
        }
        std::os::unix::fs::symlink(source, dest)
            .map_err(|e| format!("Failed to create symlink: {}", e))?;
    }

    Ok(())
}

/// Clear whatever is occupying `dest` so `junction::create` can succeed.
/// Handles: nothing there, an existing junction (removed without following),
/// an empty or non-empty real directory, or a regular file.
#[cfg(target_os = "windows")]
fn clear_junction_dest(dest: &std::path::Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;

    // `symlink_metadata` does not follow reparse points, so a junction reports
    // its own attributes rather than those of its target.
    let meta = match fs::symlink_metadata(dest) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Failed to stat {}: {}", dest.display(), e)),
    };

    // Inspect raw Win32 attributes. Rust's `Metadata::is_dir` returns false for
    // a junction (it treats any reparse point as a symlink, not a dir), so we
    // check `FILE_ATTRIBUTE_DIRECTORY` directly to distinguish a directory-like
    // entry from a regular file.
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let attrs = meta.file_attributes();
    let is_directory_entry = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
    let is_reparse_point = attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0;

    if is_reparse_point {
        // Junction or directory symlink — `RemoveDirectoryW` removes the
        // reparse point without following into its target. `remove_dir_all`
        // WOULD follow the junction and delete real files, so never use it.
        fs::remove_dir(dest).map_err(|e| {
            format!("Failed to remove stale junction at {}: {}", dest.display(), e)
        })?;
    } else if is_directory_entry {
        fs::remove_dir_all(dest)
            .map_err(|e| format!("Failed to remove directory at {}: {}", dest.display(), e))?;
    } else {
        fs::remove_file(dest)
            .map_err(|e| format!("Failed to remove file at {}: {}", dest.display(), e))?;
    }
    Ok(())
}

/// Kill a process by PID (platform-specific)
fn kill_process(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
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
            // Remove junction/symlink first so remove_dir_all cannot follow it
            // into the AppData node_modules and delete real files there.
            // On Windows, fs::remove_dir removes a junction without following
            // it (RemoveDirectoryW semantics).
            let nm_link = existing.temp_dir.join("node_modules");
            #[cfg(target_os = "windows")]
            {
                let _ = fs::remove_dir(&nm_link);
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = fs::remove_file(&nm_link);
            }
            let _ = fs::remove_dir_all(&existing.temp_dir);
        }
    }

    // Create temp directory structure
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    fs::create_dir_all(temp_dir.join("public").join("images"))
        .map_err(|e| format!("Failed to create public/images dir: {}", e))?;

    // Ensure Slidev is installed in AppData (run in blocking thread to avoid starving async runtime)
    let app_clone = app.clone();
    let install_dir = tokio::task::spawn_blocking(move || {
        ensure_slidev_installed(&app_clone)
    })
    .await
    .map_err(|e| format!("Install task panicked: {}", e))??;

    // Write slides.md first (needed for theme detection)
    let slides_path = temp_dir.join("slides.md");
    let processed_markdown = rewrite_image_paths(&markdown);
    fs::write(&slides_path, &processed_markdown)
        .map_err(|e| format!("Failed to write slides.md: {}", e))?;

    // Copy asset files (images, etc.) from source directory to temp directory
    if let Some(source_dir) = PathBuf::from(&file_path).parent() {
        if source_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(source_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    // Skip markdown files, node_modules, and hidden entries
                    if name.ends_with(".md")
                        || name == "node_modules"
                        || name.starts_with('.')
                    {
                        continue;
                    }
                    let dest = temp_dir.join(&name);
                    if dest.exists() {
                        continue; // don't overwrite existing (e.g. public/)
                    }
                    if entry.path().is_dir() {
                        let _ = copy_dir_recursive(&entry.path(), &dest);
                    } else {
                        let _ = fs::copy(entry.path(), &dest);
                    }
                }
            }
        }
    }

    // Extract theme name from frontmatter (default: "default")
    let theme = extract_theme(&markdown).unwrap_or_else(|| "default".to_string());
    let theme_package = if theme.contains('/') {
        theme.clone() // scoped package like @org/theme
    } else {
        format!("@slidev/theme-{}", theme)
    };

    // Copy package.json from AppData install dir
    fs::copy(install_dir.join("package.json"), temp_dir.join("package.json"))
        .map_err(|e| format!("Failed to copy package.json: {}", e))?;

    // Create junction/symlink to AppData node_modules
    let node_modules_source = install_dir.join("node_modules");
    let node_modules_dest = temp_dir.join("node_modules");
    create_node_modules_link(&node_modules_source, &node_modules_dest)?;

    // Install non-default theme if not already present
    let theme_dir = node_modules_source.join(&theme_package);
    if !theme_dir.exists() {
        let npm = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
        let mut npm_cmd = Command::new(npm);
        npm_cmd.args(["install", "--prefer-offline", &theme_package])
            .current_dir(&install_dir)
            .stdin(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        npm_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let _ = npm_cmd.output();
    }

    // Find available port
    let port = find_available_port()?;

    // Spawn slidev dev server
    let npx = if cfg!(target_os = "windows") {
        "npx.cmd"
    } else {
        "npx"
    };

    let temp_dir_str = temp_dir.to_string_lossy().to_string();

    // Slidev v51: `slidev [entry]` is the default command (no `dev` subcommand)
    // Default entry is slides.md, so no need to pass it explicitly
    let stderr_log = temp_dir.join("slidev-stderr.log");
    let stderr_file = fs::File::create(&stderr_log)
        .map_err(|e| format!("Failed to create stderr log: {}", e))?;
    let stdout_log = temp_dir.join("slidev-stdout.log");
    let stdout_file = fs::File::create(&stdout_log)
        .map_err(|e| format!("Failed to create stdout log: {}", e))?;

    #[cfg(target_os = "windows")]
    let child = {
        use std::os::windows::process::CommandExt;
        Command::new(npx)
            .args([
                "slidev",
                "--port",
                &port.to_string(),
                "--open",
                "false",
            ])
            .current_dir(&temp_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(stdout_file))
            .stderr(std::process::Stdio::from(stderr_file))
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Failed to spawn slidev: {}", e))?
    };

    #[cfg(not(target_os = "windows"))]
    let child = {
        Command::new(npx)
            .args([
                "slidev",
                "--port",
                &port.to_string(),
                "--open",
                "false",
            ])
            .current_dir(&temp_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(stdout_file))
            .stderr(std::process::Stdio::from(stderr_file))
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
        let url = format!("http://localhost:{}", port);
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

    let processed_markdown = rewrite_image_paths(&markdown);
    fs::write(&slides_path, &processed_markdown)
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
        // Remove junction/symlink first so remove_dir_all cannot follow it
        // into the AppData node_modules and delete real files there.
        // On Windows, fs::remove_dir removes a junction without following it.
        let nm_link = process.temp_dir.join("node_modules");
        #[cfg(target_os = "windows")]
        {
            let _ = fs::remove_dir(&nm_link);
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = fs::remove_file(&nm_link);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_bare_relative_image_path() {
        let md = "![alt](images/foo.png)";
        assert_eq!(rewrite_image_paths(md), "![alt](./images/foo.png)");
    }

    #[test]
    fn rewrites_same_directory_image() {
        let md = "![](foo.png)";
        assert_eq!(rewrite_image_paths(md), "![](./foo.png)");
    }

    #[test]
    fn preserves_already_relative_path() {
        let md = "![a](./images/foo.png)";
        assert_eq!(rewrite_image_paths(md), md);
    }

    #[test]
    fn preserves_parent_relative_path() {
        let md = "![a](../images/foo.png)";
        assert_eq!(rewrite_image_paths(md), md);
    }

    #[test]
    fn preserves_absolute_path() {
        let md = "![a](/images/foo.png)";
        assert_eq!(rewrite_image_paths(md), md);
    }

    #[test]
    fn preserves_http_url() {
        let md = "![a](https://example.com/foo.png)";
        assert_eq!(rewrite_image_paths(md), md);
    }

    #[test]
    fn preserves_data_uri() {
        let md = "![a](data:image/png;base64,iVBOR)";
        assert_eq!(rewrite_image_paths(md), md);
    }

    #[test]
    fn preserves_windows_absolute_path() {
        let md = "![a](C:/Users/me/foo.png)";
        assert_eq!(rewrite_image_paths(md), md);
    }

    #[test]
    fn rewrites_with_title() {
        let md = "![a](images/foo.png \"title\")";
        assert_eq!(rewrite_image_paths(md), "![a](./images/foo.png \"title\")");
    }

    #[test]
    fn skips_fenced_code_block() {
        let md = "```md\n![a](images/foo.png)\n```\n";
        assert_eq!(rewrite_image_paths(md), md);
    }

    #[test]
    fn rewrites_multiple_images_on_one_line() {
        let md = "![a](images/a.png) and ![b](images/b.png)";
        assert_eq!(
            rewrite_image_paths(md),
            "![a](./images/a.png) and ![b](./images/b.png)"
        );
    }

    #[test]
    fn preserves_plain_text_without_images() {
        let md = "# Title\n\nSome text with (parens) and ![\n";
        assert_eq!(rewrite_image_paths(md), md);
    }

    #[test]
    fn preserves_frontmatter_and_rewrites_body() {
        let md = "---\ntheme: default\n---\n\n# Hi\n\n![a](images/foo.png)\n";
        let expected = "---\ntheme: default\n---\n\n# Hi\n\n![a](./images/foo.png)\n";
        assert_eq!(rewrite_image_paths(md), expected);
    }

    #[test]
    fn handles_unicode_alt_text() {
        let md = "![画像](images/図.png)";
        assert_eq!(rewrite_image_paths(md), "![画像](./images/図.png)");
    }

    #[cfg(target_os = "windows")]
    mod junction_tests {
        use super::super::create_node_modules_link;
        use std::fs;
        use std::sync::atomic::{AtomicU32, Ordering};

        static COUNTER: AtomicU32 = AtomicU32::new(0);

        fn unique_temp_root(tag: &str) -> std::path::PathBuf {
            let id = COUNTER.fetch_add(1, Ordering::SeqCst);
            let root = std::env::temp_dir().join(format!(
                "mdium-junction-test-{}-{}-{}",
                tag,
                std::process::id(),
                id
            ));
            // Clean any leftover from previous runs. Remove the junction first if it
            // exists, so remove_dir_all doesn't follow it into the real target.
            let dest = root.join("dst");
            let _ = fs::remove_dir(&dest);
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            root
        }

        #[test]
        fn creates_junction_to_source() {
            let root = unique_temp_root("create");
            let source = root.join("src");
            let dest = root.join("dst");
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join("marker.txt"), "hello").unwrap();

            create_node_modules_link(&source, &dest).expect("should create junction");

            assert!(
                dest.join("marker.txt").exists(),
                "junction should expose source contents"
            );

            let _ = fs::remove_dir(&dest);
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn replaces_existing_junction() {
            let root = unique_temp_root("replace");
            let source_a = root.join("src_a");
            let source_b = root.join("src_b");
            let dest = root.join("dst");
            fs::create_dir_all(&source_a).unwrap();
            fs::create_dir_all(&source_b).unwrap();
            fs::write(source_a.join("a.txt"), "a").unwrap();
            fs::write(source_b.join("b.txt"), "b").unwrap();

            create_node_modules_link(&source_a, &dest).expect("first link");
            assert!(dest.join("a.txt").exists());

            create_node_modules_link(&source_b, &dest).expect("replace link");
            assert!(
                dest.join("b.txt").exists(),
                "should now point at source_b"
            );
            assert!(
                !dest.join("a.txt").exists(),
                "old source_a marker must not leak through"
            );

            let _ = fs::remove_dir(&dest);
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn replaces_stale_file_at_dest() {
            // Regression for the "mklink /J failed: ���a������..." report:
            // a stale regular file at dest (from an interrupted prior run) used
            // to crash junction creation with mojibake. The fix removes the
            // stale file and re-creates the junction.
            let root = unique_temp_root("replace-file");
            let source = root.join("src");
            let dest = root.join("dst");
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join("marker.txt"), "fresh").unwrap();
            fs::write(&dest, b"leftover").unwrap();

            create_node_modules_link(&source, &dest)
                .expect("should replace stale file at dest with a junction");

            assert!(dest.join("marker.txt").exists());

            let _ = fs::remove_dir(&dest);
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn error_message_is_readable_utf8() {
            // If junction creation fails, the error string must be readable
            // UTF-8 — never mojibake from CP932-encoded cmd.exe output on
            // Japanese Windows. Trigger failure via a path that cannot be
            // created (parent directory does not exist).
            let root = unique_temp_root("err-utf8");
            let source = root.join("src");
            fs::create_dir_all(&source).unwrap();
            let dest = root.join("missing-parent").join("dst");

            let err = create_node_modules_link(&source, &dest)
                .expect_err("should fail when parent of dest does not exist");

            assert!(
                !err.contains('\u{FFFD}'),
                "error message contains UTF-8 replacement char (mojibake): {:?}",
                err
            );

            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn replaces_non_empty_real_directory() {
            // If a previous unclean shutdown left a non-empty directory at dest
            // (e.g., files written after remove_dir_all partially followed a
            // junction), the next slidev_start must still be able to re-link.
            let root = unique_temp_root("replace-nonempty");
            let source = root.join("src");
            let dest = root.join("dst");
            fs::create_dir_all(&source).unwrap();
            fs::create_dir_all(&dest).unwrap();
            fs::write(dest.join("stale.txt"), "leftover").unwrap();
            fs::write(source.join("marker.txt"), "fresh").unwrap();

            create_node_modules_link(&source, &dest)
                .expect("should replace non-empty real directory with a junction");

            assert!(dest.join("marker.txt").exists());
            assert!(
                !dest.join("stale.txt").exists(),
                "stale file must be gone after re-linking"
            );

            let _ = fs::remove_dir(&dest);
            let _ = fs::remove_dir_all(&root);
        }

        #[test]
        fn replaces_empty_real_directory() {
            let root = unique_temp_root("replace-dir");
            let source = root.join("src");
            let dest = root.join("dst");
            fs::create_dir_all(&source).unwrap();
            fs::create_dir_all(&dest).unwrap();
            fs::write(source.join("marker.txt"), "hi").unwrap();

            create_node_modules_link(&source, &dest)
                .expect("should replace empty real directory with a junction");

            assert!(dest.join("marker.txt").exists());

            let _ = fs::remove_dir(&dest);
            let _ = fs::remove_dir_all(&root);
        }
    }
}

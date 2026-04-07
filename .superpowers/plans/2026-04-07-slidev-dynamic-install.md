# Slidev Dynamic npm Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Slidev node_modules (~413MB) from the app bundle and install them dynamically via `npm install` on first use, reducing build size and build time.

**Architecture:** The bundled `resources/slidev-env/` will only contain `package.json` and `package-lock.json`. On first Slidev preview, the Rust backend checks `%APPDATA%/com.mdium.app/slidev-env/` for an existing install, compares dependency versions, and runs `npm install` if needed. Temp directories use Windows junctions / Unix symlinks to reference the AppData node_modules instead of copying.

**Tech Stack:** Rust (Tauri backend), React/TypeScript (frontend), npm (package management)

---

### Task 1: Update `tauri.conf.json` bundle resources

**Files:**
- Modify: `src-tauri/tauri.conf.json:33`

- [ ] **Step 1: Change slidev-env resource pattern**

Replace the wildcard glob with explicit file paths:

```json
"resources": [
  "../resources/slidev-env/package.json",
  "../resources/slidev-env/package-lock.json",
  "../resources/mcp-servers/**/*",
  "../resources/video-env/**/*",
  "../resources/lottie-presets/**/*",
  "../packages/open-motion/core/**/*",
  "../packages/open-motion/components/**/*",
  "../packages/open-motion/renderer/**/*",
  "../packages/open-motion/encoder/**/*",
  "../packages/open-motion/LICENSE",
  "../src/features/video/lib/composition/**/*",
  "../src/features/video/types.ts"
]
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "chore(slidev): bundle only package.json instead of node_modules"
```

---

### Task 2: Implement `ensure_slidev_installed` in Rust

**Files:**
- Modify: `src-tauri/src/commands/slidev.rs`

- [ ] **Step 1: Add `ensure_slidev_installed` function**

Add this function after the existing `copy_dir_recursive` function (after line 76). This function:
1. Resolves the bundled `package.json` location (same logic as existing `slidev_env_dir` resolution)
2. Resolves the AppData install directory
3. Compares dependency versions
4. Runs `npm install` if needed, emitting progress events

```rust
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
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/commands/slidev.rs
git commit -m "feat(slidev): add ensure_slidev_installed for dynamic npm install"
```

---

### Task 3: Add junction/symlink helper function

**Files:**
- Modify: `src-tauri/src/commands/slidev.rs`

- [ ] **Step 1: Add `create_node_modules_link` function**

Add this function after `ensure_slidev_installed`:

```rust
/// Create a directory junction (Windows) or symlink (Unix) for node_modules.
/// On Windows, uses `mklink /J` which does not require admin privileges.
fn create_node_modules_link(source: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    // Remove existing link or directory if present
    if dest.exists() || dest.read_link().is_ok() {
        #[cfg(target_os = "windows")]
        {
            // Junction removal: use fs::remove_dir (does not follow junction)
            let _ = fs::remove_dir(dest);
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = fs::remove_file(dest);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let output = Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &dest.to_string_lossy(),
                &source.to_string_lossy(),
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| format!("Failed to create junction: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("mklink /J failed: {}", stderr));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::os::unix::fs::symlink(source, dest)
            .map_err(|e| format!("Failed to create symlink: {}", e))?;
    }

    Ok(())
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/commands/slidev.rs
git commit -m "feat(slidev): add cross-platform junction/symlink helper"
```

---

### Task 4: Rewrite `slidev_start` to use dynamic install

**Files:**
- Modify: `src-tauri/src/commands/slidev.rs:110-372`

- [ ] **Step 1: Replace the node_modules setup section in `slidev_start`**

Replace the entire `slidev_start` function body. The key changes are:
1. Call `ensure_slidev_installed()` instead of resolving bundled node_modules
2. Use junction/symlink instead of `copy_dir_recursive`
3. Remove inline `slidev_env_dir` resolution (now handled by `resolve_slidev_env_dir`)

Replace lines 110-372 with:

```rust
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

    // Ensure Slidev is installed in AppData
    let install_dir = ensure_slidev_installed(&app)?;

    // Create temp directory structure
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    fs::create_dir_all(temp_dir.join("public").join("images"))
        .map_err(|e| format!("Failed to create public/images dir: {}", e))?;

    // Write slides.md first (needed for theme detection)
    let slides_path = temp_dir.join("slides.md");
    fs::write(&slides_path, &markdown)
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
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/commands/slidev.rs
git commit -m "refactor(slidev): use dynamic install and junction instead of bundled node_modules copy"
```

---

### Task 5: Clean up temp directory junction on `slidev_stop`

**Files:**
- Modify: `src-tauri/src/commands/slidev.rs` (the `slidev_stop` function)

- [ ] **Step 1: Update `slidev_stop` to handle junction removal**

The current `fs::remove_dir_all` will follow the junction and delete the AppData node_modules. We need to remove the junction first, then clean up the rest of the temp dir.

Replace the `slidev_stop` function:

```rust
#[tauri::command]
pub async fn slidev_stop(file_path: String) -> Result<(), String> {
    let process = {
        let mut guard = slidev_store().lock().unwrap();
        guard.remove(&file_path)
    };
    if let Some(process) = process {
        let kill_result = kill_process(process.pid);
        // Remove junction/symlink first to avoid deleting AppData node_modules
        let nm_link = process.temp_dir.join("node_modules");
        #[cfg(target_os = "windows")]
        {
            // fs::remove_dir removes a junction without following it
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
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/commands/slidev.rs
git commit -m "fix(slidev): remove junction before temp dir cleanup to protect AppData"
```

---

### Task 6: Add i18n keys for install progress

**Files:**
- Modify: `src/shared/i18n/locales/en/editor.json`
- Modify: `src/shared/i18n/locales/ja/editor.json`

- [ ] **Step 1: Add English translations**

Add these keys after the existing `slidevRetry` key:

```json
"slidevInstalling": "Installing Slidev environment...",
"slidevInstallError": "Failed to install Slidev environment",
"slidevInstallProxyHint": "If you are behind a proxy, set HTTP_PROXY environment variable or run 'npm config set proxy <url>'."
```

- [ ] **Step 2: Add Japanese translations**

Add these keys after the existing `slidevRetry` key:

```json
"slidevInstalling": "Slidev 環境をインストール中...",
"slidevInstallError": "Slidev 環境のインストールに失敗しました",
"slidevInstallProxyHint": "プロキシ環境の場合は HTTP_PROXY 環境変数を設定するか、'npm config set proxy <url>' を実行してください。"
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/en/editor.json src/shared/i18n/locales/ja/editor.json
git commit -m "feat(i18n): add Slidev install progress translation keys"
```

---

### Task 7: Update `SlidevPreviewPanel` to show install progress

**Files:**
- Modify: `src/features/preview/components/SlidevPreviewPanel.tsx`

- [ ] **Step 1: Add install state and event listeners**

Add an `installing` state variable alongside the existing `starting` state (after line 19):

```typescript
const [installing, setInstalling] = useState(false);
const [installError, setInstallError] = useState<string | null>(null);
```

- [ ] **Step 2: Add install event listeners**

Add a new `useEffect` after the existing `slidev-ready`/`slidev-error` listener block (after line 59):

```typescript
// Listen for Slidev install events
useEffect(() => {
  const unlistenStart = listen("slidev-install-start", () => {
    setInstalling(true);
    setInstallError(null);
  });
  const unlistenComplete = listen("slidev-install-complete", () => {
    setInstalling(false);
  });
  const unlistenError = listen<{ message: string }>("slidev-install-error", (event) => {
    setInstalling(false);
    setInstallError(event.payload.message);
  });
  return () => {
    unlistenStart.then((fn) => fn());
    unlistenComplete.then((fn) => fn());
    unlistenError.then((fn) => fn());
  };
}, []);
```

- [ ] **Step 3: Add install progress UI**

Add a rendering block after the existing `starting` check (after line 138, before the `session?.error` block):

```tsx
if (installing) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", background: "var(--bg-base)" }}>
      {slidevLogo}
      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8 }}>
        <span className="slidev-spinner" />
        <span style={{ fontSize: 13, opacity: 0.7 }}>{t("slidevInstalling")}</span>
      </div>
    </div>
  );
}

if (installError) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", background: "var(--bg-base)", padding: 24 }}>
      {slidevLogo}
      <p style={{ marginTop: 12, color: "var(--error)", fontSize: 13 }}>{t("slidevInstallError")}</p>
      <p style={{ marginTop: 4, opacity: 0.6, fontSize: 12, textAlign: "center" }}>{t("slidevInstallProxyHint")}</p>
      <p style={{ marginTop: 4, opacity: 0.5, fontSize: 11, maxWidth: 400, wordBreak: "break-all" }}>{installError}</p>
      <button onClick={() => { setInstallError(null); startServer(); }} style={{ marginTop: 8, padding: "4px 16px", cursor: "pointer" }}>{t("slidevRetry")}</button>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/features/preview/components/SlidevPreviewPanel.tsx
git commit -m "feat(slidev): show install progress and proxy error hints in preview panel"
```

---

### Task 8: Remove bundled node_modules and verify build

**Files:**
- Modify: `.gitignore` (if needed)

- [ ] **Step 1: Delete bundled node_modules if present locally**

```bash
rm -rf resources/slidev-env/node_modules
```

- [ ] **Step 2: Verify package.json still exists in resources**

```bash
cat resources/slidev-env/package.json
```

Expected: The JSON with `@slidev/cli`, `@slidev/theme-default`, `playwright-chromium` dependencies.

- [ ] **Step 3: Run Tauri build to verify**

```bash
npm run tauri build
```

Expected: Build succeeds without errors. The resulting installer should be significantly smaller.

- [ ] **Step 4: Run the app and test Slidev preview**

1. Open the app
2. Open a Slidev markdown file
3. Switch to Slidev preview tab
4. Verify "Installing Slidev environment..." message appears
5. Wait for install to complete
6. Verify Slidev preview loads correctly
7. Close and reopen the preview — verify it starts immediately (no reinstall)

- [ ] **Step 5: Commit any remaining changes**

```bash
git add -A
git commit -m "chore(slidev): remove bundled node_modules, dynamic install ready"
```

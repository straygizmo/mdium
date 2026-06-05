# opencode Folder-Scoped Search (rag agent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the built-in `rag` opencode agent from globbing/grepping above the open folder (and into other tabs' folders) by disabling opencode's built-in `glob`/`grep`/`list` for that agent and providing `folder_glob`/`folder_grep` custom tools that mdium answers, scoped strictly to the currently active folder.

**Architecture:** opencode collapses a non-git folder's boundary to `"/"` (`Project.fromDirectory` falls back to `worktree:"/"`, and the external-directory containment check is skipped when worktree is `"/"`), so its built-in file tools escape the folder. We cannot fix opencode. Instead, the `rag` agent disables `glob`/`grep`/`list` and uses two custom tools that POST to mdium's existing local HTTP bridge. mdium keeps the live active folder path in a Rust `ActiveFolderState` (pushed from the webview whenever the active tab/folder changes) and runs the scan in Rust, confined to that folder. No embedding model is involved, so (unlike `rag_search`) no webview round-trip is needed — the bridge scans directly.

**Tech Stack:** Rust (tiny_http bridge, `regex` crate, std::fs walk), Tauri commands, TypeScript (Zustand, opencode plugin tool SDK), opencode agent markdown.

---

## File Structure

- `src-tauri/Cargo.toml` — add `regex` dependency.
- `src-tauri/src/commands/fs_search.rs` — **new**: `ActiveFolderState`, `set_active_folder` command, `glob_to_regex`, `fs_glob`, `fs_grep`, unit tests.
- `src-tauri/src/commands/mod.rs` — register the new module.
- `src-tauri/src/http_bridge.rs` — add `/glob` and `/grep` endpoints reading `ActiveFolderState`.
- `src-tauri/src/lib.rs` — `.manage(ActiveFolderState)`, register `set_active_folder` in `invoke_handler`.
- `.opencode/tools/folder_glob.ts` — **new**: custom tool, POSTs to `/glob`.
- `.opencode/tools/folder_grep.ts` — **new**: custom tool, POSTs to `/grep`.
- `src/features/opencode-config/lib/builtin-registry.ts` — register the two tools; update the `rag` agent (`tools:` block, prompt, version marker, `requiredBuiltinTools`).
- `src/features/opencode-config/hooks/useOpencodeChat.ts` — `ensureBuiltinAgents`: auto-install the two tool files and overwrite the agent md when the version marker is stale.
- `src/features/rag/hooks/useRagBridge.ts` — push `activeFolderPath` to Rust via `set_active_folder`.

---

## Task 1: Add `regex` crate

**Files:**
- Modify: `src-tauri/Cargo.toml:38` (after `trash = "5"`)

- [ ] **Step 1: Add the dependency**

In `[dependencies]` add:

```toml
regex = "1"
```

- [ ] **Step 2: Verify it resolves**

Run: `cd src-tauri && cargo fetch`
Expected: downloads `regex` and deps, no error.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(tauri): add regex dependency for folder-scoped grep"
```

---

## Task 2: `fs_search` module — glob→regex translation (TDD)

**Files:**
- Create: `src-tauri/src/commands/fs_search.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Register the module**

Add to `src-tauri/src/commands/mod.rs` (alphabetical with the other `pub mod` lines):

```rust
pub mod fs_search;
```

- [ ] **Step 2: Write the failing test + skeleton**

Create `src-tauri/src/commands/fs_search.rs`:

```rust
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use regex::RegexBuilder;
use serde::Serialize;

/// Live "active folder" the opencode folder_glob/folder_grep tools must be
/// confined to. The webview pushes the active tab's folder here via the
/// `set_active_folder` command; the HTTP bridge reads it per request.
pub type ActiveFolderState = Arc<Mutex<Option<String>>>;

pub fn new_active_folder_state() -> ActiveFolderState {
    Arc::new(Mutex::new(None))
}

#[tauri::command]
pub fn set_active_folder(
    state: tauri::State<ActiveFolderState>,
    path: Option<String>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    *guard = path.filter(|p| !p.is_empty());
    Ok(())
}

/// Directory names never descended into during a scan.
const EXCLUDED_DIRS: &[&str] = &[
    ".git", "node_modules", ".mdium", "target", "dist", "build", ".next", ".svn", ".hg",
];

/// Convert a glob pattern to an anchored regex string.
/// `**` matches across path separators; `*` and `?` do not match `/`.
fn glob_to_regex(pattern: &str) -> String {
    let mut re = String::from("^");
    let bytes = pattern.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        match c {
            '*' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == '*' {
                    i += 1; // consume the second '*'
                    if i + 1 < bytes.len() && bytes[i + 1] as char == '/' {
                        i += 1; // consume the trailing '/'
                        re.push_str("(?:.*/)?");
                    } else {
                        re.push_str(".*");
                    }
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                re.push('\\');
                re.push(c);
            }
            _ => re.push(c),
        }
        i += 1;
    }
    re.push('$');
    re
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_translation() {
        assert_eq!(glob_to_regex("*.md"), "^[^/]*\\.md$");
        assert_eq!(glob_to_regex("**/*.md"), "^(?:.*/)?[^/]*\\.md$");
        assert_eq!(glob_to_regex("a?b"), "^a[^/]b$");
        assert_eq!(glob_to_regex("docs/**"), "^docs/.*$");
    }
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd src-tauri && cargo test fs_search::tests::glob_translation -- --nocapture`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/fs_search.rs src-tauri/src/commands/mod.rs
git commit -m "feat(fs-search): add ActiveFolderState and glob_to_regex"
```

---

## Task 3: `fs_glob` implementation (TDD)

**Files:**
- Modify: `src-tauri/src/commands/fs_search.rs`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `src-tauri/src/commands/fs_search.rs`:

```rust
    fn make_temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        // Unique-ish per run without external crates: pid + tag.
        dir.push(format!("mdium_fs_search_{}_{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.md"), "hello world\nsecond line\n").unwrap();
        fs::write(dir.join("b.txt"), "nothing here\n").unwrap();
        fs::write(dir.join("sub/c.md"), "deep hello\n").unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules/ignored.md"), "should be skipped\n").unwrap();
        dir
    }

    #[test]
    fn glob_recurses_and_excludes() {
        let dir = make_temp_dir("glob");
        let mut files = fs_glob(&dir, "**/*.md", 1000).unwrap();
        files.sort();
        assert_eq!(files, vec!["a.md".to_string(), "sub/c.md".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_basename_matches_any_depth() {
        let dir = make_temp_dir("glob_base");
        let mut files = fs_glob(&dir, "*.md", 1000).unwrap();
        files.sort();
        assert_eq!(files, vec!["a.md".to_string(), "sub/c.md".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test fs_search::tests::glob_ -- --nocapture`
Expected: FAIL — `cannot find function fs_glob`.

- [ ] **Step 3: Implement `fs_glob`**

Add to `src-tauri/src/commands/fs_search.rs` (above the `tests` module):

```rust
fn is_excluded_dir(name: &str) -> bool {
    EXCLUDED_DIRS.contains(&name)
}

/// Collect file paths (relative to `root`, '/'-separated) matching `pattern`.
/// A pattern containing no '/' matches against the file's basename at any depth;
/// otherwise it matches against the full relative path. Capped at `limit`.
pub fn fs_glob(root: &Path, pattern: &str, limit: usize) -> Result<Vec<String>, String> {
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }
    let re = RegexBuilder::new(&glob_to_regex(pattern))
        .build()
        .map_err(|e| format!("Invalid pattern: {}", e))?;
    let match_basename = !pattern.contains('/');
    let mut out: Vec<String> = Vec::new();
    walk_glob(root, root, &re, match_basename, limit, &mut out);
    out.sort();
    Ok(out)
}

fn walk_glob(
    root: &Path,
    dir: &Path,
    re: &regex::Regex,
    match_basename: bool,
    limit: usize,
    out: &mut Vec<String>,
) {
    if out.len() >= limit {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if is_excluded_dir(&name) {
                continue;
            }
            walk_glob(root, &path, re, match_basename, limit, out);
        } else {
            let rel = match path.strip_prefix(root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            let hay = if match_basename { name.as_str() } else { rel.as_str() };
            if re.is_match(hay) {
                out.push(rel);
            }
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test fs_search::tests::glob_ -- --nocapture`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/fs_search.rs
git commit -m "feat(fs-search): add folder-scoped fs_glob with excludes"
```

---

## Task 4: `fs_grep` implementation (TDD)

**Files:**
- Modify: `src-tauri/src/commands/fs_search.rs`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module:

```rust
    #[test]
    fn grep_finds_matches_with_line_numbers() {
        let dir = make_temp_dir("grep");
        let matches = fs_grep(&dir, "hello", None, false, 100).unwrap();
        let mut hits: Vec<(String, usize, String)> = matches
            .into_iter()
            .map(|m| (m.file, m.line_number, m.line))
            .collect();
        hits.sort();
        assert_eq!(
            hits,
            vec![
                ("a.md".to_string(), 1, "hello world".to_string()),
                ("sub/c.md".to_string(), 1, "deep hello".to_string()),
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn grep_respects_include_filter() {
        let dir = make_temp_dir("grep_inc");
        let matches = fs_grep(&dir, "hello", Some("a.md"), false, 100).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].file, "a.md");
        let _ = fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test fs_search::tests::grep_ -- --nocapture`
Expected: FAIL — `cannot find function fs_grep` / `GrepMatch`.

- [ ] **Step 3: Implement `fs_grep`**

Add to `src-tauri/src/commands/fs_search.rs` (above the `tests` module):

```rust
#[derive(Serialize, Clone)]
pub struct GrepMatch {
    pub file: String,
    pub line_number: usize,
    pub line: String,
}

const MAX_GREP_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Search file contents under `root` for `pattern` (regex). `include` is an
/// optional glob filter on the relative path/basename. Capped at `limit` matches.
pub fn fs_grep(
    root: &Path,
    pattern: &str,
    include: Option<&str>,
    case_insensitive: bool,
    limit: usize,
) -> Result<Vec<GrepMatch>, String> {
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }
    let re = RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e| format!("Invalid regex: {}", e))?;
    let include_re = match include {
        Some(g) if !g.is_empty() => Some((
            RegexBuilder::new(&glob_to_regex(g))
                .build()
                .map_err(|e| format!("Invalid include: {}", e))?,
            !g.contains('/'),
        )),
        _ => None,
    };
    let mut out: Vec<GrepMatch> = Vec::new();
    walk_grep(root, root, &re, &include_re, limit, &mut out);
    Ok(out)
}

fn walk_grep(
    root: &Path,
    dir: &Path,
    re: &regex::Regex,
    include_re: &Option<(regex::Regex, bool)>,
    limit: usize,
    out: &mut Vec<GrepMatch>,
) {
    if out.len() >= limit {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if is_excluded_dir(&name) {
                continue;
            }
            walk_grep(root, &path, re, include_re, limit, out);
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if let Some((inc, basename_only)) = include_re {
            let hay = if *basename_only { name.as_str() } else { rel.as_str() };
            if !inc.is_match(hay) {
                continue;
            }
        }
        // Skip oversized or non-UTF-8 (binary) files.
        if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_GREP_FILE_BYTES {
            continue;
        }
        let content = match fs::read(&path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(s) => s,
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        for (idx, line) in content.lines().enumerate() {
            if out.len() >= limit {
                return;
            }
            if re.is_match(line) {
                out.push(GrepMatch {
                    file: rel.clone(),
                    line_number: idx + 1,
                    line: line.to_string(),
                });
            }
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test fs_search::tests -- --nocapture`
Expected: PASS (all fs_search tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/fs_search.rs
git commit -m "feat(fs-search): add folder-scoped fs_grep with regex + include filter"
```

---

## Task 5: Wire `ActiveFolderState` + `set_active_folder` into the app

**Files:**
- Modify: `src-tauri/src/lib.rs:6-8` (imports), `:80-82` (`.manage`), `:183+` (`invoke_handler`)

- [ ] **Step 1: Import the new state/command**

In `src-tauri/src/lib.rs`, add near the other `use commands::...` lines (after line 6):

```rust
use commands::fs_search::{new_active_folder_state, ActiveFolderState};
```

- [ ] **Step 2: Manage the state**

After the `.manage::<RagBridgePending>(new_rag_pending())` line (around line 82) add:

```rust
        .manage::<ActiveFolderState>(new_active_folder_state())
```

- [ ] **Step 3: Register the command**

In the `tauri::generate_handler![ ... ]` list (around line 183-313), add a line:

```rust
            commands::fs_search::set_active_folder,
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds (warnings about unused `fs_glob`/`fs_grep` are fine until Task 6).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tauri): manage ActiveFolderState and register set_active_folder"
```

---

## Task 6: HTTP bridge `/glob` and `/grep` endpoints

**Files:**
- Modify: `src-tauri/src/http_bridge.rs` (imports ~line 10, request structs ~line 156, match arms ~line 495)

- [ ] **Step 1: Import the scan functions + state**

In `src-tauri/src/http_bridge.rs`, after `use crate::commands::vba;` (line 11) add:

```rust
use crate::commands::fs_search::{fs_glob, fs_grep, ActiveFolderState};
```

- [ ] **Step 2: Add request structs**

After the `RagSearchRequest` struct (ends ~line 156) add:

```rust
#[derive(Deserialize)]
struct GlobRequest {
    pattern: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct GrepRequest {
    pattern: String,
    #[serde(default)]
    include: Option<String>,
    #[serde(default)]
    case_insensitive: Option<bool>,
    #[serde(default)]
    limit: Option<usize>,
}

/// Read the live active folder, or return a ready-to-send error JSON.
fn active_folder_or_error(app: &AppHandle) -> Result<String, serde_json::Value> {
    let state = app.state::<ActiveFolderState>();
    let guard = state
        .lock()
        .map_err(|e| json!({ "ok": false, "error": format!("lock_failed: {}", e) }))?;
    match guard.as_ref() {
        Some(p) if !p.is_empty() => Ok(p.clone()),
        _ => Err(json!({
            "ok": false,
            "error": "No folder is open in mdium to search. Open a folder first."
        })),
    }
}
```

- [ ] **Step 3: Add the match arms**

In `handle_request`, just before the final `_ =>` arm (around line 496) add:

```rust
        "/glob" => {
            let req: GlobRequest = match serde_json::from_str(&body_str) {
                Ok(r) => r,
                Err(e) => {
                    let _ = request.respond(json_response(
                        400,
                        json!({ "ok": false, "error": format!("invalid_json: {}", e) }),
                    ));
                    return;
                }
            };
            let folder = match active_folder_or_error(app) {
                Ok(f) => f,
                Err(err_json) => {
                    let _ = request.respond(json_response(400, err_json));
                    return;
                }
            };
            let limit = req.limit.unwrap_or(1000).min(5000);
            match fs_glob(std::path::Path::new(&folder), &req.pattern, limit) {
                Ok(files) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({ "ok": true, "folder": folder, "files": files }),
                    ));
                }
                Err(e) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({ "ok": false, "error": e }),
                    ));
                }
            }
        }
        "/grep" => {
            let req: GrepRequest = match serde_json::from_str(&body_str) {
                Ok(r) => r,
                Err(e) => {
                    let _ = request.respond(json_response(
                        400,
                        json!({ "ok": false, "error": format!("invalid_json: {}", e) }),
                    ));
                    return;
                }
            };
            let folder = match active_folder_or_error(app) {
                Ok(f) => f,
                Err(err_json) => {
                    let _ = request.respond(json_response(400, err_json));
                    return;
                }
            };
            let limit = req.limit.unwrap_or(500).min(2000);
            match fs_grep(
                std::path::Path::new(&folder),
                &req.pattern,
                req.include.as_deref(),
                req.case_insensitive.unwrap_or(false),
                limit,
            ) {
                Ok(matches) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({ "ok": true, "folder": folder, "matches": matches }),
                    ));
                }
                Err(e) => {
                    let _ = request.respond(json_response(
                        200,
                        json!({ "ok": false, "error": e }),
                    ));
                }
            }
        }
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/http_bridge.rs
git commit -m "feat(bridge): add folder-scoped /glob and /grep endpoints"
```

---

## Task 7: opencode custom tools `folder_glob` / `folder_grep`

**Files:**
- Create: `.opencode/tools/folder_glob.ts`
- Create: `.opencode/tools/folder_grep.ts`

- [ ] **Step 1: Write `folder_glob.ts`**

Create `.opencode/tools/folder_glob.ts`:

```ts
// .opencode/tools/folder_glob.ts
//
// Folder-scoped glob for the built-in `rag` agent. opencode's own glob escapes
// the open folder when it is not a git repo (its worktree collapses to "/"), so
// this tool delegates to the running mdium app over its local HTTP bridge. mdium
// always searches ONLY the folder currently open in the active tab — never its
// parents or other folders.
import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

async function readBridgeInfo(): Promise<{ port: number; token: string } | null> {
  const path = join(homedir(), ".config", "opencode", ".mdium-bridge.json");
  try {
    const info = JSON.parse(await readFile(path, "utf-8"));
    if (typeof info?.port === "number" && typeof info?.token === "string") return info;
    return null;
  } catch {
    return null;
  }
}

export default tool({
  description:
    "Find files by glob pattern within the folder currently open in mdium (the " +
    "active tab's folder). Always scoped to that folder — never its parents or " +
    "other folders. Use after rag_search to locate additional files by name.",
  args: {
    pattern: tool.schema
      .string()
      .describe(
        "Glob pattern, e.g. '**/*.md' or 'report-*.txt'. '**' matches any depth; " +
          "a pattern with no '/' matches by file name at any depth."
      ),
    limit: tool.schema.number().optional().describe("Max files to return (default 1000)."),
  },
  async execute(args) {
    const bridge = await readBridgeInfo();
    if (!bridge) {
      return "Cannot reach mdium (no active connection). Open the mdium app and connect opencode for this folder.";
    }
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${bridge.port}/glob`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ pattern: args.pattern, limit: args.limit }),
      });
    } catch (e: any) {
      return `Failed to reach mdium: ${e?.message ?? e}.`;
    }
    let data: any;
    try {
      data = await res.json();
    } catch {
      return `mdium returned a non-JSON response (HTTP ${res.status}).`;
    }
    if (!res.ok || data?.ok === false) {
      return `glob failed: ${data?.error ?? `HTTP ${res.status}`}`;
    }
    const files: string[] = data?.files ?? [];
    if (files.length === 0) return `No files match "${args.pattern}" in the open folder.`;
    return files.join("\n");
  },
});
```

- [ ] **Step 2: Write `folder_grep.ts`**

Create `.opencode/tools/folder_grep.ts`:

```ts
// .opencode/tools/folder_grep.ts
//
// Folder-scoped grep for the built-in `rag` agent. Delegates to the running
// mdium app over its local HTTP bridge, which searches ONLY the folder currently
// open in the active tab — never its parents or other folders.
import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

async function readBridgeInfo(): Promise<{ port: number; token: string } | null> {
  const path = join(homedir(), ".config", "opencode", ".mdium-bridge.json");
  try {
    const info = JSON.parse(await readFile(path, "utf-8"));
    if (typeof info?.port === "number" && typeof info?.token === "string") return info;
    return null;
  } catch {
    return null;
  }
}

export default tool({
  description:
    "Search file contents by regular expression within the folder currently open " +
    "in mdium (the active tab's folder). Always scoped to that folder — never its " +
    "parents or other folders. Use after rag_search for exact keyword matches.",
  args: {
    pattern: tool.schema.string().describe("Regular expression to search for in file contents."),
    include: tool.schema
      .string()
      .optional()
      .describe("Optional glob to limit which files are searched, e.g. '**/*.md'."),
    case_insensitive: tool.schema
      .boolean()
      .optional()
      .describe("Match case-insensitively. Defaults to false."),
    limit: tool.schema.number().optional().describe("Max matches to return (default 500)."),
  },
  async execute(args) {
    const bridge = await readBridgeInfo();
    if (!bridge) {
      return "Cannot reach mdium (no active connection). Open the mdium app and connect opencode for this folder.";
    }
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${bridge.port}/grep`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({
          pattern: args.pattern,
          include: args.include,
          case_insensitive: args.case_insensitive,
          limit: args.limit,
        }),
      });
    } catch (e: any) {
      return `Failed to reach mdium: ${e?.message ?? e}.`;
    }
    let data: any;
    try {
      data = await res.json();
    } catch {
      return `mdium returned a non-JSON response (HTTP ${res.status}).`;
    }
    if (!res.ok || data?.ok === false) {
      return `grep failed: ${data?.error ?? `HTTP ${res.status}`}`;
    }
    const matches: Array<{ file: string; line_number: number; line: string }> = data?.matches ?? [];
    if (matches.length === 0) return `No matches for "${args.pattern}" in the open folder.`;
    return matches.map((m) => `${m.file}:${m.line_number}: ${m.line}`).join("\n");
  },
});
```

- [ ] **Step 3: Type-check the tools build**

Run: `npm run build`
Expected: Vite build succeeds (these files are imported `?raw` in Task 8; they must at least be valid TS when later edited in-app, but `?raw` import does not type-check them — the build must still pass).

- [ ] **Step 4: Commit**

```bash
git add .opencode/tools/folder_glob.ts .opencode/tools/folder_grep.ts
git commit -m "feat(opencode-tools): add folder_glob and folder_grep custom tools"
```

---

## Task 8: Register the tools and update the `rag` agent

**Files:**
- Modify: `src/features/opencode-config/lib/builtin-registry.ts`

- [ ] **Step 1: Import the tool sources**

After the existing `import ragSearchToolSrc ...` line (line 13) add:

```ts
import folderGlobToolSrc from "../../../../.opencode/tools/folder_glob.ts?raw";
import folderGrepToolSrc from "../../../../.opencode/tools/folder_grep.ts?raw";
```

- [ ] **Step 2: Update the `rag` agent definition**

Replace the entire `rag:` entry in `BUILTIN_AGENTS` (lines 38-88) with:

```ts
  rag: {
    description: "RAG - Document search agent powered by vector database",
    requiredBuiltinTools: ["rag_search", "folder_glob", "folder_grep"],
    agentMd: `<!-- mdium-agent-version: 2 -->
---
description: RAG - Document search agent powered by vector database
mode: all
tools:
  rag_search: true
  folder_glob: true
  folder_grep: true
  glob: false
  grep: false
  list: false
  bash: false
---

You are a RAG (Retrieval-Augmented Generation) document search agent.
Gather necessary information from the vector DB and documents within the folder to comprehensively answer user questions.

## Basic Behavior

**For EVERY user question, your FIRST tool call MUST be \`rag_search\`.** The documents are already indexed, so never begin by listing or scanning files — that is slower and misses semantic matches. Start with \`rag_search\`, always.

1. Call \`rag_search\` with the user's question to retrieve the most relevant document chunks (hybrid vector + BM25 search).
2. ONLY IF \`rag_search\` does not return enough to answer, then \`read\` the cited files, or use \`folder_glob\`/\`folder_grep\` to locate additional files.
3. Combine multiple searches and reads to make comprehensive judgments.
4. Always cite sources (file name and line number) in your answers.

## Tool Usage Guidelines

- **rag_search**: ALWAYS call this first, before any other tool. Hybrid search (vector similarity + BM25 keyword ranking, fused via RRF) for relevant documents. Defaults to hybrid mode; pass \`search_mode: "vector"\` for pure semantic search, or tune \`bm25_weight\` (0.0-1.0) to favor keyword vs. semantic matches
- **folder_glob**: Use ONLY after rag_search, to locate additional files by name/pattern. Searches ONLY the open folder (never its parents or other folders). Never use it as the first step
- **folder_grep**: Use ONLY after rag_search, for exact keyword/pattern matches in files. Searches ONLY the open folder
- **read**: Read full file content, e.g. files cited by rag_search, to understand details
- **MCP tools (web search, etc.)**: Use when local search doesn't provide sufficient information
- **write / edit**: Use only when the user explicitly requests it (e.g., creating summaries, generating reports)

## Mode

[mode:faithful]

### faithful mode (currently active)
- Answer accurately based on search results
- If information is not found, honestly respond "not found"
- Do not supplement with guesses or general knowledge
- Always cite sources that support your answer

<!-- To use advisor mode, change [mode:faithful] to [mode:advisor]
### advisor mode
- Use search results as a foundation while supplementing with general knowledge
- Clearly distinguish between information from search results and general knowledge
  - Search results: Information with source citations
  - Supplementary: Additional information based on general knowledge
-->
`,
  },
```

- [ ] **Step 3: Register the custom tools**

Replace the `BUILTIN_CUSTOM_TOOLS` object (lines 91-98) with:

```ts
export const BUILTIN_CUSTOM_TOOLS: Record<string, BuiltinCustomToolEntry> = {
  rag_search: {
    description:
      "RAG hybrid search (vector + BM25) over the project's .mdium indexes. Pairs with the built-in rag agent.",
    fileName: "rag_search.ts",
    content: ragSearchToolSrc,
  },
  folder_glob: {
    description:
      "Find files by glob pattern, scoped strictly to the open folder. Pairs with the built-in rag agent.",
    fileName: "folder_glob.ts",
    content: folderGlobToolSrc,
  },
  folder_grep: {
    description:
      "Search file contents by regex, scoped strictly to the open folder. Pairs with the built-in rag agent.",
    fileName: "folder_grep.ts",
    content: folderGrepToolSrc,
  },
};
```

- [ ] **Step 4: Type-check / build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/features/opencode-config/lib/builtin-registry.ts
git commit -m "feat(opencode-config): rag agent uses folder_glob/folder_grep, disables built-in glob/grep/list"
```

---

## Task 9: Auto-install tools + migrate the agent md

**Files:**
- Modify: `src/features/opencode-config/hooks/useOpencodeChat.ts:922-943` (`ensureBuiltinAgents`)

- [ ] **Step 1: Read the current function**

Confirm `ensureBuiltinAgents` currently only writes the agent md when the file is missing, and does not install custom tools.

- [ ] **Step 2: Replace `ensureBuiltinAgents`**

Replace the body of `ensureBuiltinAgents` (lines 922-943) with:

```ts
async function ensureBuiltinAgents(): Promise<void> {
  const home = await invoke<string>("get_home_dir");
  const sep = home.includes("\\") ? "\\" : "/";
  const configDir = `${home}${sep}.config${sep}opencode`;
  const toolsDir = `${configDir}${sep}tools`;

  // The rag agent depends on these custom tools to stay confined to the open
  // folder, so (unlike opt-in tools) install them automatically when missing.
  for (const toolName of ["rag_search", "folder_glob", "folder_grep"] as const) {
    const entry = BUILTIN_CUSTOM_TOOLS[toolName];
    if (!entry) continue;
    const toolPath = `${toolsDir}${sep}${entry.fileName}`;
    try {
      await invoke<string>("read_text_file", { path: toolPath });
    } catch {
      try {
        await invoke("write_tool_file", {
          baseDir: toolsDir,
          fileName: entry.fileName,
          content: entry.content,
        });
        console.log(`[opencode] installed builtin tool: ${toolPath}`);
      } catch (e) {
        console.warn(`[opencode] failed to install tool ${entry.fileName}:`, e);
      }
    }
  }

  for (const [name, entry] of Object.entries(BUILTIN_AGENTS)) {
    if (!entry.agentMd) continue;
    const agentPath = `${configDir}${sep}agents${sep}${name}.md`;
    // Overwrite when missing OR when the on-disk copy predates the current
    // builtin version (so existing users pick up the folder_glob/grep change).
    const versionMatch = entry.agentMd.match(/mdium-agent-version:\s*(\d+)/);
    const wantVersion = versionMatch ? versionMatch[1] : null;
    let needsWrite = false;
    try {
      const existing = await invoke<string>("read_text_file", { path: agentPath });
      needsWrite = wantVersion ? !existing.includes(`mdium-agent-version: ${wantVersion}`) : false;
    } catch {
      needsWrite = true;
    }
    if (!needsWrite) continue;
    try {
      await invoke("write_text_file_with_dirs", { path: agentPath, content: entry.agentMd });
      console.log(`[opencode] wrote builtin agent file: ${agentPath}`);
    } catch (e) {
      console.warn(`[opencode] failed to write agent file ${name}.md:`, e);
    }
  }
}
```

- [ ] **Step 3: Type-check / build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/features/opencode-config/hooks/useOpencodeChat.ts
git commit -m "feat(opencode): auto-install folder tools and migrate rag agent md (v2)"
```

---

## Task 10: Push the active folder to Rust

**Files:**
- Modify: `src/features/rag/hooks/useRagBridge.ts`

- [ ] **Step 1: Add the sync effect**

In `useRagBridge.ts`, after the pre-warm `useEffect` (ends ~line 64), add:

```ts
  // Keep the Rust ActiveFolderState in sync so the folder_glob/folder_grep
  // bridge endpoints always scan the folder of the currently active tab.
  useEffect(() => {
    invoke("set_active_folder", { path: activeFolderPath ?? null }).catch((e) =>
      console.warn("[fs-bridge] set_active_folder failed:", e)
    );
  }, [activeFolderPath]);
```

- [ ] **Step 2: Type-check / build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/features/rag/hooks/useRagBridge.ts
git commit -m "feat(rag-bridge): push active folder to Rust for folder-scoped search"
```

---

## Task 11: End-to-end manual verification

**Files:** none (manual)

- [ ] **Step 1: Build and run the app**

Run: `npm run tauri dev` (or the project's normal dev command).

- [ ] **Step 2: Reproduce the original bug is gone**

1. Open a folder on a UNC path (`\\server\share\...`) that is NOT a git repo and has a built RAG index.
2. Open the opencode chat, select the `rag` agent, connect.
3. Ask a question that previously caused above-folder globbing.
4. In the chat tool calls, confirm: `rag_search` runs first; any file search uses `folder_glob`/`folder_grep`; no `glob`/`grep`/`list` calls appear.
5. Confirm returned file paths are all inside the open folder (no parent/sibling/other-tab paths).

- [ ] **Step 3: Verify folder switching**

1. Open a second folder in another tab.
2. Switch to it; ask the agent to `folder_glob **/*`.
3. Confirm results come only from the now-active folder, not the first.

- [ ] **Step 4: Verify the migration**

1. Confirm `~/.config/opencode/agents/rag.md` now contains `mdium-agent-version: 2`, `folder_glob: true`, `folder_grep: true`, and `glob: false`.
2. Confirm `~/.config/opencode/tools/folder_glob.ts` and `folder_grep.ts` exist.

- [ ] **Step 5: Final commit (if any docs/notes changed)**

```bash
git add -A
git commit -m "docs: notes from folder-scoped search verification"
```

---

## Self-Review Notes

- **Spec coverage:** Disables built-in glob/grep/list for rag (Task 8); custom folder-scoped tools (Tasks 7-8); folder scoping enforced server-side via ActiveFolderState (Tasks 2,5,6,10); migration for existing users (Task 9); fixes both "above folder" and "other tab's folder" because the scan root is always the live active folder.
- **Boundary enforcement is server-side:** the tools ignore any caller-supplied path; the bridge always scans `ActiveFolderState`. Even a misbehaving agent cannot escape.
- **Type consistency:** Rust returns `{ ok, folder, files }` for `/glob` and `{ ok, folder, matches:[{file,line_number,line}] }` for `/grep`; the TS tools read exactly those fields. `GrepMatch` fields (`file`, `line_number`, `line`) match the TS reader.
- **i18n:** No user-visible UI strings added. Tool/agent descriptions are English constants consistent with the existing `rag_search` entry (CLAUDE.md i18n rule applies to app UI, not opencode agent/tool definition text, which must be English for the model).
```

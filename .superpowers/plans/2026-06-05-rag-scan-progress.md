# RAG Scan Progress Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-file scan progress (count + filename) and a phase label (Scanning / Embedding / Saving) during RAG index building, so large folders no longer look frozen.

**Architecture:** The Rust `rag_scan_folder` command pre-counts target files, then emits a throttled `rag-scan-progress` Tauri event per processed file (same pattern as the existing `model-download-progress`). The frontend `buildIndex` listens for those events and updates a generalized `BuildProgress` state carrying a `phase` field; `RagPanel` renders a phase label, a count, a progress bar, and the current filename.

**Tech Stack:** Rust (Tauri 2, `tauri::Emitter`, rusqlite, sha2), React + TypeScript, `@tauri-apps/api/event` (`listen`), i18next.

**Spec:** `.superpowers/specs/2026-06-05-rag-scan-progress-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src-tauri/src/commands/rag.rs` | Scan + emit progress | Add `RagScanProgress` struct, `count_files_recursive`, thread progress through `scan_folder_recursive`, add `app: AppHandle` param to `rag_scan_folder` |
| `src/features/rag/hooks/useRagFeatures.ts` | Build orchestration | Generalize `BuildProgress` type, listen for `rag-scan-progress`, set phase in scan/embed/save |
| `src/features/rag/components/RagPanel.tsx` | Badge + progress bar UI | Render phase label + count; use new `current`/`total` fields |
| `src/shared/i18n/locales/en/common.json` | English strings | Add 3 phase-label keys |
| `src/shared/i18n/locales/ja/common.json` | Japanese strings | Add 3 phase-label keys |

**Note:** `rag_scan_folder` is only invoked from the frontend (`useRagFeatures.ts`) and registered in `src-tauri/src/lib.rs:267`; no Rust code calls it directly. Tauri auto-injects `app: AppHandle`, so the frontend `invoke` arguments do not change.

---

## Task 1: Backend — count helper + progress struct (TDD)

**Files:**
- Modify: `src-tauri/src/commands/rag.rs` (add struct near line 24; add `count_files_recursive` near the other free functions around line 330; add test in the existing `#[cfg(test)] mod tests` block at line 921)

The existing `scan_folder_recursive` (rag.rs:333) uses these traversal rules we must mirror exactly when counting:
- skip dirs named `node_modules` or `target`
- a `.mdium` dir: collect matching files inside it via `collect_md_in_mdium` and attribute them to the parent (do NOT recurse normally)
- skip other dot-dirs (`name.starts_with('.')`)
- recurse into all other dirs
- a file counts if its name ends with any configured extension

- [ ] **Step 1: Write the failing test**

Add to the bottom of `mod tests` (before its closing `}` at the end of the file). This test builds a fixture tree under the OS temp dir using std only (no new crates), to honor the project's network-restricted environment.

```rust
    #[test]
    fn count_files_recursive_mirrors_scan_traversal() {
        use std::fs;
        // Unique, std-only temp fixture (no tempfile crate dependency).
        let root = std::env::temp_dir().join("mdium_rag_count_test");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        // Counted: top-level .md files
        fs::write(root.join("a.md"), "# A\nbody").unwrap();
        fs::write(root.join("b.md"), "# B\nbody").unwrap();
        // Not counted: wrong extension
        fs::write(root.join("c.txt"), "nope").unwrap();

        // Counted: .md inside a normal subfolder (recursed)
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("d.md"), "# D\nbody").unwrap();

        // Not counted: node_modules and target are skipped
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("x.md"), "# X").unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("target").join("y.md"), "# Y").unwrap();

        // Not counted: hidden dir (other than .mdium) is skipped
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("z.md"), "# Z").unwrap();

        // Counted: files inside .mdium are attributed to the parent
        fs::create_dir_all(root.join(".mdium")).unwrap();
        fs::write(root.join(".mdium").join("e.md"), "# E\nbody").unwrap();

        let extensions = vec![".md".to_string()];
        let count = count_files_recursive(&root, &extensions);

        let _ = fs::remove_dir_all(&root);
        assert_eq!(count, 4, "should count a.md, b.md, sub/d.md, .mdium/e.md");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test count_files_recursive_mirrors_scan_traversal`
Expected: FAIL — compile error `cannot find function count_files_recursive in this scope`.

- [ ] **Step 3: Add the progress struct**

Add after the `RagChunk` struct (after rag.rs:24):

```rust
#[derive(Serialize, Clone)]
struct RagScanProgress {
    current: usize,
    total: usize,
    file: String,
}
```

- [ ] **Step 4: Implement `count_files_recursive`**

Add immediately after `collect_md_in_mdium` (after rag.rs:330, before `scan_folder_recursive`):

```rust
/// Count files that `scan_folder_recursive` would process, using identical
/// directory-traversal rules. Cheap: lists directories and matches extensions
/// only — no file reads, no hashing. Best-effort: unreadable subfolders
/// contribute 0 (the real scan would surface the error itself).
fn count_files_recursive(dir: &Path, extensions: &[String]) -> usize {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name == "node_modules" || name == "target" {
            continue;
        }

        if path.is_dir() {
            if name == ".mdium" {
                let mut md = Vec::new();
                collect_md_in_mdium(&path, extensions, &mut md);
                count += md.len();
                continue;
            }
            if name.starts_with('.') {
                continue;
            }
            count += count_files_recursive(&path, extensions);
        } else if extensions.iter().any(|ext| name.ends_with(ext.as_str())) {
            count += 1;
        }
    }
    count
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd src-tauri && cargo test count_files_recursive_mirrors_scan_traversal`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/rag.rs
git commit -m "feat(rag): add file counter and scan-progress struct"
```

---

## Task 2: Backend — thread progress through scan and emit events

**Files:**
- Modify: `src-tauri/src/commands/rag.rs` (`scan_folder_recursive` signature + body at lines 333, 375, 437; `rag_scan_folder` at lines 291-307)

- [ ] **Step 1: Extend `scan_folder_recursive` signature**

Replace the signature at rag.rs:333:

```rust
fn scan_folder_recursive(dir: &Path, chunks: &mut Vec<RagChunk>, extensions: &[String], min_chunk_length: usize, model_name: &str) -> Result<(), String> {
```

with:

```rust
fn scan_folder_recursive(
    dir: &Path,
    chunks: &mut Vec<RagChunk>,
    extensions: &[String],
    min_chunk_length: usize,
    model_name: &str,
    app: &tauri::AppHandle,
    total: usize,
    scanned: &mut usize,
    emit_step: usize,
) -> Result<(), String> {
```

- [ ] **Step 2: Forward the new args in the recursive call**

Replace the recursive call at rag.rs:375:

```rust
            scan_folder_recursive(&path, chunks, extensions, min_chunk_length, model_name)?;
```

with:

```rust
            scan_folder_recursive(&path, chunks, extensions, min_chunk_length, model_name, app, total, scanned, emit_step)?;
```

- [ ] **Step 3: Emit progress at the top of the per-file loop**

In the `for path in md_paths {` loop (starts rag.rs:437), insert these lines as the FIRST statements inside the loop, before `let content = fs::read_to_string(&path)...`:

```rust
    for path in md_paths {
        *scanned += 1;
        if *scanned % emit_step == 0 || *scanned == total {
            app.emit(
                "rag-scan-progress",
                RagScanProgress {
                    current: *scanned,
                    total,
                    file: path.to_string_lossy().to_string(),
                },
            )
            .ok();
        }
        let content = fs::read_to_string(&path).unwrap_or_default();
```

(The rest of the loop body is unchanged.)

- [ ] **Step 4: Update `rag_scan_folder` to count, then scan with progress**

Replace the body of `rag_scan_folder` (rag.rs:291-307) with:

```rust
#[tauri::command]
pub fn rag_scan_folder(
    app: tauri::AppHandle,
    folder_path: String,
    file_extensions: Option<String>,
    min_chunk_length: Option<usize>,
    model_name: Option<String>,
) -> Result<Vec<RagChunk>, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let extensions: Vec<String> = file_extensions
        .unwrap_or_else(|| ".md".to_string())
        .split(',')
        .map(|s| {
            let s = s.trim();
            if s.starts_with('.') { s.to_string() } else { format!(".{}", s) }
        })
        .filter(|s| s.len() > 1)
        .collect();
    let min_len = min_chunk_length.unwrap_or(0);
    let mut chunks = Vec::new();

    // Pre-count so the frontend can show "current/total". Cheap directory walk.
    let total = count_files_recursive(Path::new(&folder_path), &extensions);
    // Throttle to at most ~200 events for large trees.
    let emit_step = (total / 200).max(1);
    let mut scanned = 0usize;

    scan_folder_recursive(
        Path::new(&folder_path),
        &mut chunks,
        &extensions,
        min_len,
        name,
        &app,
        total,
        &mut scanned,
        emit_step,
    )?;
    Ok(chunks)
}
```

- [ ] **Step 5: Build and run the full backend test suite**

Run: `cd src-tauri && cargo build && cargo test`
Expected: builds cleanly; all existing tests plus `count_files_recursive_mirrors_scan_traversal` PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/rag.rs
git commit -m "feat(rag): emit per-file scan progress events"
```

---

## Task 3: i18n — phase label strings

**Files:**
- Modify: `src/shared/i18n/locales/en/common.json` (after line 41, `ragDownloadingModel`)
- Modify: `src/shared/i18n/locales/ja/common.json` (after line 41, `ragDownloadingModel`)

- [ ] **Step 1: Add English keys**

In `src/shared/i18n/locales/en/common.json`, after the `"ragDownloadingModel": "Downloading model...",` line, add:

```json
  "ragPhaseScanning": "Scanning",
  "ragPhaseEmbedding": "Embedding",
  "ragPhaseSaving": "Saving",
```

- [ ] **Step 2: Add Japanese keys**

In `src/shared/i18n/locales/ja/common.json`, after the `"ragDownloadingModel": "モデルをダウンロード中...",` line, add:

```json
  "ragPhaseScanning": "スキャン中",
  "ragPhaseEmbedding": "ベクトル化中",
  "ragPhaseSaving": "保存中",
```

- [ ] **Step 3: Verify both JSON files parse**

Run: `node -e "require('./src/shared/i18n/locales/en/common.json'); require('./src/shared/i18n/locales/ja/common.json'); console.log('ok')"`
Expected: prints `ok` (no JSON syntax error).

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/en/common.json src/shared/i18n/locales/ja/common.json
git commit -m "feat(rag): add scan phase label strings (en/ja)"
```

---

## Task 4: Frontend hook — listen for scan progress, set phases

**Files:**
- Modify: `src/features/rag/hooks/useRagFeatures.ts` (imports line 1-6; `BuildProgress` interface lines 68-72; `buildIndex` lines 122-172)

The repo has no frontend test suite (no `*.test.ts(x)` files, no established hook/IPC test harness), so this task is verified by TypeScript typecheck (`tsc` via `npm run build`) plus manual verification in Task 6.

- [ ] **Step 1: Add the event import**

Change `useRagFeatures.ts` line 2 area. After the existing `import { invoke } from "@tauri-apps/api/core";` (line 2), add:

```ts
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
```

- [ ] **Step 2: Generalize the `BuildProgress` interface**

Replace lines 68-72:

```ts
interface BuildProgress {
  currentFile: string;
  currentIndex: number;
  totalChunks: number;
}
```

with:

```ts
interface BuildProgress {
  phase: "scanning" | "embedding" | "saving";
  current: number;
  total: number;
  currentFile: string;
}
```

- [ ] **Step 3: Rewrite the `try`/`catch` of `buildIndex`**

Replace the entire `try { ... } catch (e: any) { ... }` statement (lines 127-171, i.e. from `try {` through its closing `}`) with the block below. It declares `unlisten` before the `try`, adds the scan listener, unlistens after scan, sets `phase` for each stage, and adds a `finally` that guarantees the listener is removed. Keep the indentation shown (the block lives inside `buildIndex`):

```ts
    let unlisten: UnlistenFn | null = null;
    try {
      await loadEmbed(ragSettings.embeddingModel);

      unlisten = await listen<{ current: number; total: number; file: string }>(
        "rag-scan-progress",
        (e) => {
          const fileName = e.payload.file.split(/[\\/]/).pop() ?? "";
          setBuildProgress({
            phase: "scanning",
            current: e.payload.current,
            total: e.payload.total,
            currentFile: fileName,
          });
        },
      );

      const chunks = await invoke<any[]>("rag_scan_folder", {
        folderPath,
        fileExtensions: ragSettings.fileExtensions,
        minChunkLength: ragSettings.minChunkLength,
        modelName: ragSettings.embeddingModel,
      });

      if (unlisten) {
        unlisten();
        unlisten = null;
      }

      if (chunks.length === 0) {
        console.log("RAG: No changed files to index");
        await checkStatus();
        return;
      }

      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const fileName = (chunk.file as string).split(/[\\/]/).pop() ?? "";
        setBuildProgress({ phase: "embedding", current: i + 1, total: chunks.length, currentFile: fileName });
        embeddings.push(await embed(chunk.text, "passage"));
      }

      setBuildProgress({ phase: "saving", current: chunks.length, total: chunks.length, currentFile: "" });

      const withEmbed = chunks.map((c: any, i: number) => ({
        ...c,
        embedding: embeddings[i],
      }));
      const saved = await invoke<number>("rag_save_chunks", { folderPath, chunks: withEmbed, modelName: ragSettings.embeddingModel });
      console.log(`RAG: Saved ${saved} chunks to index`);
      setBuildProgress(null);
      await checkStatus();
    } catch (e: any) {
      console.error("Build index failed:", e);
      // onnxruntime-web aborts surface as a bare number (a WASM heap address)
      // with no usable message. Tag those so the UI can show actionable guidance
      // instead of a meaningless code.
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "number"
            ? `ENGINE_CRASH:${e}`
            : String(e);
      setBuildError(msg);
      setStatus((s) => ({ ...s, state: "none" }));
      setBuildProgress(null);
    } finally {
      if (unlisten) unlisten();
    }
```

Note: this removes the old `setBuildProgress(null)` that sat between the embed loop and the save call (old line 148); progress is now cleared after the save succeeds (or in the catch). The `finally` guarantees the listener is removed even if scan throws, preventing duplicate listeners across rebuilds.

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: `tsc` passes with no errors (the build then runs `vite build`; a successful exit means types are consistent). If `tsc` reports an error about `buildProgress.currentIndex`/`totalChunks` in `RagPanel.tsx`, that is expected and fixed in Task 5 — re-run after Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/features/rag/hooks/useRagFeatures.ts
git commit -m "feat(rag): listen for scan progress and track build phase"
```

---

## Task 5: Frontend UI — phase label badge + progress bar

**Files:**
- Modify: `src/features/rag/components/RagPanel.tsx` (badge ternary lines 152-162; progress bar block lines 204-216)

- [ ] **Step 1: Update the badge text to show phase label + count**

Replace the badge content (lines 152-162):

```tsx
          {status.state === "ready"
            ? `${status.totalFiles} files / ${status.totalChunks} chunks`
            : status.state === "building"
              ? embedStatus === "downloading"
                ? `Building... ${t("ragDownloadingModel")}`
                : embedStatus === "loading"
                  ? `Building... (${embedProgress}%)`
                  : buildProgress
                    ? `${buildProgress.currentIndex}/${buildProgress.totalChunks}`
                    : "Building..."
              : "No index"}
```

with:

```tsx
          {status.state === "ready"
            ? `${status.totalFiles} files / ${status.totalChunks} chunks`
            : status.state === "building"
              ? embedStatus === "downloading"
                ? `Building... ${t("ragDownloadingModel")}`
                : embedStatus === "loading"
                  ? `Building... (${embedProgress}%)`
                  : buildProgress
                    ? buildProgress.phase === "scanning"
                      ? `${t("ragPhaseScanning")} ${buildProgress.current}/${buildProgress.total}`
                      : buildProgress.phase === "embedding"
                        ? `${t("ragPhaseEmbedding")} ${buildProgress.current}/${buildProgress.total}`
                        : t("ragPhaseSaving")
                    : "Building..."
              : "No index"}
```

- [ ] **Step 2: Update the progress bar block to use `current`/`total`**

Replace the build-progress block (lines 204-216):

```tsx
      {status.state === "building" && buildProgress && (
        <div className="rag-panel__build-progress">
          <div className="rag-panel__build-progress-bar">
            <div
              className="rag-panel__build-progress-fill"
              style={{ width: `${Math.round((buildProgress.currentIndex / buildProgress.totalChunks) * 100)}%` }}
            />
          </div>
          <span className="rag-panel__build-progress-file" title={buildProgress.currentFile}>
            {buildProgress.currentFile}
          </span>
        </div>
      )}
```

with:

```tsx
      {status.state === "building" && buildProgress && (
        <div className="rag-panel__build-progress">
          <div className="rag-panel__build-progress-bar">
            <div
              className="rag-panel__build-progress-fill"
              style={{ width: `${buildProgress.total > 0 ? Math.round((buildProgress.current / buildProgress.total) * 100) : 0}%` }}
            />
          </div>
          <span className="rag-panel__build-progress-file" title={buildProgress.currentFile}>
            {buildProgress.currentFile}
          </span>
        </div>
      )}
```

- [ ] **Step 3: Typecheck the whole frontend**

Run: `npm run build`
Expected: `tsc` + `vite build` complete with no errors. No remaining references to `buildProgress.currentIndex` or `buildProgress.totalChunks` anywhere.

- [ ] **Step 4: Confirm no stale field references remain**

Run: `git grep -n "currentIndex\|totalChunks" -- src/features/rag`
Expected: no matches referencing `buildProgress.currentIndex` / `buildProgress.totalChunks`. (`status.totalChunks` is a different field and is fine if it appears.)

- [ ] **Step 5: Commit**

```bash
git add src/features/rag/components/RagPanel.tsx
git commit -m "feat(rag): show scan phase label and count in build badge"
```

---

## Task 6: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Launch the app**

Run: `npm run tauri dev`
Expected: app starts.

- [ ] **Step 2: Build an index on a large folder**

Open a folder containing many markdown files (ideally hundreds, or at least one large `.md`). Click the Build index button in the RAG panel.

Expected observations:
- Badge transitions through phases: model load (`Building... (NN%)` if first run) → `Scanning X/Y` (X increases, filename shown below the bar) → `Embedding X/Y` → `Saving`.
- During scanning the count and filename update visibly — the UI no longer looks frozen.
- Progress bar fills proportionally in both scanning and embedding phases.
- On completion the badge shows `N files / M chunks`.

- [ ] **Step 3: Verify Japanese labels**

Switch language to Japanese (settings), rebuild (or build a folder with changes), and confirm the badge shows `スキャン中 X/Y`, `ベクトル化中 X/Y`, `保存中`.

- [ ] **Step 4: Verify no-change rebuild path**

Click Build again immediately (no file changes). Expected: scan runs (may briefly show `Scanning`), `chunks.length === 0` path logs "No changed files to index", status returns to `ready`, no errors, no lingering progress bar.

- [ ] **Step 5: Final commit (if any verification tweaks were needed)**

Only if changes were required:

```bash
git add -A
git commit -m "fix(rag): adjust scan progress per manual verification"
```

---

## Self-Review Notes

- **Spec coverage:** count+filename display (Tasks 2,4,5), phase labels (Tasks 3,5), Tauri-event approach (Task 2), throttling `total/200` (Task 2), pre-count pass (Task 1), `try/finally` unlisten (Task 4), i18n keys (Task 3), zero-file path preserved (Task 4 Step 3), event-name uniqueness confirmed (spec). All covered.
- **Type consistency:** `BuildProgress` fields `{ phase, current, total, currentFile }` are defined in Task 4 Step 2 and consumed identically in Task 4 Step 3 and Task 5 Steps 1-2. Rust `RagScanProgress` fields `{ current, total, file }` (Task 1 Step 3) match the frontend listener payload type `{ current, total, file }` (Task 4 Step 3).
- **No placeholders:** every code step contains full code; commands have expected output.

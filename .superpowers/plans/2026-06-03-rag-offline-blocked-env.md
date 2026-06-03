# RAG & Speech Offline / Blocked-Network Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local embedding (RAG) and speech-to-text work in a network-restricted, MSI-installed environment by relocating model storage to a writable per-user directory, bundling the ONNX Runtime WASM locally, and adding a manual model-placement UX.

**Architecture:** A shared Rust helper resolves the embedding-models directory under `app_local_data_dir()/.embedding-models` (writable under both MSI and NSIS) and is used by the `models://` protocol, the RAG commands, and the speech commands. The frontend configures onnxruntime-web (via transformers.js `env`) to load its WASM backend from a locally bundled `/ort/` directory instead of the jsDelivr CDN. When a model is absent and download is unavailable, the RAG panel shows the exact target folder and required files for manual placement.

**Tech Stack:** Rust + Tauri v2 (`app.path()` PathResolver), React 19 + TypeScript, `@huggingface/transformers@3.8.1` / `onnxruntime-web`, Vite 7, Vitest 4, `cargo test`.

**Repo policy:** every `git commit` message must end with the trailer:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```
Work happens on branch `feat/rag-offline-blocked-env` (already created; the design spec is committed there).

---

## File Structure

**Rust (`src-tauri/src/`)**
- `lib.rs` — add shared `model_subpath()` and `embedding_models_base_dir(&AppHandle)`; update the `models://` protocol handler to use them; add `#[cfg(test)]` for `model_subpath`.
- `commands/rag.rs` — `embedding_model_dir_for` takes `&AppHandle` and uses the shared base; `rag_check_model` / `rag_get_model_dir` gain an `app: AppHandle` param; new `rag_model_required_files` command.
- `commands/speech.rs` — `speech_model_dir_for` takes `&AppHandle` and uses the shared base; `speech_check_model` / `speech_get_model_dir` gain `app: AppHandle`.

**Frontend (`src/`)**
- `shared/lib/ort-wasm.ts` (new) — `configureLocalWasm(env)` shared by both inference entry points.
- `shared/lib/ort-wasm.test.ts` (new) — unit test.
- `features/rag/lib/model-error.ts` (new) — `classifyRagError()` pure helper.
- `features/rag/lib/model-error.test.ts` (new) — unit test.
- `features/rag/hooks/useLocalEmbedding.ts` — call `configureLocalWasm(env)`; surface `MODEL_MISSING` + manual-placement data.
- `features/rag/hooks/useRagFeatures.ts` — pass through manual-placement data.
- `features/rag/components/RagPanel.tsx` — manual-placement panel; use `classifyRagError`.
- `features/speech/workers/speech-worker.ts` — call `configureLocalWasm(env)`.
- `shared/i18n/locales/{en,ja}/common.json` — new strings.

**Build**
- `vite.config.ts` — inline plugin copying ORT WASM into `public/ort/`.
- `.gitignore` — ignore `public/ort/`.

---

## Task 1: Shared model-dir helpers in `lib.rs` (TDD)

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Test: inline `#[cfg(test)]` module in `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Add at the END of `src-tauri/src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::model_subpath;
    use std::path::PathBuf;

    #[test]
    fn model_subpath_splits_org_and_model() {
        assert_eq!(
            model_subpath("Xenova/multilingual-e5-base").unwrap(),
            PathBuf::from("Xenova").join("multilingual-e5-base")
        );
    }

    #[test]
    fn model_subpath_rejects_missing_slash() {
        assert!(model_subpath("no-slash").is_err());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml model_subpath`
Expected: FAIL to compile — `cannot find function model_subpath in this scope`.

- [ ] **Step 3: Implement the helpers**

In `src-tauri/src/lib.rs`, REPLACE the existing `embedding_models_base_dir` function (lines 12-16):

```rust
fn embedding_models_base_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    Some(exe_dir.join(".embedding-models"))
}
```

with:

```rust
/// Split a HuggingFace-style model id ("org/model") into a relative path
/// (`org/model`). Shared by the RAG and speech model-directory resolvers.
pub fn model_subpath(model_name: &str) -> Result<std::path::PathBuf, String> {
    let parts: Vec<&str> = model_name.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(format!("Invalid model name: {}", model_name));
    }
    Ok(std::path::PathBuf::from(parts[0]).join(parts[1]))
}

/// Base directory that holds all downloaded/placed embedding & speech models.
/// Stored under the per-user app local data dir so it is writable regardless of
/// install location (MSI perMachine -> Program Files would otherwise be
/// read-only) and is reachable for manual model placement.
pub fn embedding_models_base_dir(
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to resolve app local data dir: {}", e))?;
    Ok(dir.join(".embedding-models"))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml model_subpath`
Expected: the project still fails to COMPILE because `embedding_models_base_dir`'s old call site in the `models://` handler now has the wrong signature. That is fixed in Task 4. To verify Task 1 in isolation, instead run only the unit crate after Task 4. For now, confirm the test module compiles by checking the error is ONLY about the `models` protocol call site (not about `model_subpath`).

> Note: Tasks 1-4 are one compile unit. Commit them together at the end of Task 4. Do not commit a non-compiling tree between Tasks 1-3.

---

## Task 2: Wire `rag.rs` to the shared base + required-files command

**Files:**
- Modify: `src-tauri/src/commands/rag.rs`

- [ ] **Step 1: Update `embedding_model_dir_for` to use the shared base**

In `src-tauri/src/commands/rag.rs`, REPLACE the function (lines 570-582):

```rust
fn embedding_model_dir_for(model_name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().ok_or("Cannot determine app directory")?;
    // model_name is like "Xenova/multilingual-e5-large"
    let parts: Vec<&str> = model_name.splitn(2, '/').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid model name: {}", model_name));
    }
    Ok(exe_dir
        .join(".embedding-models")
        .join(parts[0])
        .join(parts[1]))
}
```

with:

```rust
fn embedding_model_dir_for(
    app: &tauri::AppHandle,
    model_name: &str,
) -> Result<PathBuf, String> {
    let base = crate::embedding_models_base_dir(app)?;
    Ok(base.join(crate::model_subpath(model_name)?))
}
```

- [ ] **Step 2: Thread `AppHandle` through the three commands that resolve the dir**

In `rag_get_model_dir` (lines 584-589), REPLACE:

```rust
#[tauri::command]
pub fn rag_get_model_dir(model_name: Option<String>) -> Result<String, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(name)?;
    Ok(dir.to_string_lossy().to_string())
}
```

with:

```rust
#[tauri::command]
pub fn rag_get_model_dir(
    app: tauri::AppHandle,
    model_name: Option<String>,
) -> Result<String, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(&app, name)?;
    Ok(dir.to_string_lossy().to_string())
}
```

In `rag_check_model` (lines 591-601), REPLACE:

```rust
#[tauri::command]
pub fn rag_check_model(model_name: Option<String>) -> Result<bool, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(name)?;
    for file in MODEL_FILES {
        if !dir.join(file).exists() {
            return Ok(false);
        }
    }
    Ok(true)
}
```

with:

```rust
#[tauri::command]
pub fn rag_check_model(
    app: tauri::AppHandle,
    model_name: Option<String>,
) -> Result<bool, String> {
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(&app, name)?;
    for file in MODEL_FILES {
        if !dir.join(file).exists() {
            return Ok(false);
        }
    }
    Ok(true)
}
```

In `rag_download_model` (line 613-615), the function already takes `app: tauri::AppHandle`. REPLACE the dir line:

```rust
    let dir = embedding_model_dir_for(name)?;
```

with:

```rust
    let dir = embedding_model_dir_for(&app, name)?;
```

- [ ] **Step 3: Add the `rag_model_required_files` command**

In `src-tauri/src/commands/rag.rs`, immediately AFTER the `rag_check_model` function, ADD:

```rust
/// The relative paths the frontend must show the user for manual model
/// placement when automatic download is unavailable (e.g. blocked network).
#[tauri::command]
pub fn rag_model_required_files(_model_name: Option<String>) -> Vec<String> {
    MODEL_FILES.iter().map(|s| s.to_string()).collect()
}
```

- [ ] **Step 4: Register the new command**

In `src-tauri/src/lib.rs`, in the `tauri::generate_handler!` list under `// RAG operations`, ADD after `commands::rag::rag_check_model,`:

```rust
            commands::rag::rag_model_required_files,
```

(Compile/commit happens at the end of Task 4.)

---

## Task 3: Wire `speech.rs` to the shared base

**Files:**
- Modify: `src-tauri/src/commands/speech.rs`

- [ ] **Step 1: Update `speech_model_dir_for`**

In `src-tauri/src/commands/speech.rs`, REPLACE the function (lines 27-38):

```rust
fn speech_model_dir_for(model_name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().ok_or("Cannot determine app directory")?;
    let parts: Vec<&str> = model_name.splitn(2, '/').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid model name: {}", model_name));
    }
    Ok(exe_dir
        .join(".embedding-models")
        .join(parts[0])
        .join(parts[1]))
}
```

with:

```rust
fn speech_model_dir_for(
    app: &tauri::AppHandle,
    model_name: &str,
) -> Result<PathBuf, String> {
    let base = crate::embedding_models_base_dir(app)?;
    Ok(base.join(crate::model_subpath(model_name)?))
}
```

- [ ] **Step 2: Thread `AppHandle` through the speech commands**

In `speech_check_model` (lines 48-58), REPLACE:

```rust
#[tauri::command]
pub fn speech_check_model(model_name: String) -> Result<bool, String> {
    let dir = speech_model_dir_for(&model_name)?;
```

with:

```rust
#[tauri::command]
pub fn speech_check_model(
    app: tauri::AppHandle,
    model_name: String,
) -> Result<bool, String> {
    let dir = speech_model_dir_for(&app, &model_name)?;
```

In `speech_get_model_dir` (lines 60-64), REPLACE:

```rust
#[tauri::command]
pub fn speech_get_model_dir(model_name: String) -> Result<String, String> {
    let dir = speech_model_dir_for(&model_name)?;
    Ok(dir.to_string_lossy().to_string())
}
```

with:

```rust
#[tauri::command]
pub fn speech_get_model_dir(
    app: tauri::AppHandle,
    model_name: String,
) -> Result<String, String> {
    let dir = speech_model_dir_for(&app, &model_name)?;
    Ok(dir.to_string_lossy().to_string())
}
```

In `speech_download_model` (line 80, already has `app: tauri::AppHandle`), REPLACE:

```rust
    let dir = speech_model_dir_for(&model_name)?;
```

with:

```rust
    let dir = speech_model_dir_for(&app, &model_name)?;
```

(Compile/commit happens at the end of Task 4.)

---

## Task 4: Update the `models://` protocol handler + compile + commit

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Use the app handle to resolve the base in the protocol handler**

In `src-tauri/src/lib.rs`, the protocol closure currently starts with `.register_uri_scheme_protocol("models", |_ctx, request| {`. REPLACE `|_ctx, request|` with `|ctx, request|`.

Then REPLACE this block (lines 78-81):

```rust
            let base = match embedding_models_base_dir() {
                Some(b) => b,
                None => return error_response(500),
            };
```

with:

```rust
            let base = match embedding_models_base_dir(ctx.app_handle()) {
                Ok(b) => b,
                Err(_) => return error_response(500),
            };
```

- [ ] **Step 2: Compile the whole crate**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: PASS (clean build, no errors).

- [ ] **Step 3: Run the Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, including `model_subpath_splits_org_and_model` and `model_subpath_rejects_missing_slash`.

- [ ] **Step 4: Commit Tasks 1-4**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands/rag.rs src-tauri/src/commands/speech.rs
git commit -m "fix(rag,speech): store models under app_local_data_dir (fixes os error 5)

Model files were written next to the executable; under an MSI (perMachine)
install that is C:\\Program Files\\... and read-only, so download failed with
ERROR_ACCESS_DENIED. Resolve the model dir via app_local_data_dir() instead,
shared by the models:// protocol and the RAG/speech commands. Adds
rag_model_required_files for the manual-placement UX.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Bundle ONNX Runtime WASM locally (TDD on the config helper)

**Files:**
- Create: `src/shared/lib/ort-wasm.ts`
- Create: `src/shared/lib/ort-wasm.test.ts`
- Modify: `src/features/rag/hooks/useLocalEmbedding.ts`
- Modify: `src/features/speech/workers/speech-worker.ts`
- Modify: `vite.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing test**

Create `src/shared/lib/ort-wasm.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { configureLocalWasm } from "./ort-wasm";

describe("configureLocalWasm", () => {
  it("points wasmPaths at the local /ort/ dir and forces single thread", () => {
    const env: any = { backends: { onnx: { wasm: {} } } };
    configureLocalWasm(env);
    expect(env.backends.onnx.wasm.wasmPaths).toBe("/ort/");
    expect(env.backends.onnx.wasm.numThreads).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ort-wasm`
Expected: FAIL — `Failed to resolve import "./ort-wasm"` / module not found.

- [ ] **Step 3: Implement the helper**

Create `src/shared/lib/ort-wasm.ts`:

```ts
// Configure onnxruntime-web (through the transformers.js `env`) to load its
// WASM backend from the locally bundled copy under `/ort/` instead of the
// default jsDelivr CDN. Without this, pipeline initialization fetches the
// `.wasm` from the CDN, which hangs forever on a network-restricted/proxy
// machine (the "Building..." freeze). The files are copied into `public/ort/`
// by the `copy-ort-wasm` Vite plugin (see vite.config.ts).
//
// `numThreads = 1` avoids the multi-threaded ORT build, which needs
// cross-origin isolation (COOP/COEP) that the WebView2 app origin does not set.
export function configureLocalWasm(env: any): void {
  env.backends.onnx.wasm.wasmPaths = "/ort/";
  env.backends.onnx.wasm.numThreads = 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ort-wasm`
Expected: PASS.

- [ ] **Step 5: Call the helper in the RAG loader**

In `src/features/rag/hooks/useLocalEmbedding.ts`, ADD the import after line 2 (`import { invoke } ...`):

```ts
import { configureLocalWasm } from "@/shared/lib/ort-wasm";
```

Then, immediately AFTER the existing line `const { pipeline, env } = transformers;` (currently line 59), ADD:

```ts
        configureLocalWasm(env);
```

- [ ] **Step 6: Call the helper in the speech worker**

In `src/features/speech/workers/speech-worker.ts`, ADD at the top of the file (after the closing `*/` of the header comment, before `let transcriber`):

```ts
import { configureLocalWasm } from "../../../shared/lib/ort-wasm";
```

Then, immediately AFTER the existing line `const { pipeline, env } = await import("@huggingface/transformers");` (currently line 34), ADD:

```ts
        configureLocalWasm(env);
```

- [ ] **Step 7: Add the Vite copy plugin**

In `vite.config.ts`, REPLACE the entire file with:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "node:fs";

// Copy the onnxruntime-web WASM backend (the exact version bundled with
// @huggingface/transformers) into public/ort so it is served from the app's
// own local origin instead of the jsDelivr CDN. Runs in both `vite` (dev) and
// `vite build` via the buildStart hook.
function copyOrtWasm() {
  const files = [
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
  ];
  const srcDir = path.resolve(
    __dirname,
    "node_modules/@huggingface/transformers/dist"
  );
  const destDir = path.resolve(__dirname, "public/ort");
  return {
    name: "copy-ort-wasm",
    buildStart() {
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of files) {
        const src = path.join(srcDir, f);
        if (!fs.existsSync(src)) {
          throw new Error(`copy-ort-wasm: missing source file ${src}`);
        }
        fs.copyFileSync(src, path.join(destDir, f));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyOrtWasm()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  worker: {
    format: "es",
  },
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  optimizeDeps: {
    include: ["mermaid", "highlight.js", "docx", "marked", "katex", "monaco-editor"],
    exclude: [
      "@tauri-apps/api",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-fs",
      "@huggingface/transformers",
      "onnxruntime-web",
    ],
  },
});
```

- [ ] **Step 8: Ignore the copied artifacts**

Append to `.gitignore`:

```
# Copied at build time by the copy-ort-wasm Vite plugin
public/ort/
```

- [ ] **Step 9: Verify the build copies the files and the bundle compiles**

Run: `npm run build`
Expected: PASS; `public/ort/ort-wasm-simd-threaded.jsep.wasm` and `...jsep.mjs` exist, and `dist/ort/` contains both files.

- [ ] **Step 10: Commit**

```bash
git add src/shared/lib/ort-wasm.ts src/shared/lib/ort-wasm.test.ts src/features/rag/hooks/useLocalEmbedding.ts src/features/speech/workers/speech-worker.ts vite.config.ts .gitignore
git commit -m "fix(rag,speech): serve ONNX WASM locally instead of CDN (fixes Building hang)

Pipeline init fetched the onnxruntime-web .wasm from jsDelivr, which hangs on a
restricted/proxy network. Copy the version-matched WASM into public/ort and set
env.backends.onnx.wasm.wasmPaths=/ort/ with numThreads=1 in both the RAG hook
and the speech worker.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Manual model-placement UX (TDD on the classifier)

**Files:**
- Create: `src/features/rag/lib/model-error.ts`
- Create: `src/features/rag/lib/model-error.test.ts`
- Modify: `src/features/rag/hooks/useLocalEmbedding.ts`
- Modify: `src/features/rag/hooks/useRagFeatures.ts`
- Modify: `src/features/rag/components/RagPanel.tsx`
- Modify: `src/shared/i18n/locales/en/common.json`
- Modify: `src/shared/i18n/locales/ja/common.json`

- [ ] **Step 1: Write the failing test for the error classifier**

Create `src/features/rag/lib/model-error.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyRagError } from "./model-error";

describe("classifyRagError", () => {
  it("returns null when there is no error", () => {
    expect(classifyRagError(null, null)).toBe(null);
  });
  it("detects a missing model from embedError", () => {
    expect(classifyRagError(null, "MODEL_MISSING")).toBe("modelMissing");
  });
  it("detects a missing model embedded in buildError text", () => {
    expect(classifyRagError("Error: MODEL_MISSING", null)).toBe("modelMissing");
  });
  it("prefers modelMissing over network", () => {
    expect(classifyRagError("MODEL_MISSING NETWORK_ERROR", null)).toBe("modelMissing");
  });
  it("detects network, download, engine, and generic", () => {
    expect(classifyRagError(null, "NETWORK_ERROR")).toBe("network");
    expect(classifyRagError("DOWNLOAD_ERROR:x", null)).toBe("download");
    expect(classifyRagError("ENGINE_CRASH:123", null)).toBe("engine");
    expect(classifyRagError("something else", null)).toBe("generic");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- model-error`
Expected: FAIL — module `./model-error` not found.

- [ ] **Step 3: Implement the classifier**

Create `src/features/rag/lib/model-error.ts`:

```ts
export type RagErrorKind =
  | "modelMissing"
  | "network"
  | "download"
  | "engine"
  | "generic"
  | null;

// Map the raw build/embed error strings to a single UI category. Order matters:
// a missing model (download unavailable) takes priority so the manual-placement
// guidance is shown instead of a generic network message.
export function classifyRagError(
  buildError: string | null,
  embedError: string | null
): RagErrorKind {
  const has = (s: string) =>
    (buildError?.includes(s) ?? false) || (embedError?.includes(s) ?? false);
  if (has("MODEL_MISSING")) return "modelMissing";
  if (has("NETWORK_ERROR")) return "network";
  if (has("DOWNLOAD_ERROR")) return "download";
  if (has("ENGINE_CRASH")) return "engine";
  if (buildError || embedError) return "generic";
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- model-error`
Expected: PASS.

- [ ] **Step 5: Surface MODEL_MISSING + placement data from the loader**

In `src/features/rag/hooks/useLocalEmbedding.ts`:

(a) Add module-level state for placement info. After the existing line `let pipelinePromise: Promise<void> | null = null;` (line 8), ADD:

```ts
let manualPlacementInfo: { dir: string; files: string[] } | null = null;
```

(b) REPLACE the download block (currently lines 47-53):

```ts
        // Check if model exists locally, download if not
        const modelExists = await invoke<boolean>("rag_check_model", { modelName });
        if (!modelExists) {
          setStatus("downloading");
          setProgress(0);
          await invoke("rag_download_model", { modelName });
        }
```

with:

```ts
        // Check if model exists locally, download if not. When download is
        // unavailable (offline / blocked network), surface the exact folder and
        // files so the user can place the model manually.
        const modelExists = await invoke<boolean>("rag_check_model", { modelName });
        if (!modelExists) {
          setStatus("downloading");
          setProgress(0);
          try {
            await invoke("rag_download_model", { modelName });
          } catch (dlErr) {
            const dir = await invoke<string>("rag_get_model_dir", { modelName });
            const files = await invoke<string[]>("rag_model_required_files", { modelName });
            manualPlacementInfo = { dir, files };
            throw new Error("MODEL_MISSING");
          }
        }
```

(c) In the `catch (e: any)` block (currently lines 109-125), ADD a branch BEFORE the `if (msg.includes("NETWORK_ERROR:"))` check:

```ts
        if (msg === "MODEL_MISSING" || msg.includes("MODEL_MISSING")) {
          setError("MODEL_MISSING");
        } else if (msg.includes("NETWORK_ERROR:")) {
```

(i.e. change the existing `if (msg.includes("NETWORK_ERROR:")) {` to `} else if (msg.includes("NETWORK_ERROR:")) {` and prepend the MODEL_MISSING branch.)

(d) Add a getter so the panel can read placement info. REPLACE the hook's return statement (currently line 149):

```ts
  return { status, progress, error, load, embed, embedBatch } as const;
```

with:

```ts
  const getManualPlacement = useCallback(() => manualPlacementInfo, []);
  return { status, progress, error, load, embed, embedBatch, getManualPlacement } as const;
```

- [ ] **Step 6: Pass placement info through `useRagFeatures`**

In `src/features/rag/hooks/useRagFeatures.ts`:

(a) REPLACE the destructure (line 81):

```ts
  const { status: embedStatus, progress: embedProgress, error: embedError, load: loadEmbed, embed, embedBatch } = useLocalEmbedding();
```

with:

```ts
  const { status: embedStatus, progress: embedProgress, error: embedError, load: loadEmbed, embed, embedBatch, getManualPlacement } = useLocalEmbedding();
```

(b) REPLACE the return object's opening (line 288 `return {` through the listed fields) by ADDING `getManualPlacement,` to the returned object. Concretely, in the `return { ... }` block add a line after `embedError,`:

```ts
    getManualPlacement,
```

- [ ] **Step 7: Add i18n strings (English)**

In `src/shared/i18n/locales/en/common.json`, add these keys (next to the other `rag*` keys):

```json
  "ragModelMissingTitle": "Model files not found",
  "ragModelMissingInstructions": "Automatic download is unavailable (offline or restricted network). Place the model files in the folder below, then click Re-check.",
  "ragModelMissingFolder": "Model folder",
  "ragModelMissingFiles": "Required files",
  "ragModelMissingSource": "Download these files on another machine from:",
  "ragOpenModelFolder": "Open folder",
  "ragModelRecheck": "Re-check",
```

- [ ] **Step 8: Add i18n strings (Japanese)**

In `src/shared/i18n/locales/ja/common.json`, add the matching keys:

```json
  "ragModelMissingTitle": "モデルファイルが見つかりません",
  "ragModelMissingInstructions": "自動ダウンロードが利用できません(オフラインまたは制限ネットワーク)。下のフォルダにモデルファイルを配置してから「再確認」を押してください。",
  "ragModelMissingFolder": "モデルフォルダ",
  "ragModelMissingFiles": "必要なファイル",
  "ragModelMissingSource": "別のマシンで以下から取得してください:",
  "ragOpenModelFolder": "フォルダを開く",
  "ragModelRecheck": "再確認",
```

- [ ] **Step 9: Render the manual-placement panel in `RagPanel.tsx`**

In `src/features/rag/components/RagPanel.tsx`:

(a) Add the import near the other imports at the top of the file:

```ts
import { classifyRagError } from "../lib/model-error";
```

(b) Add `getManualPlacement` to the destructured `useRagFeatures(...)` result (around lines 25-39, alongside `embedError`):

```ts
    getManualPlacement,
```

(c) REPLACE the entire error block (lines 216-226):

```tsx
      {(buildError || embedError) && (
        <div className="rag-panel__error">
          {(embedError === "NETWORK_ERROR" || buildError?.includes("NETWORK_ERROR"))
            ? t("ragNetworkError")
            : (embedError === "DOWNLOAD_ERROR" || buildError?.includes("DOWNLOAD_ERROR"))
              ? t("ragDownloadError")
              : (buildError?.includes("ENGINE_CRASH") || embedError?.includes("ENGINE_CRASH"))
                ? t("ragEngineError")
                : `${t("ragBuildError")}: ${buildError || embedError}`}
        </div>
      )}
```

with:

```tsx
      {(() => {
        const kind = classifyRagError(buildError, embedError);
        if (!kind) return null;
        if (kind === "modelMissing") {
          const info = getManualPlacement();
          const sourceUrl = `https://huggingface.co/${ragSettings.embeddingModel}/tree/main`;
          return (
            <div className="rag-panel__error">
              <div className="rag-panel__error-title">{t("ragModelMissingTitle")}</div>
              <p>{t("ragModelMissingInstructions")}</p>
              {info && (
                <>
                  <div>{t("ragModelMissingFolder")}:</div>
                  <code className="rag-panel__error-path">{info.dir}</code>
                  <div>{t("ragModelMissingFiles")}:</div>
                  <ul className="rag-panel__error-files">
                    {info.files.map((f) => (
                      <li key={f}><code>{f}</code></li>
                    ))}
                  </ul>
                  <div>{t("ragModelMissingSource")}</div>
                  <code className="rag-panel__error-path">{sourceUrl}</code>
                  <div className="rag-panel__error-actions">
                    <button
                      className="rag-panel__btn"
                      onClick={async () => {
                        await invoke("create_folder", { path: info.dir });
                        await invoke("open_in_default_app", { path: info.dir });
                      }}
                    >
                      {t("ragOpenModelFolder")}
                    </button>
                    <button className="rag-panel__btn" onClick={buildIndex}>
                      {t("ragModelRecheck")}
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        }
        return (
          <div className="rag-panel__error">
            {kind === "network"
              ? t("ragNetworkError")
              : kind === "download"
                ? t("ragDownloadError")
                : kind === "engine"
                  ? t("ragEngineError")
                  : `${t("ragBuildError")}: ${buildError || embedError}`}
          </div>
        );
      })()}
```

(d) Confirm `invoke` is already imported in `RagPanel.tsx` (it is used at line 63). If not present, add `import { invoke } from "@tauri-apps/api/core";`.

- [ ] **Step 10: Run frontend tests + typecheck/build**

Run: `npm test`
Expected: PASS (ort-wasm + model-error suites green).

Run: `npm run build`
Expected: PASS (tsc + vite build, no type errors).

- [ ] **Step 11: Commit**

```bash
git add src/features/rag/lib/model-error.ts src/features/rag/lib/model-error.test.ts src/features/rag/hooks/useLocalEmbedding.ts src/features/rag/hooks/useRagFeatures.ts src/features/rag/components/RagPanel.tsx src/shared/i18n/locales/en/common.json src/shared/i18n/locales/ja/common.json
git commit -m "feat(rag): manual model placement UX for blocked networks

When a model is absent and download is unavailable, show the exact target
folder, required files, and source URL with Open-folder and Re-check actions
instead of a generic network error.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full Rust test + build**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 2: Full frontend test + build**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 3: Manual verification matrix (record results)**

Perform on a dev machine (and note any that require the restricted environment):

1. **Offline WASM** — `npm run tauri dev`, open RAG panel, open DevTools Network, trigger Build Index. Confirm: NO request to `cdn.jsdelivr.net` (or any external host) for `ort-wasm-*`. The `.wasm`/`.mjs` load from the local origin under `/ort/`.
2. **Manual placement path** — with a model not present and network blocked/offline, Build Index shows the manual-placement panel with a path under `...\AppData\Local\com.mdium.app\.embedding-models\<org>\<model>`. "Open folder" opens that directory.
3. **Manual placement works** — copy the required files into that folder, click Re-check, confirm indexing runs offline and the index is created.
4. **MSI smoke test** — `npm run tauri build`, install the MSI, confirm the model directory resolves under `AppData\Local` (not `Program Files`) and there is no `os error 5`.

- [ ] **Step 4: Update the design spec status**

In `.superpowers/specs/2026-06-03-rag-offline-blocked-env-design.md`, change the front-matter `status: approved` to `status: implemented`, then commit:

```bash
git add .superpowers/specs/2026-06-03-rag-offline-blocked-env-design.md
git commit -m "docs(rag): mark offline/blocked-env spec implemented

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** RC1 → Tasks 1-4 (shared `app_local_data_dir` base for protocol + RAG + speech). RC2 → Task 5 (local WASM + numThreads=1, both entry points, Vite copy). RC3 → Task 6 (manual placement). Testing section → Tasks 1 (Rust unit), 5/6 (Vitest units), 7 (offline-network + MSI manual checks). All "Affected Files" from the spec appear in a task.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code.
- **Type/name consistency:** `model_subpath` / `embedding_models_base_dir(&AppHandle)` defined in Task 1 and consumed in Tasks 2-4; `configureLocalWasm` defined in Task 5 Step 3 and called in Steps 5-6; `classifyRagError`/`RagErrorKind` defined in Task 6 Step 3 and used in Step 9; `getManualPlacement` defined in Step 5(d), threaded in Step 6, consumed in Step 9; `rag_model_required_files` registered (Task 2 Step 4) and invoked (Task 6 Step 5b).
- **Compile-unit note:** Tasks 1-4 are committed together because the signature change to `embedding_models_base_dir` makes the tree non-compiling until the protocol handler is updated.

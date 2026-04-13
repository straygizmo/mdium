# Add harrier-oss-v1-270m-ONNX RAG Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `onnx-community/harrier-oss-v1-270m-ONNX` as a selectable RAG embedding model alongside the existing five, taking advantage of its 32K context window and stronger MTEB score without disturbing existing indices.

**Architecture:** Harrier uses a different transformers.js API path (`AutoModel`+`AutoTokenizer` with `sentence_embedding` output) than the existing pipeline-based models, plus a different prefix format (`Instruct:\nQuery:`), different dtype (`q4f16`), and ships ONNX weights as an external `.onnx_data` companion file. We keep both code paths inside one hook by unifying them behind an `embedFn` closure built at load time; we keep both file lists inside one Rust function that branches on model name. One new `<option>` and one type-union entry round it out.

**Tech Stack:** TypeScript, React 19, Tauri 2, Rust (backend download command), `@huggingface/transformers` ^3.8.1, zustand (settings store).

**Spec:** `.superpowers/specs/2026-04-13-add-harrier-rag-model-design.md`

**Test Strategy Note:** This project has no automated test harness for the RAG feature (indexing hits real files and real ONNX models; chunks are stored in SQLite via Tauri commands). Verification relies on **TypeScript (`pnpm run build` or `tsc --noEmit`)**, **Rust (`cargo check` under `src-tauri/`)**, and a **manual test plan** (Task 6). Each code-modifying task ends with a discrete verification command and a commit.

**File Structure:**

| File | Role | Action |
|---|---|---|
| `src/shared/types/index.ts` | shared types | extend `RagSettings.embeddingModel` union |
| `src-tauri/src/commands/rag.rs` | Tauri RAG commands | replace `const MODEL_FILES` with `model_files_for()`; update two call sites |
| `src/features/rag/hooks/useLocalEmbedding.ts` | embedding loader hook | refactor to `embedFn` closure, add harrier `AutoModel` path, extend dtype/prefix helpers |
| `src/features/rag/components/RagPanel.tsx` | RAG settings UI | add one `<option>` to the model dropdown |

No other files are touched. `useRagFeatures`, the settings store, i18n resources, and CSS stay as-is.

---

## Task 1: Extend `RagSettings.embeddingModel` Type Union

Adds the new model identifier to the TypeScript union so downstream code (settings store, panel, hooks) can reference it without a cast.

**Files:**
- Modify: `src/shared/types/index.ts:91-93`

- [ ] **Step 1: Extend the union**

In `src/shared/types/index.ts`, find:

```ts
/** RAG settings */
export interface RagSettings {
  embeddingModel: "Xenova/multilingual-e5-large" | "Xenova/multilingual-e5-base" | "Xenova/multilingual-e5-small" | "sirasagi62/ruri-v3-30m-ONNX" | "sirasagi62/ruri-v3-130m-ONNX";
```

Replace the `embeddingModel` line with:

```ts
  embeddingModel:
    | "Xenova/multilingual-e5-large"
    | "Xenova/multilingual-e5-base"
    | "Xenova/multilingual-e5-small"
    | "sirasagi62/ruri-v3-30m-ONNX"
    | "sirasagi62/ruri-v3-130m-ONNX"
    | "onnx-community/harrier-oss-v1-270m-ONNX";
```

- [ ] **Step 2: Typecheck**

Run: `pnpm run build` (or `npx tsc --noEmit` if build is slow)
Expected: PASS — no type errors. If the project build script does more than typecheck, use `npx tsc --noEmit` to stay fast.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/index.ts
git commit -m "feat(rag): add harrier-oss-v1-270m to embedding model type union"
```

---

## Task 2: Rust Backend — Per-Model File List

Replace the hardcoded `MODEL_FILES` constant with a function that returns the correct file list per model family, so the downloader fetches harrier's `q4f16` variant plus its `.onnx_data` companion file when harrier is selected.

**Files:**
- Modify: `src-tauri/src/commands/rag.rs:505-542`
- Modify: `src-tauri/src/commands/rag.rs:555-600` (downloader loop)

- [ ] **Step 1: Add `model_files_for()` helper and remove the const**

In `src-tauri/src/commands/rag.rs`, find:

```rust
const DEFAULT_MODEL_NAME: &str = "Xenova/multilingual-e5-large";
const MODEL_FILES: &[&str] = &[
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/model_quantized.onnx",
];
```

Replace with:

```rust
const DEFAULT_MODEL_NAME: &str = "Xenova/multilingual-e5-large";

fn model_files_for(model_name: &str) -> &'static [&'static str] {
    if model_name.contains("harrier") {
        &[
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "onnx/model_q4f16.onnx",
            "onnx/model_q4f16.onnx_data",
        ]
    } else {
        &[
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "onnx/model_quantized.onnx",
        ]
    }
}
```

- [ ] **Step 2: Update `rag_check_model`**

Find the `rag_check_model` function (around line 534):

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

Replace the `for file in MODEL_FILES {` line with:

```rust
    for file in model_files_for(name) {
```

(Only that one line changes.)

- [ ] **Step 3: Update `rag_download_model`**

Find the `rag_download_model` function (around line 555). Two edits are needed inside it:

First, find:

```rust
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(name)?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("NETWORK_ERROR:{}", e))?;
    let file_count = MODEL_FILES.len();

    for (idx, &file) in MODEL_FILES.iter().enumerate() {
```

Replace with:

```rust
    let name = model_name.as_deref().unwrap_or(DEFAULT_MODEL_NAME);
    let dir = embedding_model_dir_for(name)?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("NETWORK_ERROR:{}", e))?;
    let files = model_files_for(name);
    let file_count = files.len();

    for (idx, &file) in files.iter().enumerate() {
```

- [ ] **Step 4: Verify the Rust build**

Run: `cd src-tauri && cargo check`
Expected: PASS — no warnings about `MODEL_FILES` being unused, no errors. If you see `unused constant MODEL_FILES`, you missed removing it in Step 1.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/rag.rs
git commit -m "feat(rag): make embedding model file list per-model"
```

---

## Task 3: Refactor `useLocalEmbedding` to `embedFn` Closure (Prep, No Behavior Change)

Restructure the hook so both embedding families can share a unified public API. This task changes no runtime behavior — it only converts the cached `pipelineInstance` global into a generic `embedFn` closure that today is built from `pipeline()`. Task 4 then plugs in the harrier path.

**Files:**
- Modify: `src/features/rag/hooks/useLocalEmbedding.ts` (full rewrite of the module body)

- [ ] **Step 1: Rewrite the module**

Replace the entire contents of `src/features/rag/hooks/useLocalEmbedding.ts` with:

```ts
import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

type EmbedFn = (input: string) => Promise<Float32Array>;

let embedFn: EmbedFn | null = null;
let loadedModelName: string | null = null;
let pipelinePromise: Promise<void> | null = null;

function getDtype(_modelName: string): string {
  // Per-model dtype map. Harrier is added in Task 4.
  return "q8";
}

function getPrefix(modelName: string | null, type: "query" | "passage"): string {
  if (modelName && modelName.includes("ruri")) {
    return type === "query" ? "Search query: " : "Search document: ";
  }
  return type === "query" ? "query: " : "passage: ";
}

export function useLocalEmbedding() {
  const [status, setStatus] = useState<
    "idle" | "downloading" | "loading" | "ready" | "error"
  >(embedFn ? "ready" : "idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (modelName: string = "Xenova/multilingual-e5-large") => {
    // If a different model is requested, clear the cached embed fn
    if (embedFn && loadedModelName !== modelName) {
      embedFn = null;
      pipelinePromise = null;
      loadedModelName = null;
    }

    if (embedFn) {
      setStatus("ready");
      return;
    }
    if (pipelinePromise) {
      await pipelinePromise;
      setStatus("ready");
      return;
    }

    setStatus("loading");
    setProgress(0);

    pipelinePromise = (async () => {
      try {
        // Check if model exists locally, download if not
        const modelExists = await invoke<boolean>("rag_check_model", { modelName });
        if (!modelExists) {
          setStatus("downloading");
          setProgress(0);
          await invoke("rag_download_model", { modelName });
        }

        setStatus("loading");
        setProgress(10);

        const transformers = await import("@huggingface/transformers");
        const { pipeline, env } = transformers;

        // Use custom "models" protocol registered in Rust to serve model files
        // On Windows: http://models.localhost/<path>
        env.remoteHost = "http://models.localhost/";
        env.remotePathTemplate = "{model}/";
        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.useBrowserCache = false;

        const progressCallback = (p: any) => {
          if (p.status === "progress" && p.progress != null) {
            setProgress(10 + Math.round(p.progress * 0.9));
          }
        };

        const pipe = await pipeline(
          "feature-extraction",
          modelName,
          {
            dtype: getDtype(modelName),
            revision: "",
            progress_callback: progressCallback,
          } as any
        );
        embedFn = async (input) => {
          const r = await pipe(input, { pooling: "mean", normalize: true });
          return r.data as Float32Array;
        };

        loadedModelName = modelName;
        setStatus("ready");
        setProgress(100);
      } catch (e: any) {
        console.error("[RAG] Model load failed:", e);
        const msg = e.message ?? String(e);
        if (msg.includes("NETWORK_ERROR:")) {
          setError("NETWORK_ERROR");
        } else if (msg.includes("DOWNLOAD_ERROR:")) {
          setError("DOWNLOAD_ERROR");
        } else {
          setError(msg);
        }
        setStatus("error");
        pipelinePromise = null;
        throw e;
      }
    })();

    await pipelinePromise;
  }, []);

  const embed = useCallback(async (text: string, type: "query" | "passage" = "query"): Promise<number[]> => {
    if (!embedFn) throw new Error("Model not loaded");
    const prefix = getPrefix(loadedModelName, type);
    const data = await embedFn(`${prefix}${text}`);
    return Array.from(data);
  }, []);

  const embedBatch = useCallback(
    async (texts: string[]): Promise<number[][]> => {
      const results: number[][] = [];
      for (const text of texts) {
        results.push(await embed(text));
      }
      return results;
    },
    [embed]
  );

  return { status, progress, error, load, embed, embedBatch } as const;
}
```

Key differences from the previous version:

- Module-level `pipelineInstance: any` is replaced by `embedFn: EmbedFn | null`
- `getDtype()` helper added (currently only returns `"q8"` — Task 4 extends it)
- Public `embed()` no longer knows about `pipeline()` — it just calls `embedFn`
- The pipeline path now constructs an `embedFn` closure that captures the `pipe` reference

- [ ] **Step 2: Typecheck**

Run: `pnpm run build` (or `npx tsc --noEmit`)
Expected: PASS — no type errors.

- [ ] **Step 3: Smoke-test in the app**

This is not optional — the refactor alters the cached global. Run the dev server, open an existing folder with a populated RAG index, switch into the RAG panel, and run one query against it using one of the existing e5 models. Confirm results come back normally.

```bash
pnpm run tauri dev
```

Expected: query returns the same ranked results as before the refactor (no regression in the existing pipeline path).

- [ ] **Step 4: Commit**

```bash
git add src/features/rag/hooks/useLocalEmbedding.ts
git commit -m "refactor(rag): unify embedding loader behind embedFn closure"
```

---

## Task 4: Add Harrier Load Path to `useLocalEmbedding`

Plug the `AutoModel`+`AutoTokenizer` path into the hook so that when the user selects harrier, the loader builds an `embedFn` backed by it. Also extend the `getDtype` and `getPrefix` helpers.

**Files:**
- Modify: `src/features/rag/hooks/useLocalEmbedding.ts` (targeted edits to helpers and the load body)

- [ ] **Step 1: Extend the helpers**

In `src/features/rag/hooks/useLocalEmbedding.ts`, find:

```ts
function getDtype(_modelName: string): string {
  // Per-model dtype map. Harrier is added in Task 4.
  return "q8";
}

function getPrefix(modelName: string | null, type: "query" | "passage"): string {
  if (modelName && modelName.includes("ruri")) {
    return type === "query" ? "Search query: " : "Search document: ";
  }
  return type === "query" ? "query: " : "passage: ";
}
```

Replace with:

```ts
const isHarrier = (name: string | null): boolean => !!name && name.includes("harrier");

function getDtype(modelName: string): string {
  if (isHarrier(modelName)) return "q4f16";
  return "q8";
}

function getPrefix(modelName: string | null, type: "query" | "passage"): string {
  if (isHarrier(modelName)) {
    if (type === "query") {
      return "Instruct: Given a question, retrieve relevant markdown notes that answer it\nQuery: ";
    }
    return "";
  }
  if (modelName && modelName.includes("ruri")) {
    return type === "query" ? "Search query: " : "Search document: ";
  }
  return type === "query" ? "query: " : "passage: ";
}
```

- [ ] **Step 2: Add the harrier load branch**

Still in `src/features/rag/hooks/useLocalEmbedding.ts`, find the pipeline load block inside `load()`:

```ts
        const transformers = await import("@huggingface/transformers");
        const { pipeline, env } = transformers;

        // Use custom "models" protocol registered in Rust to serve model files
        // On Windows: http://models.localhost/<path>
        env.remoteHost = "http://models.localhost/";
        env.remotePathTemplate = "{model}/";
        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.useBrowserCache = false;

        const progressCallback = (p: any) => {
          if (p.status === "progress" && p.progress != null) {
            setProgress(10 + Math.round(p.progress * 0.9));
          }
        };

        const pipe = await pipeline(
          "feature-extraction",
          modelName,
          {
            dtype: getDtype(modelName),
            revision: "",
            progress_callback: progressCallback,
          } as any
        );
        embedFn = async (input) => {
          const r = await pipe(input, { pooling: "mean", normalize: true });
          return r.data as Float32Array;
        };
```

Replace with:

```ts
        const transformers = await import("@huggingface/transformers");
        const { pipeline, AutoModel, AutoTokenizer, env } = transformers;

        // Use custom "models" protocol registered in Rust to serve model files
        // On Windows: http://models.localhost/<path>
        env.remoteHost = "http://models.localhost/";
        env.remotePathTemplate = "{model}/";
        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.useBrowserCache = false;

        const progressCallback = (p: any) => {
          if (p.status === "progress" && p.progress != null) {
            setProgress(10 + Math.round(p.progress * 0.9));
          }
        };

        if (isHarrier(modelName)) {
          const tokenizer = await AutoTokenizer.from_pretrained(modelName, {
            revision: "",
            progress_callback: progressCallback,
          } as any);
          const model = await AutoModel.from_pretrained(modelName, {
            dtype: getDtype(modelName),
            revision: "",
            progress_callback: progressCallback,
          } as any);
          embedFn = async (input) => {
            const inputs = tokenizer(input, { padding: true, truncation: true });
            const out: any = await (model as any)(inputs);
            // Harrier outputs `sentence_embedding` (last-token pooled + L2-normalized)
            return out.sentence_embedding.data as Float32Array;
          };
        } else {
          const pipe = await pipeline(
            "feature-extraction",
            modelName,
            {
              dtype: getDtype(modelName),
              revision: "",
              progress_callback: progressCallback,
            } as any
          );
          embedFn = async (input) => {
            const r = await pipe(input, { pooling: "mean", normalize: true });
            return r.data as Float32Array;
          };
        }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm run build` (or `npx tsc --noEmit`)
Expected: PASS — no type errors. The `as any` casts on tokenizer/model calls are intentional because `@huggingface/transformers` 3.x does not ship strict types for this API path.

- [ ] **Step 4: Commit**

```bash
git add src/features/rag/hooks/useLocalEmbedding.ts
git commit -m "feat(rag): add harrier embedding load path via AutoModel"
```

---

## Task 5: Add Harrier to the `RagPanel` Model Dropdown

Expose the model to the user. No language gating — harrier supports 94 languages.

**Files:**
- Modify: `src/features/rag/components/RagPanel.tsx:369-373`

- [ ] **Step 1: Insert the new `<option>`**

In `src/features/rag/components/RagPanel.tsx`, find:

```tsx
                  <option value="Xenova/multilingual-e5-large">multilingual-e5-large</option>
                  <option value="Xenova/multilingual-e5-base">multilingual-e5-base</option>
                  <option value="Xenova/multilingual-e5-small">multilingual-e5-small</option>
                  {language === "ja" && <option value="sirasagi62/ruri-v3-30m-ONNX">ruri-v3-30m</option>}
                  {language === "ja" && <option value="sirasagi62/ruri-v3-130m-ONNX">ruri-v3-130m</option>}
```

Replace with:

```tsx
                  <option value="Xenova/multilingual-e5-large">multilingual-e5-large</option>
                  <option value="Xenova/multilingual-e5-base">multilingual-e5-base</option>
                  <option value="Xenova/multilingual-e5-small">multilingual-e5-small</option>
                  <option value="onnx-community/harrier-oss-v1-270m-ONNX">harrier-oss-v1-270m (long context)</option>
                  {language === "ja" && <option value="sirasagi62/ruri-v3-30m-ONNX">ruri-v3-30m</option>}
                  {language === "ja" && <option value="sirasagi62/ruri-v3-130m-ONNX">ruri-v3-130m</option>}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm run build` (or `npx tsc --noEmit`)
Expected: PASS. The new string value is already part of the `RagSettings.embeddingModel` union from Task 1, so the `as RagSettings["embeddingModel"]` cast at line 367 still holds.

- [ ] **Step 3: Commit**

```bash
git add src/features/rag/components/RagPanel.tsx
git commit -m "feat(rag): expose harrier-oss-v1-270m in model dropdown"
```

---

## Task 6: Manual Verification Pass

End-to-end check that the new path works against a real folder. **Do not skip this task** — there is no automated coverage and several risk factors (q4f16 on CPU, tokenizer shape, Instruct prefix handling) were flagged in the spec as needing runtime verification.

**Prerequisites:**
- A folder with 5+ Markdown notes, including at least one long note (>2k tokens)
- Dev server runs cleanly (`pnpm run tauri dev`)

- [ ] **Step 1: Start dev server**

```bash
pnpm run tauri dev
```

Wait for the app window to appear.

- [ ] **Step 2: Verify fresh download of harrier**

Before starting:

```bash
# Path is OS-specific. On Windows it's under the dev exe's directory.
# Find and delete the directory if it exists:
rm -rf ./src-tauri/target/debug/.embedding-models/onnx-community/harrier-oss-v1-270m-ONNX
```

Then, in the app: open a folder, open the RAG panel, open settings, change **Embedding Model** to `harrier-oss-v1-270m (long context)`, save.

Expected: status transitions `idle → downloading → loading → ready`. Five files should appear under `src-tauri/target/debug/.embedding-models/onnx-community/harrier-oss-v1-270m-ONNX/`:
- `config.json`
- `tokenizer.json`
- `tokenizer_config.json`
- `onnx/model_q4f16.onnx`
- `onnx/model_q4f16.onnx_data`

If the download fails with `NETWORK_ERROR:` or `DOWNLOAD_ERROR:`, check connectivity and retry. If only the `.onnx_data` file is missing, the plan's file list in Task 2 is wrong — revisit.

- [ ] **Step 3: Index the folder**

In the RAG panel, click the index/reindex button.

Expected:
- No error in the console or in the app's status message
- A new file `rag_harrier-oss-v1-270m-ONNX.db` appears in `<folder>/.mdium/`
- Chunk count matches what you see with other models for the same folder (long notes will produce fewer chunks because of the larger max-token window — that is the point)

- [ ] **Step 4: Sanity-check embedding dimension**

Open the new DB to confirm vectors are 640-dim. From the project root:

```bash
sqlite3 "<your-folder>/.mdium/rag_harrier-oss-v1-270m-ONNX.db" "SELECT length(embedding) FROM chunks LIMIT 1;"
```

Expected output: `5120` bytes (640 floats × 8 bytes per f64). If you see `8192`, harrier returned 1024-dim (wrong) and the `sentence_embedding` accessor is returning the wrong field — revisit Task 4 Step 2.

- [ ] **Step 5: Query — golden path**

In the RAG panel, run a query you already know the "correct" top result for in that folder. Compare against the same query under `multilingual-e5-base`.

Expected:
- Non-zero cosine scores
- The top result is the note you'd expect
- Scores are typically in the 0.4–0.8 range for relevant results (harrier's L2-normalized embeddings produce cosines similar to e5's)

- [ ] **Step 6: Query — long-note advantage check**

Run a query whose answer lives deep inside a long (>2k token) note — a passage that would have been chunked out of context by e5.

Expected: the long note ranks higher under harrier than under `multilingual-e5-base`. This is a qualitative check, not a hard assertion. If harrier ranks it significantly lower, the `Instruct:` query prefix may be wrong — re-check Task 4 Step 1.

- [ ] **Step 7: Model-switch regression check**

Switch back to `multilingual-e5-base`. Confirm:
- No re-download
- Existing index still loads and queries still return the same results as before the harrier work
- Switching back to harrier is also instant (both models cached locally)

- [ ] **Step 8: Edge case — empty/short note**

Ensure the folder contains at least one very short note (single heading + one line). Reindex under harrier. Confirm it does not crash. Query for something in that short note and confirm it is retrievable.

- [ ] **Step 9: Commit verification notes (optional)**

If you discovered any adjustment needed (e.g., had to fall back from `q4f16` to `quantized`, or had to pass `{ input_ids, attention_mask }` explicitly to `model()`), commit those fixes now with a message like:

```bash
git add <affected files>
git commit -m "fix(rag): <specific adjustment discovered in manual verification>"
```

If verification passed cleanly with no changes, skip this step.

- [ ] **Step 10: Final summary**

Report back:
- Download size actually observed for harrier q4f16
- Indexing time vs e5-base on the same folder
- Whether long-note retrieval qualitatively improved
- Any risk factors from the spec that turned into real issues (and how they were handled)

---
date: 2026-04-13
topic: Add harrier-oss-v1-270m-ONNX as a selectable RAG embedding model
status: design
---

# Add harrier-oss-v1-270m-ONNX as a selectable RAG embedding model

## Motivation

The current RAG feature supports five embedding models (`Xenova/multilingual-e5-large|base|small`, `sirasagi62/ruri-v3-30m|130m-ONNX`). All of them share two practical limits:

1. **Short max-token window (~512 tokens)**, forcing aggressive chunking of long Markdown notes.
2. **Mid-tier retrieval quality** for multilingual content.

`onnx-community/harrier-oss-v1-270m-ONNX` (Microsoft harrier-oss-v1 family, MIT) addresses both:

- **270M parameters**, **640-dim** embeddings
- **32,768 max tokens** — ~64× larger than e5 — enables embedding entire notes without splitting
- **MTEB v2 = 66.5** — stronger retrieval than multilingual-e5
- **94 languages**, including Japanese — no language gating needed
- **Transformers.js compatible** via `AutoModel` + `AutoTokenizer`

Goal: expose harrier as an additional selectable embedding model, alongside the existing five, without disturbing them.

## Scope

**In scope**

- Add harrier to the RAG model dropdown in `RagPanel`
- Extend `useLocalEmbedding` to load and run harrier (different transformers.js API path)
- Extend the Rust embedding-model downloader (`rag_check_model` / `rag_download_model`) to fetch harrier's files (including the `.onnx_data` external data file)
- Add harrier to the `RagSettings.embeddingModel` TypeScript union type

**Out of scope (YAGNI)**

- Abstracting embedding loaders into an adapter/interface pattern
- Configurable `Instruct:` task description in settings UI
- Quantization selection UI (fp16 / fp32 / q4 / q4f16 / quantized)
- WebGPU execution path
- Migrating existing indices to harrier automatically

## Key technical differences vs existing models

| Aspect | e5 / ruri (existing) | harrier (new) |
|---|---|---|
| JS API | `pipeline("feature-extraction", ...)` | `AutoModel.from_pretrained` + `AutoTokenizer.from_pretrained` |
| Pooling | `{ pooling: "mean", normalize: true }` passed to pipeline | `sentence_embedding` output (last-token pooling + L2 already applied by the model) |
| Query prefix | `"query: "` (e5) or `"Search query: "` (ruri) | `"Instruct: Given a question, retrieve relevant markdown notes that answer it\nQuery: "` |
| Passage prefix | `"passage: "` (e5) or `"Search document: "` (ruri) | **none** (empty string) |
| Dimension | 384 / 768 / 1024 | 640 |
| ONNX file | `onnx/model_quantized.onnx` (self-contained) | `onnx/model_q4f16.onnx` + `onnx/model_q4f16.onnx_data` (external data) |
| dtype to pass | `"q8"` | `"q4f16"` |

The `Instruct:` prefix is required for queries and **must not** be applied to passages, per the model card. The task description is tuned for this project's use case (Markdown note retrieval).

## Design

### 1. Frontend: `src/features/rag/hooks/useLocalEmbedding.ts`

Introduce a per-model-family branch without abstracting into an adapter interface.

**Helpers (module-level)**

```ts
const isHarrier = (name: string | null) => !!name && name.includes("harrier");

function getDtype(modelName: string): string {
  return isHarrier(modelName) ? "q4f16" : "q8";
}

function getPrefix(modelName: string | null, type: "query" | "passage"): string {
  if (isHarrier(modelName)) {
    if (type === "query") {
      return "Instruct: Given a question, retrieve relevant markdown notes that answer it\nQuery: ";
    }
    return ""; // passages get no prefix
  }
  if (modelName && modelName.includes("ruri")) {
    return type === "query" ? "Search query: " : "Search document: ";
  }
  return type === "query" ? "query: " : "passage: ";
}
```

**Unified embed closure (module-level cache)**

Replace the current `pipelineInstance` global with a generic `embedFn` closure so the public `embed()` does not need to know which API produced the vector:

```ts
let embedFn: ((input: string) => Promise<Float32Array>) | null = null;
let loadedModelName: string | null = null;
let pipelinePromise: Promise<void> | null = null;
```

**Inside `load()`, build `embedFn` per family:**

- **Pipeline family (e5 / ruri)** — unchanged behavior; build `embedFn` as:
  ```ts
  const pipe = await pipeline("feature-extraction", modelName, {
    dtype: getDtype(modelName),
    revision: "",
    progress_callback: ...,
  } as any);
  embedFn = async (input) => {
    const r = await pipe(input, { pooling: "mean", normalize: true });
    return r.data as Float32Array;
  };
  ```

- **Harrier family** — new path:
  ```ts
  const { AutoModel, AutoTokenizer } = await import("@huggingface/transformers");
  const tokenizer = await AutoTokenizer.from_pretrained(modelName, { revision: "" } as any);
  const model = await AutoModel.from_pretrained(modelName, {
    dtype: getDtype(modelName), // "q4f16"
    revision: "",
    progress_callback: ...,
  } as any);
  embedFn = async (input) => {
    const inputs = tokenizer(input, { padding: true, truncation: true });
    const out = await model(inputs);
    return out.sentence_embedding.data as Float32Array;
  };
  ```

Both paths share the same `env.remoteHost` / `env.remotePathTemplate` / `env.allowRemoteModels` setup already present in the file.

**Public `embed()` becomes family-agnostic:**

```ts
const embed = useCallback(async (text, type = "query"): Promise<number[]> => {
  if (!embedFn) throw new Error("Model not loaded");
  const prefix = getPrefix(loadedModelName, type);
  const data = await embedFn(`${prefix}${text}`);
  return Array.from(data);
}, []);
```

**Model-switching cleanup** — `load()` already clears the cached instance when `loadedModelName !== modelName`. Extend it to reset the new `embedFn` variable as well.

### 2. Backend: `src-tauri/src/commands/rag.rs`

Replace the module-level `const MODEL_FILES` (currently hardcoded to the e5/ruri layout) with a function that returns the correct file list per model family:

```rust
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

Update both call sites:

- `rag_check_model`: iterate `model_files_for(name)` instead of `MODEL_FILES`
- `rag_download_model`: iterate `model_files_for(name)` instead of `MODEL_FILES`; `file_count` becomes `files.len()`

The existing download loop already handles arbitrary relative paths (including `onnx/<file>`), creates parent directories, does HEAD-request size checks, and emits `ModelDownloadProgress` events — no further change needed for the `.onnx_data` file; it is just one more entry in the list.

The old `const DEFAULT_MODEL_NAME: &str = "Xenova/multilingual-e5-large"` stays.

### 3. Type union: `src/shared/types/index.ts`

Extend `RagSettings.embeddingModel`:

```ts
export interface RagSettings {
  embeddingModel:
    | "Xenova/multilingual-e5-large"
    | "Xenova/multilingual-e5-base"
    | "Xenova/multilingual-e5-small"
    | "sirasagi62/ruri-v3-30m-ONNX"
    | "sirasagi62/ruri-v3-130m-ONNX"
    | "onnx-community/harrier-oss-v1-270m-ONNX";
  ...
}
```

No migration is needed for the zustand persisted store: existing users already have a valid value for `embeddingModel`, and the default (`Xenova/multilingual-e5-base`) is unchanged.

### 4. UI: `src/features/rag/components/RagPanel.tsx`

Add one `<option>` in the model select (around lines 369-373), placed after the multilingual-e5 options and before the Japanese-only ruri options:

```tsx
<option value="onnx-community/harrier-oss-v1-270m-ONNX">
  harrier-oss-v1-270m (long context)
</option>
```

No language gating (harrier is multilingual). The ` (long context)` suffix is a short feature tag, consistent with the existing plain-text labels (`multilingual-e5-large`, etc.) which are likewise not routed through i18n. This does not violate the "no hardcoded UI strings" rule because the dropdown label is a model identifier, not user-facing copy — it matches the pattern already in use on lines 369-373.

### 5. Index isolation

`rag.rs::model_db_name()` derives the SQLite file name from the model name:
`onnx-community/harrier-oss-v1-270m-ONNX` → `rag_harrier-oss-v1-270m-ONNX.db`.

Harrier's 640-dim vectors are therefore stored in a separate DB from the existing 384/768/1024-dim indices — no collision, no migration. Users who switch models will see the existing "reindex required" warning (`ragModelChangeWarning`) which is already wired to `localRagSettings.embeddingModel !== ragSettings.embeddingModel`.

## Data flow

1. User selects `harrier-oss-v1-270m (long context)` in the RAG panel dropdown.
2. `useRagFeatures` passes the new model name to `rag_check_model` / `rag_download_model`.
3. Rust `model_files_for("onnx-community/harrier-oss-v1-270m-ONNX")` returns the harrier file list; the downloader fetches `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_q4f16.onnx`, `onnx/model_q4f16.onnx_data` into `.embedding-models/onnx-community/harrier-oss-v1-270m-ONNX/`.
4. Frontend `useLocalEmbedding.load()` detects harrier, takes the `AutoModel`/`AutoTokenizer` path, constructs `embedFn`.
5. Indexing calls `embed(text, "passage")` → no prefix → model → 640-dim vector → stored in `rag_harrier-oss-v1-270m-ONNX.db`.
6. Query calls `embed(text, "query")` → `"Instruct: ...\nQuery: "` prefix → model → 640-dim vector → cosine search.

## Error handling

Existing error paths cover all new cases:

- **Network / download failures**: the Rust downloader already emits `NETWORK_ERROR:` / `DOWNLOAD_ERROR:` prefixes that `useLocalEmbedding` maps to user-visible states.
- **Model load failures**: caught by the existing `try/catch` around `pipelinePromise` — the new `AutoModel` path sits inside the same block.
- **Missing `.onnx_data`**: the download loop validates each file's size against the HEAD response; a truncated external data file will be re-downloaded on next load.
- **Type-union rejection**: if a stale persisted setting somehow points to an unknown model, TypeScript will flag it; at runtime the model is a free string, so the request just hits `rag_check_model` and either downloads or errors cleanly.

## Testing strategy

This project has no automated test harness for RAG today (indexing hits real files and real ONNX models). Verification is manual, in order:

1. **Build passes** — `cargo check` for Rust, `tsc` / `vite build` for TS
2. **Fresh download** — delete `.embedding-models/onnx-community/harrier-oss-v1-270m-ONNX/` and select harrier in the UI; observe `downloading` → `loading` → `ready` states
3. **Indexing** — index a folder with at least one long Markdown file (>2k tokens). Confirm `rag_harrier-oss-v1-270m-ONNX.db` is created, chunks are saved, and dimension is 640 (can verify via the DB or a debug log)
4. **Query** — run several RAG queries; confirm non-zero cosine scores and reasonable ranking on notes the developer knows by heart
5. **Model switching** — switch back to `multilingual-e5-base`; confirm the existing index still works and harrier's DB is not touched
6. **Re-switch to harrier** — confirm no re-download (files cached) and no re-indexing into the e5 DB

## Risks and open questions

- **Transformers.js version compatibility**: the project pins `@huggingface/transformers` via `package.json`. The `AutoModel` + `sentence_embedding` API path requires a recent version. Action: verify the currently installed version exposes both during implementation; bump if needed.
- **q4f16 execution backend**: `q4f16` implies WebGPU in many transformers.js configs. On CPU (`wasm`), it may silently dequantize or fail. Action: if CPU-only execution of `q4f16` is unstable, fall back to `model_quantized.onnx` (int8, 344 MB) by changing `getDtype` and the Rust file list together.
- **Tokenizer output shape**: harrier's tokenizer may return `input_ids` / `attention_mask` directly usable by `model()`, but some transformers.js versions require destructuring. Action: if `model(inputs)` fails, pass `{ input_ids, attention_mask }` explicitly.
- **Instruct task description wording**: the chosen string (`"Given a question, retrieve relevant markdown notes that answer it"`) is a reasonable domain-tuned variant but not validated against benchmarks. It can be revisited later without a schema change.

## Files to touch

- `src/features/rag/hooks/useLocalEmbedding.ts` — harrier branch, unified `embedFn`, dtype/prefix helpers
- `src-tauri/src/commands/rag.rs` — `model_files_for()` helper, update `rag_check_model` and `rag_download_model`
- `src/shared/types/index.ts` — extend `RagSettings.embeddingModel` union
- `src/features/rag/components/RagPanel.tsx` — add one `<option>`

No changes to `useRagFeatures`, the settings store, i18n resources, or CSS.

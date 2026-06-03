---
topic: Make local embedding (RAG) and speech-to-text work in network-restricted / MSI-installed environments
date: 2026-06-03
status: approved
---

# RAG & Speech: Offline / Blocked-Network Support

## Problem

In a corporate proxy environment where `huggingface.co` is blocked, the local
embedding (RAG) feature fails in two distinct ways depending on how the app was
launched:

1. **`npm run tauri dev`** — indexing starts but freezes permanently at the
   "Building..." state.
2. **MSI installer build** — the same operation fails with
   `アクセスが拒否されました。(os error 5)` (ERROR_ACCESS_DENIED).

Both observations were reproduced on a machine behind a corporate proxy that
blocks `huggingface.co`. The installer used was the **MSI** target.

## Root Causes (confirmed)

Three independent root causes, two of which are shared with the speech-to-text
feature (which has the identical architecture).

### RC1 — Model storage is next to the executable (causes os error 5)

`embedding_models_base_dir()` (`src-tauri/src/lib.rs:12`),
`rag::embedding_model_dir_for()` (`src-tauri/src/commands/rag.rs:570`), and
`speech::speech_model_dir_for()` (`src-tauri/src/commands/speech.rs:27`) all
resolve the model directory as `exe_dir/.embedding-models/...`.

The MSI target installs **perMachine** into `C:\Program Files\MDium\`, which is
read-only for a normal user. `rag_download_model` / `speech_download_model`
then call `fs::create_dir_all` / file create under that path and fail with
`ERROR_ACCESS_DENIED (os error 5)`.

The index database (`<content folder>/.mdium/rag_*.db`) lives under the user's
folder and is **not** the cause — the failing write is the model directory next
to the exe.

### RC2 — ONNX Runtime WASM is fetched from a CDN at runtime (causes the hang)

`useLocalEmbedding.ts` and `speech-worker.ts` set `env.remoteHost` so that
**model files** are served locally via the `models://` protocol, but they never
set `env.backends.onnx.wasm.wasmPaths`. With `@huggingface/transformers@3.8.1`,
onnxruntime-web therefore fetches its WASM backend binaries from the jsDelivr
CDN during pipeline initialization. In the blocked environment that fetch hangs,
so pipeline init never completes and the UI stays at "Building..." forever.

In dev this is what hangs (the exe-dir model path is writable under
`target/debug`, so RC1 does not trigger there). In the MSI build RC1 fails first
(at download), before reaching RC2.

### RC3 — Runtime model download is impossible when huggingface.co is blocked

`rag_download_model` / `speech_download_model` fetch from
`https://huggingface.co/...`. When that host is blocked there is no runtime path
to obtain the model files at all. The chosen resolution is to support **manual
placement** of model files into a user-writable directory.

## Goals

- Local embedding (RAG) and speech-to-text both work in a fully
  network-restricted, MSI-installed environment.
- Fixes applied once at the shared infrastructure layer and consistently across
  both features.
- No regression for users on open networks (download still works).

## Non-Goals

- Bundling model weights into the installer (rejected: tens-to-hundreds of MB of
  installer bloat). Manual placement was chosen instead.
- An internal-mirror URL setting (not needed for the target environment).
- Migrating any previously downloaded models from the old exe-dir location
  (under MSI nothing was ever written there; dev `target/debug` models are
  disposable).
- Multi-threaded WASM execution (requires cross-origin isolation; single-thread
  is used for reliability).

## Design

### Decision summary

| Area | Decision | Rationale |
|------|----------|-----------|
| A. Storage location | `app_local_data_dir()/.embedding-models` | Writable under both MSI (perMachine) and NSIS; user-accessible for manual placement; Local (not Roaming) because models are large and machine-specific. |
| B. WASM backend | Bundle onnxruntime-web wasm into the frontend `dist`, set `wasmPaths` locally, `numThreads = 1` | Eliminates the CDN fetch; single-thread avoids the COOP/COEP requirement of threaded WASM in WebView2. |
| C. Model acquisition | Manual placement + keep download as open-network fallback | huggingface.co is blocked, so runtime download cannot be the only path. |

### Section 1 — Shared model directory under app local data (RC1)

Introduce a single shared resolver for the embedding-models base directory that
returns `app_local_data_dir()/.embedding-models`, resolved through Tauri's path
resolver (requires `AppHandle` / `UriSchemeContext::app_handle()`).

Update all three current resolvers to use this shared base:

- `lib.rs::embedding_models_base_dir` — the `models://` protocol base. The
  protocol handler closure receives a context exposing `app_handle()`, so it can
  resolve the path resolver there.
- `rag::embedding_model_dir_for`
- `speech::speech_model_dir_for`

Add an `AppHandle` parameter to the commands that currently resolve the dir
without one: `rag_check_model`, `rag_get_model_dir`, `speech_check_model`,
`speech_get_model_dir`. (`rag_download_model` / `speech_download_model` already
receive `app`.) Frontend `invoke` call sites do not pass `app` — Tauri injects
it — so no TypeScript call-site changes are required for the handle itself.

The `models://` protocol base and the download/check/get-dir targets must all
resolve to the **same** directory, otherwise locally placed or downloaded files
would not be found by the protocol that serves them to transformers.js.

No migration step.

### Section 2 — Bundle ONNX Runtime WASM locally (RC2)

Make onnxruntime-web's WASM backend files part of the locally served frontend
bundle (e.g. emitted into `dist` via the build, served from the app's own local
origin), and configure both inference entry points to load them from there:

- `src/features/rag/hooks/useLocalEmbedding.ts`
- `src/features/speech/workers/speech-worker.ts`

In both, after importing `env` from `@huggingface/transformers`:

- Set `env.backends.onnx.wasm.wasmPaths` to the local bundled location.
- Set `env.backends.onnx.wasm.numThreads = 1`.

The exact mechanism for getting the wasm files into `dist` (Vite `?url` imports
vs. a static-copy plugin pointing at `onnxruntime-web/dist`) and the precise set
of required files are implementation details for the plan; the requirement is
that **no request leaves the local origin** during pipeline init. Verification
is a DevTools network check showing zero CDN requests.

### Section 3 — Manual placement UX (RC3 / C)

Keep the existing download path as a fallback for open networks. When a model is
missing and download is unavailable/blocked, present a manual-placement panel in
`RagPanel.tsx` (and the equivalent speech surface) containing:

- The exact target folder path (from `rag_get_model_dir` /
  `speech_get_model_dir`).
- The list of required relative file paths (`MODEL_FILES` for RAG; the
  per-model file list for speech) and the source HF repo URL to copy them from
  on another machine.
- An **"Open folder"** button (reuse `open_in_default_app`; create the directory
  first so it can be opened).
- A **"Re-check"** button that re-runs `*_check_model` after the user places the
  files.

All new user-visible strings go through i18n (en/ja), per project standards.
Proposed keys (final names decided in the plan): `ragModelManualTitle`,
`ragModelManualInstructions`, `ragOpenModelFolder`, `ragModelMissingRetry`.

### Section 4 — Error handling & detection

- `rag_check_model` / `speech_check_model` already return `false` when any
  required file is absent, so manual placement is detected naturally on re-check.
- The UI must distinguish "model not present (download blocked/unavailable)"
  from a transient network error, and show the manual-placement guidance for the
  former rather than a generic error message. The existing error mapping in
  `RagPanel.tsx:216-224` (NETWORK_ERROR / DOWNLOAD_ERROR / ENGINE_CRASH) is
  extended for this.

## Testing

- **Rust unit test:** the resolved model directory is under `app_local_data_dir`
  and independent of the executable's location.
- **Offline WASM check (manual/integration):** with the app running, DevTools
  Network shows no request to any CDN during model load; pipeline reaches
  "ready".
- **Manual placement (integration):** place the required files into the resolved
  directory → `*_check_model` returns true → indexing/transcription runs with no
  network access.
- **MSI smoke test:** after MSI install, the model directory resolves under
  `AppData\Local` and is writable (no os error 5).

## Affected Files

- `src-tauri/src/lib.rs` — shared base dir resolver; `models://` handler uses it.
- `src-tauri/src/commands/rag.rs` — use shared base; add `AppHandle` to
  `rag_check_model` / `rag_get_model_dir`.
- `src-tauri/src/commands/speech.rs` — use shared base; add `AppHandle` to
  `speech_check_model` / `speech_get_model_dir`.
- `src/features/rag/hooks/useLocalEmbedding.ts` — `wasmPaths` + `numThreads`.
- `src/features/speech/workers/speech-worker.ts` — `wasmPaths` + `numThreads`.
- `src/features/rag/components/RagPanel.tsx` — manual-placement panel + error
  mapping.
- `src/shared/i18n/locales/{en,ja}/common.json` — new strings.
- `vite.config.ts` (and/or build config) — emit onnxruntime-web wasm into
  `dist`.

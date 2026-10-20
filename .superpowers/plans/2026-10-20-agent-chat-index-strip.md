# AGENT CHAT Index Strip (RAG パネル縮退) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AGENT CHAT the only entry point for document search: delete the RAG panel's chat, move index management into a strip above the provider tabs, and expose the index (search / status / Office conversion / update) to every provider through a bundled `mdium-rag` MCP server.

**Architecture:** The webview keeps owning the embedding model, the index jobs and Office→Markdown conversion; a new `rag-index-store` holds one shared job/status state that both the strip UI and the HTTP-bridge handlers drive. Rust's `http_bridge.rs` gains three relay routes (`/rag/status`, `/rag/convert`, `/rag/update`) that forward to the webview exactly like `/rag/search` and map webview error codes to HTTP statuses. A dependency-free stdio MCP server (`sidecar/rag-mcp`, built like `mdium-docs`) proxies to the bridge and is passed to Claude / Codex / Copilot at session start with a permission env; write tools are hidden in read-only sessions and confirmed by an in-app dialog in "ask" sessions.

**Tech Stack:** React 18 + zustand + react-i18next + vitest (happy-dom / node per file), Tauri 2 (Rust, tiny_http, serde), Node 20 sidecars bundled with esbuild, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@github/copilot-sdk`.

**Spec:** `.superpowers/specs/2026-10-20-agent-chat-index-strip-design.md`

**Deviations from the spec (decided while planning, from facts found in the code):**
1. Codex is also given `mdium-rag` at session start (the Codex SDK accepts `config: { mcp_servers }` as `--config` overrides), so nothing is written to `config.toml` and the Codex settings-screen hook is not needed. Opt-out is only the per-provider toggle in the strip drawer.
2. Permission handling is uniform instead of per-provider: the MCP server receives `MDIUM_RAG_PERMISSION` (`read-only` | `ask` | `auto`), hides the write tools in `read-only`, and forwards `approval` to the bridge; the webview shows one confirm dialog for `ask`. Provider layers only auto-approve `mdium-rag` tools. Reason: Codex has no ask path at all, so a per-provider gate cannot give the same behavior.
3. `unconverted_office_docs` entries carry `{ path, type }` only (`FileEntry` has no size).
4. The `rag*` i18n keys stay in the `common` namespace; only chat-only keys are deleted and new strip keys go to `agent-chat`.

## Global Constraints

- All UI-visible strings go through i18n (`src/shared/i18n/locales/{en,ja}/*.json`); `locale-parity.test.ts` enforces en/ja parity.
- Code comments in English.
- No lazy loading / dynamic `import()` in the webview (static imports only).
- Files are CRLF; keep the existing line endings when editing.
- Embedding and conversion run in the webview; Rust only relays. Bridge port/token change per launch, so the MCP server reads `~/.mdium/bridge.json` at call time (env `MDIUM_BRIDGE_PORT` / `MDIUM_BRIDGE_TOKEN` override).
- Index update is incremental only (Rust-side hash compare in `rag_scan_folder`); full rebuild = delete + build in the drawer.
- Conversion writes `<name>.md` next to the source (`saveToMdium=false`); existing sibling `.md` → `rejected: exists`; `.doc` → `rejected: unsupported`; `.xls`/`.xlsm` are included.
- One index job at a time; a second request gets `job_running` → HTTP 409.
- Tool names: `rag_search`, `rag_status`, `convert_office_docs`, `rag_update_index`; server name `mdium-rag`; Claude sees them as `mcp__mdium-rag__<tool>`.
- Verify with: `npx vitest run <file>`, `npx tsc --noEmit`, `cd src-tauri && cargo test --lib`.
- Branch: `feat/agent-chat-index-strip` from `main` (the icon change in `LeftPanel.tsx` already in the working tree goes into the first commit).

## Review Focus

1. Agent passes a path outside the open folder (or `..`) to `convert_office_docs` → must be `rejected: outside_folder`, never converted. (Task 6 test.)
2. A bridge request arrives while no folder is open or the folder is a drive root → `no_folder` / HTTP 400, no job started. (Task 1 + Task 7 tests.)
3. User never answers the approval dialog → the tool must get `approval_timeout` within 120 s and no job may start afterwards. (Task 7 test.)
4. Closed environment: the embedding model is missing when the agent triggers `rag_update_index` → the job fails with `MODEL_MISSING`, `rag_status.error` is `"model_missing"`, and the strip shows the manual-placement block. (Task 5 + Task 8 tests.)
5. A `rag_status` call for a folder different from the running job's folder → reports that folder's DB status with `job: null` instead of the other folder's job. (Task 5 test.)

---

### Task 1: Rust bridge routes, status mapping and `~/.mdium/bridge.json`

**Files:**
- Modify: `src-tauri/src/http_bridge.rs` (`write_bridge_sidecar` L61-75, `/rag/search` arm L353-423, tests module L507+)

**Interfaces:**
- Produces (event payload the webview receives on `rag-bridge-request`): `{ id, kind: "search"|"status"|"convert"|"update", folderPath, query?, limit?, searchMode?, bm25Weight?, paths?, approval? }`.
- Produces (HTTP): `POST /rag/status` body `{ folder_path }`; `POST /rag/convert` body `{ folder_path, paths: string[], approval: "ask"|"auto" }`; `POST /rag/update` body `{ folder_path, approval }`. Response = webview payload verbatim; status from `rag_status_for_payload`.
- Produces: `pub fn rag_status_for_payload(payload: &serde_json::Value) -> u16` — 200 unless `payload.ok == false`; then by `payload.error`: `job_running`→409, `no_folder`→400, `approval_denied`→403, `approval_timeout`→408, `invalid_request`→400, anything else→500.

- [ ] **Step 1: Write failing Rust tests** in the existing `mod tests`:

```rust
#[test]
fn rag_status_codes_follow_error_code() {
    assert_eq!(rag_status_for_payload(&json!({"ok": true, "results": []})), 200);
    assert_eq!(rag_status_for_payload(&json!({"ok": false, "error": "job_running"})), 409);
    assert_eq!(rag_status_for_payload(&json!({"ok": false, "error": "no_folder"})), 400);
    assert_eq!(rag_status_for_payload(&json!({"ok": false, "error": "approval_denied"})), 403);
    assert_eq!(rag_status_for_payload(&json!({"ok": false, "error": "approval_timeout"})), 408);
    assert_eq!(rag_status_for_payload(&json!({"ok": false, "error": "boom"})), 500);
}
#[test]
fn rag_relay_payload_camel_cases_each_kind() {
    let p = rag_relay_payload("convert", &json!({"folder_path":"C:/w","paths":["a.docx"],"approval":"ask"})).unwrap();
    assert_eq!(p["kind"], "convert"); assert_eq!(p["folderPath"], "C:/w"); assert_eq!(p["paths"][0], "a.docx"); assert_eq!(p["approval"], "ask");
    let p = rag_relay_payload("search", &json!({"folder_path":"C:/w","query":"q","bm25_weight":0.3})).unwrap();
    assert_eq!(p["query"], "q"); assert_eq!(p["bm25Weight"], 0.3); assert!(p["limit"].is_null());
    assert!(rag_relay_payload("convert", &json!({"folder_path":"C:/w"})).is_err()); // paths required
    assert!(rag_relay_payload("status", &json!({"folder_path":"C:/w"})).is_ok());
}
#[test]
fn bridge_sidecar_paths_include_mdium_home() {
    let paths = bridge_sidecar_paths(std::path::Path::new("H"));
    assert!(paths.iter().any(|p| p.ends_with(std::path::Path::new(".mdium/bridge.json"))));
    assert!(paths.iter().any(|p| p.ends_with(std::path::Path::new(".config/opencode/.mdium-bridge.json"))));
}
```

- [ ] **Step 2: Run** `cd src-tauri && cargo test --lib http_bridge` → FAIL (functions missing).

- [ ] **Step 3: Implement** in `http_bridge.rs`:
  - `fn bridge_sidecar_paths(home: &Path) -> Vec<PathBuf>` (both files); `write_bridge_sidecar` loops over it (same JSON body as today).
  - `fn rag_relay_payload(kind: &str, body: &Value) -> Result<Value, String>`: requires `folder_path` string for every kind; `search` requires `query` and copies `limit`/`search_mode`/`bm25_weight` as `limit`/`searchMode`/`bm25Weight` (null when absent); `convert` requires `paths` (array of strings) and `approval` (default `"ask"`); `update` copies `approval` (default `"ask"`); `status` nothing else. Adds `kind` and `folderPath`.
  - `fn rag_status_for_payload(&Value) -> u16` as specified.
  - `fn relay_rag_request(app, kind, body_str, request)`: parse JSON (400 `invalid_json`), build payload (400 `invalid_request` with the message), register pending id, emit `rag-bridge-request` with `id` merged in, `recv_timeout(180s)`, respond with `rag_status_for_payload`. Replace the `/rag/search` arm body with a call to it and add arms `"/rag/status" | "/rag/convert" | "/rag/update"`.

- [ ] **Step 4: Run** `cargo test --lib http_bridge` → PASS; `cargo test --lib` → all green.

- [ ] **Step 5: Commit** `git add src-tauri/src/http_bridge.rs src/features/file-tree/components/LeftPanel.tsx && git commit -m "feat(bridge): relay rag status/convert/update to the webview and write ~/.mdium/bridge.json"` (the LeftPanel icon change rides along).

---

### Task 2: Generic stdio MCP handler (`sidecar/mcp-lib`)

**Files:**
- Create: `sidecar/mcp-lib/jsonrpc-server.ts`, `sidecar/mcp-lib/stdio.ts`
- Test: `sidecar/mcp-lib/__tests__/jsonrpc-server.test.ts` (`// @vitest-environment node`)

**Interfaces:**
- Produces:
```ts
export interface McpToolDef { name: string; description: string; inputSchema: Record<string, unknown> }
export interface McpToolResult { content: { type: "text"; text: string }[]; isError?: true }
export function toolText(text: string, isError?: boolean): McpToolResult
export interface McpHandlerOptions { serverName: string; serverVersion: string; listTools: () => McpToolDef[]; callTool: (name: string, args: unknown) => Promise<McpToolResult> }
export type JsonRpcResponse = { jsonrpc: "2.0"; id: string|number|null; result: unknown } | { jsonrpc: "2.0"; id: string|number|null; error: { code: number; message: string } }
export function createMcpHandler(opts: McpHandlerOptions): { handleMcpMessage(message: unknown): Promise<JsonRpcResponse|undefined>; handleMcpLine(line: string): Promise<JsonRpcResponse|undefined> }
export function runStdioServer(handleLine: (line: string) => Promise<JsonRpcResponse|undefined>): void   // stdio.ts
```
Behavior copied from `sidecar/doc-converter/mcp-server.ts` L95-131 and `mcp-main.ts` `runServer` (protocol versions `["2025-06-18","2025-03-26","2024-11-05"]`, notifications → `undefined`, `ping` → `{}`, unknown tool → `-32602 "Unknown tool: X"`, unknown method → `-32601`, parse error → `-32700`). `listTools` is a function so a server can vary its tool list by permission.

- [ ] **Step 1: Write failing tests** — `initialize` negotiation (unknown version falls back to `2025-06-18`), `tools/list` returns what `listTools()` returns, `tools/call` routes to `callTool` with `params.arguments`, unknown tool → `-32602`, notification → `undefined`, bad JSON line → `-32700`.
- [ ] **Step 2: Run** `npx vitest run sidecar/mcp-lib` → FAIL.
- [ ] **Step 3: Implement** both files (stdio loop: readline on stdin, skip blank lines, track in-flight promises, `allSettled` then `process.exit(0)` on close; route `console.*` to stderr like `doc-converter/node-env.ts` `routeConsoleToStderr`, re-export or import it).
- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** `feat(sidecar): add generic stdio MCP handler`.

---

### Task 3: `mdium-rag` MCP server + build script

**Files:**
- Create: `sidecar/rag-mcp/bridge-client.ts`, `sidecar/rag-mcp/tools.ts`, `sidecar/rag-mcp/mcp-server.ts`, `sidecar/rag-mcp/mcp-main.ts`, `scripts/build-rag-mcp.mjs`
- Modify: `package.json` (`build:sidecar` appends `&& node scripts/build-rag-mcp.mjs`)
- Test: `sidecar/rag-mcp/__tests__/tools.test.ts`, `sidecar/rag-mcp/__tests__/bundle.test.ts` (node env)

**Interfaces:**
- Consumes: Task 2 `createMcpHandler`, `runStdioServer`, `toolText`.
- Produces:
```ts
// bridge-client.ts
export interface BridgeInfo { port: number; token: string }
export async function readBridgeInfo(env?: NodeJS.ProcessEnv, home?: string): Promise<BridgeInfo | null>  // env MDIUM_BRIDGE_PORT/TOKEN → ~/.mdium/bridge.json → ~/.config/opencode/.mdium-bridge.json
export async function callBridge(info: BridgeInfo, route: string, body: unknown, timeoutMs: number, fetchImpl?: typeof fetch): Promise<{ status: number; json: unknown }>
// tools.ts
export type RagPermission = "read-only" | "ask" | "auto";
export function parsePermission(raw: string | undefined): RagPermission   // default "ask"
export function listRagTools(permission: RagPermission): McpToolDef[]     // read-only omits convert_office_docs / rag_update_index
export interface RagToolDeps { permission: RagPermission; folderPath: string; readBridgeInfo: () => Promise<BridgeInfo|null>; callBridge: typeof callBridge }
export async function callRagTool(name: string, args: unknown, deps: RagToolDeps): Promise<McpToolResult>
// mcp-server.ts
export const SERVER_NAME = "mdium-rag"; export const SERVER_VERSION = "1.0.0";
export function createRagServer(deps?: Partial<RagToolDeps>): ReturnType<typeof createMcpHandler>  // defaults: permission from env MDIUM_RAG_PERMISSION, folderPath = process.cwd()
```
- Tool contract (`callRagTool`):
  - No bridge info → `toolText("Cannot reach mdium (is the app running?). Fall back to the built-in file tools.", true)`.
  - `rag_search` → `POST /rag/search` `{ folder_path, query, limit: top_k, search_mode, bm25_weight }`, timeout 150 000 ms; empty `results` → text "No documents found…"; else `JSON.stringify(results, null, 2)`.
  - `rag_status` → `POST /rag/status` `{ folder_path }`, timeout 30 000 ms; returns `JSON.stringify(json, null, 2)`.
  - `convert_office_docs` → `POST /rag/convert` `{ folder_path, paths, approval }` where `approval = permission === "auto" ? "auto" : "ask"`, timeout 150 000 ms. In `read-only` → `toolText("convert_office_docs is not available in a read-only session.", true)` without calling the bridge.
  - `rag_update_index` → `POST /rag/update` `{ folder_path, approval }`, same timeout / read-only rule.
  - Non-2xx → `toolText(\`${name} failed: ${json.error ?? "HTTP " + status}${json.message ? ": " + json.message : ""}\`, true)`.
- Tool descriptions (English, verbatim intent from spec §5.1): `rag_status` description must say "Call this first for any question about the documents in the folder. If `unconverted_office_docs` is not empty, tell the user how many and which files, and ask whether to convert them before searching. If `state` is `empty`, ask whether to build the index. Never start a conversion or index update without the user's consent."; `convert_office_docs` and `rag_update_index` descriptions say they start a background job and that progress must be polled with `rag_status` until `job.state` is `done` or `failed`.

- [ ] **Step 1: Write failing tests** (`tools.test.ts`, injecting fake `readBridgeInfo`/`callBridge`):
  - `listRagTools("read-only")` names are exactly `["rag_search","rag_status"]`; `"ask"` and `"auto"` list all four.
  - `parsePermission(undefined) === "ask"`, `parsePermission("auto") === "auto"`, `parsePermission("junk") === "ask"`.
  - `convert_office_docs` under `read-only` returns `isError` and never calls the bridge.
  - `convert_office_docs` under `auto` posts `approval: "auto"`; under `ask` posts `approval: "ask"`.
  - Bridge 409 `{ok:false,error:"job_running"}` → `isError` text contains `job_running`.
  - No bridge info → `isError` text contains "Cannot reach mdium".
  - `readBridgeInfo({MDIUM_BRIDGE_PORT:"1", MDIUM_BRIDGE_TOKEN:"t"})` → `{port:1, token:"t"}`; with a temp home containing `.mdium/bridge.json` → parsed.
  - `bundle.test.ts`: build `mcp-main.ts` with esbuild into tmp (same options as the script), pipe `initialize` + `tools/list` through stdin with `MDIUM_RAG_PERMISSION=read-only`, expect 2 tools.
- [ ] **Step 2: Run** `npx vitest run sidecar/rag-mcp` → FAIL.
- [ ] **Step 3: Implement** the four source files and `scripts/build-rag-mcp.mjs` (copy of `build-doc-converter.mjs` with `entryPoints: ["sidecar/rag-mcp/mcp-main.ts"]`, `outfile: "resources/mcp-servers/mdium-rag/dist/index.js"`, banner `createRagRequire`). Add it to `build:sidecar`.
- [ ] **Step 4: Run** tests → PASS; `node scripts/build-rag-mcp.mjs` produces `resources/mcp-servers/mdium-rag/dist/index.js`; `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** `feat(sidecar): add mdium-rag MCP server proxying to the HTTP bridge`.

---

### Task 4: Shared bridge types and `mdiumRagTools` setting

**Files:**
- Create: `src/shared/types/rag-bridge.ts`
- Modify: `src/stores/settings-store.ts` (interface ~L43-66, defaults L74-90, setters L104-131, `partialize` L141-157, `merge` L158-168)
- Test: `src/stores/__tests__/settings-store-mdium-rag-tools.test.ts` (model on `settings-store-experimental-flows.test.ts`)

**Interfaces:**
- Produces (`rag-bridge.ts`):
```ts
export type RagBridgeKind = "search" | "status" | "convert" | "update";
export type RagApproval = "ask" | "auto";
export interface RagBridgeRequest { id: string; kind: RagBridgeKind; folderPath: string; query?: string | null; limit?: number | null; searchMode?: string | null; bm25Weight?: number | null; paths?: string[]; approval?: RagApproval }
export type RagIndexState = "empty" | "ready" | "updating" | "converting" | "error";
export type RagJobKind = "convert" | "update";
export interface RagJobInfo { id: string; kind: RagJobKind; folder: string; state: "running" | "done" | "failed"; done: number; total: number; current_file: string; errors: { path: string; message: string }[] }
export interface RagUnconvertedDoc { path: string; type: "docx" | "xlsx" | "pptx" | "pdf" }
export interface RagStatusPayload { ok: true; state: RagIndexState; total_chunks: number; total_files: number; embedding_model: string; progress: { phase: string; current: number; total: number } | null; unconverted_office_docs: RagUnconvertedDoc[]; job: RagJobInfo | null; error: string | null }
export type RagRejectReason = "exists" | "unsupported" | "outside_folder" | "not_found";
export interface RagConvertAccepted { ok: true; job_id: string; accepted: string[]; rejected: { path: string; reason: RagRejectReason }[] }
export interface RagUpdateAccepted { ok: true; job_id: string }
export type RagBridgeErrorCode = "job_running" | "no_folder" | "approval_denied" | "approval_timeout" | "invalid_request" | "nothing_to_convert" | "internal";
export interface RagBridgeError { ok: false; error: RagBridgeErrorCode; message?: string }
export interface StdioMcpServerSpec { command: string; args: string[]; env: Record<string, string> }   // shared by Tasks 10-12 (webview + sidecars)
```
- Produces (settings-store): `export type MdiumRagProvider = "claude" | "codex" | "copilot"`; state `mdiumRagTools: Record<MdiumRagProvider, boolean>` default all `true`; `setMdiumRagTool(provider: MdiumRagProvider, enabled: boolean): void`; persisted; `merge` fills missing keys with `true`.

- [ ] **Step 1: Write failing test**: default is `{claude:true,codex:true,copilot:true}`; `setMdiumRagTool("codex", false)` flips only codex; persisted JSON under `mdium-settings` contains `mdiumRagTools`; a persisted state without the key merges to all-true.
- [ ] **Step 2: Run** `npx vitest run src/stores/__tests__/settings-store-mdium-rag-tools.test.ts` → FAIL.
- [ ] **Step 3: Implement** types file and store fields.
- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** `feat(settings): add mdiumRagTools per-provider toggles and rag bridge types`.

---

### Task 5: `rag-index-store` and index jobs (status / update / delete)

**Files:**
- Create: `src/features/rag/stores/rag-index-store.ts`, `src/features/rag/lib/index-jobs.ts`
- Test: `src/features/rag/lib/__tests__/index-jobs.test.ts` (happy-dom, mock `@tauri-apps/api/core` `invoke` and `@tauri-apps/api/event` `listen`)

**Interfaces:**
- Consumes: Task 4 types; `rag_get_status {folderPath, modelName}` → `{total_chunks,total_files}`; `rag_scan_folder {folderPath,fileExtensions,minChunkLength,modelName}`; `rag_save_chunks {folderPath, chunks, modelName}`; `rag_delete_index {folderPath, modelName}`; event `rag-scan-progress {current,total,file}` (all as in `useRagFeatures.ts` L111-216). `useSettingsStore.getState().ragSettings`.
- Produces (store):
```ts
export interface BuildProgress { phase: "scanning"|"preparing"|"embedding"|"saving"; current: number; total: number; currentFile: string }
export interface RagIndexStoreState {
  folder: string | null; state: "unknown" | RagIndexState; totalChunks: number; totalFiles: number;
  progress: BuildProgress | null; error: string | null; job: RagJobInfo | null;
  patch(p: Partial<Omit<RagIndexStoreState,"patch"|"resetFor">>): void; resetFor(folder: string | null): void;
}
export const useRagIndexStore: UseBoundStore<StoreApi<RagIndexStoreState>>
```
- Produces (index-jobs):
```ts
export interface EmbeddingApi { load(model: string): Promise<void>; embed(text: string, type: "query"|"passage"): Promise<number[]> }
export class JobRunningError extends Error { code: "job_running" }
export async function refreshIndexStatus(folder: string): Promise<void>            // rag_get_status → store (state "ready" when total_chunks>0 else "empty"; keeps "updating"/"converting" while a job runs for this folder)
export function startUpdateIndex(folder: string, embedding: EmbeddingApi): RagJobInfo   // throws JobRunningError; returns the running job immediately
export async function deleteIndex(folder: string): Promise<void>                    // throws JobRunningError
export function statusPayloadFor(folder: string, unconverted: RagUnconvertedDoc[]): RagStatusPayload  // pure: builds the bridge payload from store state; job only when job.folder === folder; error "model_missing" when store.error === "MODEL_MISSING", else the raw string
export function errorCodeFor(e: unknown): RagBridgeErrorCode                       // JobRunningError → "job_running", else "internal"
```
`startUpdateIndex` body = `buildIndex` from `useRagFeatures.ts` L125-206 re-homed on the store: sets `state:"updating"`, job `{kind:"update", state:"running"}`, listens to `rag-scan-progress`, scans, embeds sequentially (`done/total` on the job and `progress.phase`), saves, then `refreshIndexStatus`; on error sets `error` (same message rules: `e.message`, number → `ENGINE_CRASH:n`), `state:"error"`, job `failed` with one entry in `errors`. Jobs stay in the store after completion (`state: "done"|"failed"`) until the next job starts.

- [ ] **Step 1: Write failing tests**:
  - `refreshIndexStatus` with `rag_get_status` → `{total_chunks:3,total_files:2}` sets `state:"ready"`, counts; with 0 chunks → `"empty"`.
  - `startUpdateIndex` with `rag_scan_folder` → 2 chunks and a fake `EmbeddingApi` calls `embed` twice with `"passage"`, invokes `rag_save_chunks` with 2 embedded chunks, ends with job `state:"done"`, `done===2`, and store `state:"ready"`.
  - `startUpdateIndex` when `load` rejects with `Error("MODEL_MISSING")` → job `failed`, `errors[0].message === "MODEL_MISSING"`, store `state:"error"`, and `statusPayloadFor(folder, []).error === "model_missing"`.
  - `startUpdateIndex` while a job is `running` → throws `JobRunningError`; `errorCodeFor` gives `"job_running"`.
  - `statusPayloadFor("C:/other", [])` while the job's folder is `"C:/w"` → `job === null` and `state` derived from DB counts.
  - `deleteIndex` invokes `rag_delete_index` and leaves `state:"empty"`.
- [ ] **Step 2: Run** `npx vitest run src/features/rag/lib/__tests__/index-jobs.test.ts` → FAIL.
- [ ] **Step 3: Implement** store and jobs.
- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** `feat(rag): add rag-index-store and shared index jobs`.

---

### Task 6: Office conversion job and unconverted-doc discovery

**Files:**
- Modify: `src/features/rag/lib/index-jobs.ts`
- Test: `src/features/rag/lib/__tests__/convert-jobs.test.ts` (mock `invoke`, mock `@/features/export/lib/convertFileToMarkdown`)

**Interfaces:**
- Consumes: `collectConvertibleFiles(tree: FileEntry[]): ConvertibleFile[]` (`src/features/export/lib/collectConvertibleFiles.ts`), `convertFileToMarkdown(file, saveToMdium, pptxLabels): Promise<{mdPath}>`, `invoke("get_file_tree", { path, showAll: true, includeDocx: true, includeXls: true, includePptx: true, includeKm: true, includeImages: true, includePdf: true, includeEmptyDirs: false })`, `i18n.t("common:pptxSlideLabel", {n})` / `t("common:pptxNotesLabel")`.
- Produces:
```ts
export async function listUnconvertedOfficeDocs(folder: string): Promise<ConvertibleFile[]>   // get_file_tree(showAll) → collectConvertibleFiles → type !== "doc" && !hasExistingMdSibling
export function toUnconvertedDocs(files: ConvertibleFile[]): RagUnconvertedDoc[]
export function resolveConvertPaths(folder: string, paths: string[], all: ConvertibleFile[]): { accepted: ConvertibleFile[]; rejected: { path: string; reason: RagRejectReason }[] }
export function startConvertDocs(folder: string, files: ConvertibleFile[]): RagJobInfo       // throws JobRunningError; runs convertFileToMarkdown(file, false, labels) sequentially; per-file failure → errors[] and continue; state "converting"; when done calls refreshIndexStatus
```
`resolveConvertPaths` rules: normalize separators and resolve relative paths against `folder`; path not under `folder` (after normalization, case-insensitive on Windows) → `outside_folder`; not in `all` → `not_found`; `type === "doc"` → `unsupported`; `hasExistingMdSibling` → `exists`.

- [ ] **Step 1: Write failing tests**: `resolveConvertPaths` for each reason (`"../x.docx"` → `outside_folder`; `"C:/w/sub/a.docx"` and `"sub/a.docx"` both accepted; `.doc` → `unsupported`; sibling md → `exists`; unknown → `not_found`); `listUnconvertedOfficeDocs` on a tree with `a.docx`, `a.md`, `b.xlsm`, `c.doc`, `d.pdf` returns `[b.xlsm, d.pdf]` and `toUnconvertedDocs` maps `b.xlsm` to type `"xlsx"`; `startConvertDocs` with 2 files where the second converter call rejects → job `done` with `errors.length === 1`, `done === 2`, store `state` back to `ready/empty`; a running job → `JobRunningError`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** `feat(rag): add Office conversion job and unconverted document discovery`.

---

### Task 7: Bridge handlers for status / convert / update with approval dialog

**Files:**
- Modify: `src/features/rag/hooks/useRagBridge.ts` (effect 3, L75-181)
- Create: `src/features/rag/lib/bridge-handlers.ts`
- Modify: `src/shared/i18n/locales/{en,ja}/agent-chat.json` (keys `indexApproveConvert` "The agent wants to convert {{count}} Office document(s) to Markdown:\n{{files}}\nAllow?", `indexApproveUpdate` "The agent wants to update the document index. Allow?")
- Test: `src/features/rag/lib/__tests__/bridge-handlers.test.ts`

**Interfaces:**
- Consumes: Tasks 5–6 functions; `applyForward(text, settings)`; `showConfirm(message, {kind})` (the same util `RagPanel.tsx` imports).
- Produces:
```ts
export interface BridgeDeps { embedding: EmbeddingApi; confirm: (message: string) => Promise<boolean>; approvalTimeoutMs?: number /* default 120000 */ }
export async function handleRagBridgeRequest(req: RagBridgeRequest, activeFolder: string | null, deps: BridgeDeps): Promise<RagStatusPayload | RagConvertAccepted | RagUpdateAccepted | RagBridgeError | { ok: true; results: unknown[] }>
```
Rules: folder = `activeFolder || req.folderPath`; empty or drive root → `{ok:false,error:"no_folder"}`. `status` → `listUnconvertedOfficeDocs` + `statusPayloadFor` (mask each doc's file name with `applyForward`). `convert` → resolve paths; if no job is running and `accepted` is empty → `nothing_to_convert`; if `approval === "ask"` → `confirm(...)` raced against the timeout (`approval_timeout`), `false` → `approval_denied`; then `startConvertDocs` and return accepted/rejected. `update` → same approval flow then `startUpdateIndex`. `search` → existing logic moved here unchanged. `JobRunningError` → `job_running`. `useRagBridge` becomes: listen → `handleRagBridgeRequest(req, activeFolder, { embedding: {load, embed}, confirm: (m) => showConfirm(m, {kind:"warning"}) })` → `invoke("rag_bridge_respond", {id, payload})`, keeping the existing 120 s overall race only for `search`.

- [ ] **Step 1: Write failing tests**: `status` returns `unconverted_office_docs` and masks names via a replacement rule; `convert` with `approval:"ask"` and confirm → `false` returns `approval_denied` and starts no job; confirm never resolving with `approvalTimeoutMs: 10` → `approval_timeout` and no job; `approval:"auto"` skips confirm and returns `accepted`; `update` while a job runs → `job_running`; `activeFolder` null and `req.folderPath` `"C:\\"` → `no_folder`; `convert` where all paths are rejected → `nothing_to_convert` with the `rejected` list in `message`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `bridge-handlers.ts`, rewire `useRagBridge.ts`.
- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit`; `npx vitest run src/shared/i18n` (parity) green.
- [ ] **Step 5: Commit** `feat(rag): handle status/convert/update bridge requests with in-app approval`.

---

### Task 8: `IndexStrip` component and drawer in AGENT CHAT

**Files:**
- Create: `src/features/agent-chat/components/IndexStrip.tsx`, `src/features/agent-chat/components/IndexStrip.css`, `src/features/agent-chat/components/IndexSettingsDrawer.tsx`, `src/features/agent-chat/components/IndexErrorBlock.tsx`
- Modify: `src/features/agent-chat/components/AgentChatPanel.tsx` (insert `<IndexStrip />` before `.agent-chat__tabs`, L76), `src/shared/i18n/locales/{en,ja}/agent-chat.json`
- Test: `src/features/agent-chat/components/__tests__/IndexStrip.test.tsx`; update `AgentChatPanel.test.tsx` (mock `IndexStrip` to `data-testid="index-strip"` so tab-label assertions keep passing)

**Interfaces:**
- Consumes: `useRagIndexStore`, `refreshIndexStatus`, `startUpdateIndex`, `deleteIndex`, `useLocalEmbedding()` (`load`, `embed`, `getManualPlacement`, `status`, `error`), `useSettingsStore` (`ragSettings`, `setRagSettings`, `language`, `mdiumRagTools`, `setMdiumRagTool`), `useTabStore(s => s.activeFolderPath)`, `classifyRagError`, `showConfirm`.
- Produces: `export function IndexStrip(): JSX.Element | null` (null when no folder). Root `div.index-strip` with `data-state={store.state}`; children: `span.index-strip__pill` (text per state: ready → `t("indexReady", {count: totalChunks})`, empty → `t("indexEmpty")`, updating/converting → phase text reusing `common:ragPhase*` / `t("indexConverting", {done,total})`, error → `t("indexError")`), `span.index-strip__meta` (model tail + `t("indexFiles",{count})`, ready only), `button.index-strip__update` (`common:ragBuildIndex` when empty, `common:ragRebuildIndex` when ready; disabled while a job runs), `button.index-strip__settings` (gear, `aria-label=t("indexSettings")`). On mount / folder change → `refreshIndexStatus(folder)`. `IndexErrorBlock` = the error/model-missing block from `RagPanel.tsx` L228-295 (same keys, `getManualPlacement`, `create_folder` + `open_in_default_app`, re-check → update). `IndexSettingsDrawer` = settings form from `RagPanel.tsx` L425-543 (same fields, `ragModelChangeWarning`, save → `setRagSettings`), plus "Delete index" (`ragDeleteIndexConfirm` → `deleteIndex`) and three checkboxes `t("indexToolsClaude")` / `indexToolsCodex` / `indexToolsCopilot` bound to `mdiumRagTools`, under heading `t("indexToolsHeading")` ("Agent tools (mdium-rag)").
- New `agent-chat` keys (en/ja): `indexReady` ("Index: {{count}} chunks"), `indexEmpty` ("No index"), `indexError` ("Index error"), `indexFiles` ("{{count}} files"), `indexConverting` ("Converting {{done}}/{{total}}"), `indexUpdate`, `indexSettings`, `indexDelete`, `indexToolsHeading`, `indexToolsClaude`, `indexToolsCodex`, `indexToolsCopilot`, `indexToolsHint` ("Expose the document index to this provider's agent"), plus the two approval keys from Task 7 if not yet added.

- [ ] **Step 1: Write failing tests** (happy-dom, `createRoot` + `act`, set `useTabStore` folder and `useRagIndexStore` state directly; mock `invoke`): renders nothing without a folder; `state:"empty"` shows `indexEmpty` and the build button; `state:"ready"` with 128 chunks shows "128" and `data-state="ready"`; `state:"updating"` disables the update button; `state:"error"` + `error:"MODEL_MISSING"` renders `common:ragModelMissingTitle`; clicking the gear shows the drawer with the three provider checkboxes and unchecking codex calls `setMdiumRagTool("codex", false)`.
- [ ] **Step 2: Run** `npx vitest run src/features/agent-chat/components/__tests__/IndexStrip.test.tsx` → FAIL.
- [ ] **Step 3: Implement** components + CSS (use `var(--border)`, `var(--bg-surface)`, `var(--text-muted)`, `var(--primary)`; `data-state="empty"` background tinted warning, `ready` tinted success; `flex-shrink: 0`), mount in `AgentChatPanel`, update its test mock.
- [ ] **Step 4: Run** strip + `AgentChatPanel.test.tsx` + i18n parity → PASS; `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** `feat(agent-chat): add index strip with settings drawer above provider tabs`.

---

### Task 9: Remove the RAG panel, its chat, and the RAG entry points

**Files:**
- Delete: `src/features/rag/components/RagPanel.tsx`, `src/features/rag/components/RagPanel.css`, `src/features/rag/hooks/useRagFeatures.ts`
- Modify: `src/features/file-tree/components/LeftPanel.tsx` (button L156-164, header L244-251, mount L412-418, `RagPanel` import, `aiSettings` usage if now unused), `src/app/App.tsx` (import L41; Ctrl+Shift+R L1154-1164 → `setLeftPanel("opencode-config"); setFolderLeftPanel("opencode-config")` mirroring the Ctrl+O handler L1145-1149 minus the tab switch; bottom panel L1415-1477: drop the RAG tab button and body, keep the terminal tab), `src/stores/ui-store.ts` (`LeftPanel` L5 and `LEFT_PANELS` L7-16 drop `"rag"`; `normalizeLeftPanel` maps `"rag"` → `"opencode-config"` like `"claude"`; `FolderPanelTab = "terminal"`; remove `ragChatInput`/`setRagChatInput`), `src/shared/hooks/useKeyboardShortcuts.ts` (L18 type and L75-81 handler), `src/shared/i18n/locales/{en,ja}/common.json` (delete `ragInputTooltip`, `ragClearChat`, `ragSaveAndNew`, `ragDiscardAndNew`, `ragChatHistory`, `ragNoChatHistory`, `ragLoadChatConfirm`, `ragDeleteChat`, `ragApiKeyMissing`, `ragOpenSettings`, `ragPleaseBuildIndex`)
- Test: `src/features/file-tree/components/__tests__/LeftPanel.test.tsx` (remove the `RagPanel` mock; add "has no RAG activity button"), `src/stores/__tests__/ui-store-left-panel.test.ts` (add `"rag"` → `"opencode-config"`)

- [ ] **Step 1: Write failing tests**: `normalizeLeftPanel("rag") === "opencode-config"`; LeftPanel renders no button with `title="RAG"` and no `data-testid="rag"`.
- [ ] **Step 2: Run** both files → FAIL.
- [ ] **Step 3: Implement** the deletions and edits; `grep -rn "RagPanel\|useRagFeatures\|ragChatInput\|folderPanelTab === \"rag\"" src` must return nothing.
- [ ] **Step 4: Run** `npx tsc --noEmit`, `npx vitest run src/features/file-tree src/stores src/shared/i18n src/app` → PASS.
- [ ] **Step 5: Commit** `refactor(rag): remove the RAG panel and its chat; AGENT CHAT is the only entry point`.

---

### Task 10: `mdium-rag` session config helper (webview)

**Files:**
- Create: `src/features/agent-chat/lib/mdium-rag-mcp.ts`
- Test: `src/features/agent-chat/lib/__tests__/mdium-rag-mcp.test.ts` (mock `invoke("resolve_mcp_servers_path")` → `"C:\\app\\mcp-servers"`)

**Interfaces:**
- Consumes: `AgentPermission` (`src/shared/types/agent-runner.ts` L23), `ClaudePermissionMode` (`src/shared/types/claude-sidecar.ts`), `useSettingsStore.getState().mdiumRagTools`.
- Produces:
```ts
export type MdiumRagPermission = "read-only" | "ask" | "auto";
// StdioMcpServerSpec is imported from "@/shared/types/rag-bridge" (Task 4)
export const MDIUM_RAG_SERVER_NAME = "mdium-rag";
export function mdiumRagPermissionFor(p: AgentPermission): MdiumRagPermission          // read-only→read-only, cli-default→ask, full-access→auto
export function mdiumRagPermissionForClaude(m: ClaudePermissionMode): MdiumRagPermission // plan→read-only, bypassPermissions→auto, default/acceptEdits→ask
export function buildMdiumRagServer(mcpServersPath: string, permission: MdiumRagPermission): StdioMcpServerSpec  // { command: "node", args: [join(mcpServersPath, "mdium-rag", "dist", "index.js")], env: { MDIUM_RAG_PERMISSION: permission } }
export async function mdiumRagServerFor(provider: MdiumRagProvider, permission: MdiumRagPermission): Promise<Record<string, StdioMcpServerSpec> | undefined>  // undefined when the toggle is off or resolve fails (log a console.warn); else { "mdium-rag": spec }
```

- [ ] **Step 1: Write failing tests** for the three mappings, the arg path (uses the platform separator of `mcpServersPath`), toggle-off → `undefined`, resolve failure → `undefined`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, tsc green.
- [ ] **Step 5: Commit** `feat(agent-chat): add mdium-rag MCP session config helper`.

---

### Task 11: Pass `mcpServers` through the agent runner (Codex / Copilot) and auto-approve `mdium-rag`

**Files:**
- Modify: `src/shared/types/agent-runner.ts` (`RunnerInbound` start_session L69-86: add `mcpServers?: Record<string, StdioMcpServerSpec>`; `ToolRequest` L30-46: add `trusted?: true`), `sidecar/agent-runner/protocol.ts` (`parseInbound` start_session L127-152), `sidecar/agent-runner/adapter.ts` (`SessionOptions` L10-18), `sidecar/agent-runner/runner-core.ts` (`startSession` L256-264), `sidecar/agent-runner/copilot-adapter.ts` (config L260-267 → `mcpServers` with `type: "local"`), `sidecar/agent-runner/codex-adapter.ts` (`CodexAdapterDeps.createCodex` L50 options gain `config?: Record<string, unknown>`; L159 passes `config: { mcp_servers: { [name]: { command, args, env } } }` when present), `sidecar/agent-runner/permissions.ts` (`normalizeCopilot` case `"mcp"` L40-44: when `serverName === "mdium-rag"` return `{ kind: "read", summary, rawKind: "mcp", trusted: true }`; `copilotDecision` L67: `if (request.trusted) return "approve"` first), `src/features/agent-chat/agent-chat-store.ts` (`newSession` L191-203 adds `mcpServers: await mdiumRagServerFor(provider, mdiumRagPermissionFor(settings.permission))`)
- Test: `sidecar/agent-runner/__tests__/protocol.test.ts`, `permissions.test.ts`, `copilot-adapter.test.ts`, `codex-adapter.test.ts`, `src/features/agent-chat/__tests__/agent-chat-store.test.ts`

- [ ] **Step 1: Write failing tests**: `parseInbound` keeps `mcpServers` (and drops a malformed entry without `command`); `toolRequestFromCopilot({kind:"mcp", serverName:"mdium-rag", toolName:"rag_search"})` → `{kind:"read", trusted:true}` and `copilotDecision("cli-default", that)` → `"approve"`, while `serverName:"other"` stays opaque and `"ask"`; copilot adapter passes `mcpServers["mdium-rag"]` with `type:"local"` into `createSession`; codex adapter passes `config.mcp_servers["mdium-rag"].command === "node"` to `createCodex`; agent-chat-store `newSession` includes `mcpServers` in the `start_session` request when the toggle is on and omits it when off.
- [ ] **Step 2: Run** `npx vitest run sidecar/agent-runner src/features/agent-chat/__tests__` → FAIL.
- [ ] **Step 3: Implement.** Also run `node scripts/build-agent-runner.mjs`.
- [ ] **Step 4: Run** → PASS; tsc green.
- [ ] **Step 5: Commit** `feat(agent-runner): pass mdium-rag MCP server to Codex/Copilot sessions and trust its tools`.

---

### Task 12: Claude sidecar: `mcpServers` and auto-allow for `mdium-rag`

**Files:**
- Modify: `src/shared/types/claude-sidecar.ts` (`StartSessionMessage` gains `mcpServers?: Record<string, StdioMcpServerSpec>`), `sidecar/claude-sidecar.ts` (Options L21-42: `...(startMsg.mcpServers ? { mcpServers: startMsg.mcpServers } : {})`), `sidecar/sidecar-core.ts` (`canUseTool` L100-106: if `toolName.startsWith("mcp__mdium-rag__")` resolve `{behavior:"allow", updatedInput: input}` without sending `permission_request`), `src/features/claude-config/hooks/useClaudeChat.ts` (`case "ready"` L86-98 adds `mcpServers: await mdiumRagServerFor("claude", mdiumRagPermissionForClaude(settings.permissionMode))`)
- Test: `sidecar/__tests__/sidecar-core.test.ts`, `src/features/claude-config/hooks/__tests__/useClaudeChat.test.ts` (create if absent; mock `sendToSidecar`)

- [ ] **Step 1: Write failing tests**: sidecar-core allows `mcp__mdium-rag__rag_status` without emitting `permission_request` and still emits one for `mcp__other__x`; `start_session` message forwarded to `startQuery` carries `mcpServers`; `useClaudeChat` "ready" handling sends `start_session` with `mcpServers["mdium-rag"].env.MDIUM_RAG_PERMISSION === "ask"` for `permissionMode:"default"` and `"read-only"` for `"plan"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; run `node scripts/build-claude-sidecar.mjs`. **Step 4: Run** → PASS; tsc green.
- [ ] **Step 5: Commit** `feat(claude): pass mdium-rag MCP server to the chat sidecar and auto-allow its tools`.

---

### Task 13: opencode built-in tools and `rag` agent prompt

**Files:**
- Create: `.opencode/tools/rag_status.ts`, `.opencode/tools/convert_office_docs.ts`, `.opencode/tools/rag_update_index.ts` (each starts with `// mdium-tool-version: 1`, same `readBridgeInfo` + fetch pattern as `rag_search.ts`, `folder_path: context.worktree`, `approval: "ask"`, timeout 150 000 ms, errors returned as strings)
- Modify: `src/features/opencode-config/lib/builtin-registry.ts` (`?raw` imports; three new `BUILTIN_CUSTOM_TOOLS` entries; `rag` agent: `requiredBuiltinTools` += the three, frontmatter `tools:` enables them, `# mdium-agent-version: 3`, prompt gains a "## Office documents and index" section with the §5.1 procedure: call `rag_status` first; if `unconverted_office_docs` is non-empty, list count and names and ask; on consent `convert_office_docs` → poll `rag_status` until `job.state` is `done` → `rag_update_index` → poll → `rag_search`; if `state` is `empty` ask to build; never start without consent)
- Test: `src/features/opencode-config/lib/__tests__/builtin-registry.test.ts` (new)

- [ ] **Step 1: Write failing test**: `BUILTIN_CUSTOM_TOOLS` has the three new keys with `fileName` matching and content containing `mdium-tool-version: 1`; `BUILTIN_AGENTS.rag.requiredBuiltinTools` contains all of `rag_search, rag_status, convert_office_docs, rag_update_index`; `agentMd` contains `mdium-agent-version: 3` and the string `rag_status`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; tsc green.
- [ ] **Step 5: Commit** `feat(opencode): add rag_status/convert_office_docs/rag_update_index tools and teach the rag agent to offer conversion`.

---

### Task 14: Desktop verification (spec §7 and §8, manual)

**Files:** none (results go in the PR description).

- [ ] **Step 1:** `npm run build:sidecar` then `npm run tauri dev`. Open a folder containing `*.docx` and `*.xlsm` with no sibling `.md`.
- [ ] **Step 2: AGENT CHAT shows the strip** above the tabs: no RAG button in the activity bar, no RAG tab in the bottom panel, Ctrl+Shift+R opens AGENT CHAT.
- [ ] **Step 3: Claude tab** (permission mode default): ask "このフォルダの文書について教えて". Expected: the agent calls `rag_status` (no permission prompt), proposes conversion; answer yes; the in-app dialog appears once for convert and once for update; the strip shows "Converting n/m" then the embedding phase; the agent then calls `rag_search` and answers with citations. Record whether `Options.mcpServers` was honored (tool list contains `mcp__mdium-rag__rag_status`); if not, note it as the §7 fallback.
- [ ] **Step 4: Codex tab** with permission `read-only`: ask the same. Expected: `rag_search`/`rag_status` work, the agent reports it cannot convert (tools absent). Switch to `cli-default`: conversion proposal works; note that Codex runs the write tools after the in-app dialog only.
- [ ] **Step 5: Copilot tab**: same as Step 3; confirm no Copilot permission prompt for `rag_status` and that the in-app dialog appears for conversion. If the SDK ignores `mcpServers`, record it (spec §7 fallback: write `~/.copilot/mcp-config.json` instead).
- [ ] **Step 6: Toggle off** Codex in the strip drawer, start a new Codex session: `rag_status` is not listed by the agent.
- [ ] **Step 7: opencode tab** with the `rag` agent: conversion proposal → consent → search works through `.opencode/tools`.
- [ ] **Step 8:** Record results in the PR description; open the PR to `main`.

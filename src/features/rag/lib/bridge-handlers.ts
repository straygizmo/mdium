import { invoke } from "@tauri-apps/api/core";
import i18n from "@/shared/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import { applyForward } from "@/shared/lib/replacement";
import type {
  RagBridgeError,
  RagBridgeRequest,
  RagConvertAccepted,
  RagStatusPayload,
  RagUpdateAccepted,
} from "@/shared/types/rag-bridge";
import { useRagIndexStore } from "../stores/rag-index-store";
import {
  errorCodeFor,
  listUnconvertedOfficeDocs,
  resolveConvertPaths,
  startConvertDocs,
  startUpdateIndex,
  statusPayloadFor,
  toUnconvertedDocs,
  type EmbeddingApi,
} from "./index-jobs";

export interface BridgeDeps {
  embedding: EmbeddingApi;
  confirm: (message: string) => Promise<boolean>;
  /** How long to wait for the user to answer the approval dialog (default 120000). */
  approvalTimeoutMs?: number;
}

export type BridgeResponse =
  | RagStatusPayload
  | RagConvertAccepted
  | RagUpdateAccepted
  | RagBridgeError
  | { ok: true; results: unknown[] };

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

// A drive root or filesystem root would make searches walk the whole disk.
const isRootOrEmpty = (p: string) =>
  !p || p === "/" || p === "\\" || /^[A-Za-z]:[\\/]?$/.test(p);

const fail = (error: RagBridgeError["error"], message?: string): RagBridgeError =>
  message === undefined ? { ok: false, error } : { ok: false, error, message };

const isJobRunning = () => useRagIndexStore.getState().job?.state === "running";

/** Mask only the file-name segment of a path, leaving the directory untouched. */
function maskFileName(path: string, repl: Parameters<typeof applyForward>[1]): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(0, idx + 1) + applyForward(path.slice(idx + 1), repl);
}

type Approval = "granted" | "approval_denied" | "approval_timeout";

async function requestApproval(message: string, deps: BridgeDeps): Promise<Approval> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([deps.confirm(message), timeout]);
    if (answer === "timeout") return "approval_timeout";
    return answer ? "granted" : "approval_denied";
  } finally {
    clearTimeout(timer);
  }
}

async function handleSearch(req: RagBridgeRequest, folder: string, deps: BridgeDeps): Promise<BridgeResponse> {
  // Read settings at request time so the latest configuration is used.
  const rag = useSettingsStore.getState().ragSettings;
  const model = rag.embeddingModel;
  const searchMode = req.searchMode ?? rag.searchMode;
  const bm25Weight = req.bm25Weight ?? rag.bm25Weight;
  const limit = req.limit ?? rag.retrieveTopK;
  const query = req.query ?? "";
  console.info("[rag-bridge] request:", query, "| model:", model, "| folder:", folder);

  // Never trigger a network download from this invisible path — in a
  // blocked/offline env that can hang indefinitely. Fail fast instead.
  const t0 = performance.now();
  const exists = await invoke<boolean>("rag_check_model", { modelName: model });
  if (!exists) {
    throw new Error(
      `Embedding model "${model}" is not available locally. Open the mdium RAG panel and build the index first.`,
    );
  }
  const t1 = performance.now();
  await deps.embedding.load(model);
  const t2 = performance.now();
  const embedding = await deps.embedding.embed(query, "query");
  const t3 = performance.now();
  const allResults = await invoke<any[]>("rag_search", {
    folderPath: folder,
    embedding,
    queryText: query,
    limit,
    modelName: model,
    searchMode,
    bm25Weight,
  });
  const t4 = performance.now();
  // A large `load` here means the model was cold/reloaded.
  console.info(
    `[rag-bridge] timing(ms): check=${(t1 - t0) | 0} load=${(t2 - t1) | 0} embed=${(t3 - t2) | 0} search=${(t4 - t3) | 0}`,
  );
  // In hybrid mode `score` is an RRF score (different scale from cosine),
  // so the cosine-based minScore threshold only applies to vector mode.
  const filtered =
    searchMode === "hybrid" ? allResults : allResults.filter((r: any) => (r.score ?? 0) >= rag.retrieveMinScore);

  // Mask result text before it reaches the LLM via opencode. File paths are
  // NOT masked — opencode tools resolve files by this path.
  const repl = useSettingsStore.getState().replacement;
  return {
    ok: true,
    results: filtered.map((r: any) => ({
      file: r.file,
      heading: applyForward(r.heading ?? "", repl),
      content: applyForward(r.text ?? "", repl),
      line_number: r.line ?? 0,
      score: r.score ?? 0,
    })),
  };
}

async function handleStatus(folder: string): Promise<BridgeResponse> {
  const repl = useSettingsStore.getState().replacement;
  const docs = toUnconvertedDocs(await listUnconvertedOfficeDocs(folder)).map((d) => ({
    ...d,
    path: maskFileName(d.path, repl),
  }));
  let counts = { total_chunks: 0, total_files: 0 };
  try {
    const r = await invoke<Partial<typeof counts>>("rag_get_status", {
      folderPath: folder,
      modelName: useSettingsStore.getState().ragSettings.embeddingModel,
    });
    counts = { total_chunks: r.total_chunks ?? 0, total_files: r.total_files ?? 0 };
  } catch {
    // Counts are best-effort; report an empty index instead of failing.
  }
  return statusPayloadFor(folder, docs, counts);
}

async function handleConvert(req: RagBridgeRequest, folder: string, deps: BridgeDeps): Promise<BridgeResponse> {
  const all = await listUnconvertedOfficeDocs(folder);
  const { accepted, rejected } = resolveConvertPaths(folder, req.paths ?? [], all);
  // Check before asking so the user is never prompted for a request that cannot run.
  if (isJobRunning()) return fail("job_running");
  if (accepted.length === 0) return fail("nothing_to_convert", JSON.stringify(rejected));
  if (req.approval !== "auto") {
    const repl = useSettingsStore.getState().replacement;
    const files = accepted.map((f) => applyForward(f.name, repl)).join("\n");
    const outcome = await requestApproval(
      i18n.t("agent-chat:indexApproveConvert", { count: accepted.length, files }),
      deps,
    );
    if (outcome !== "granted") return fail(outcome);
  }
  const job = startConvertDocs(folder, accepted);
  return { ok: true, job_id: job.id, accepted: accepted.map((f) => f.path), rejected };
}

async function handleUpdate(req: RagBridgeRequest, folder: string, deps: BridgeDeps): Promise<BridgeResponse> {
  if (isJobRunning()) return fail("job_running");
  if (req.approval !== "auto") {
    const outcome = await requestApproval(i18n.t("agent-chat:indexApproveUpdate"), deps);
    if (outcome !== "granted") return fail(outcome);
  }
  const job = startUpdateIndex(folder, deps.embedding);
  return { ok: true, job_id: job.id };
}

/** Routes one rag-bridge request to its handler. Never throws. */
export async function handleRagBridgeRequest(
  req: RagBridgeRequest,
  activeFolder: string | null,
  deps: BridgeDeps,
): Promise<BridgeResponse> {
  // Use the folder mdium has open as the root. opencode's worktree
  // (req.folderPath) is unreliable — it can be "/".
  const folder = activeFolder || req.folderPath;
  if (isRootOrEmpty(folder)) return fail("no_folder");
  try {
    switch (req.kind) {
      case "search":
        return await handleSearch(req, folder, deps);
      case "status":
        return await handleStatus(folder);
      case "convert":
        return await handleConvert(req, folder, deps);
      case "update":
        return await handleUpdate(req, folder, deps);
      default:
        return fail("invalid_request");
    }
  } catch (e: any) {
    return fail(errorCodeFor(e), String(e?.message ?? e));
  }
}

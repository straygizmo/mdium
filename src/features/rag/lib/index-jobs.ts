import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/stores/settings-store";
import i18n from "@/shared/i18n";
import { collectConvertibleFiles, type ConvertibleFile } from "@/features/export/lib/collectConvertibleFiles";
import { convertFileToMarkdown, type PptxLabels } from "@/features/export/lib/convertFileToMarkdown";
import type { FileEntry } from "@/shared/types";
import { useRagIndexStore } from "../stores/rag-index-store";
import { mirrorUri } from "@/stores/ftp-mirror-store";
import type {
  RagBridgeErrorCode,
  RagIndexState,
  RagJobInfo,
  RagRejectReason,
  RagStatusPayload,
  RagUnconvertedDoc,
} from "@/shared/types/rag-bridge";

export interface EmbeddingApi {
  load(model: string): Promise<void>;
  embed(text: string, type: "query" | "passage"): Promise<number[]>;
}

export class JobRunningError extends Error {
  code = "job_running" as const;
  constructor() {
    super("An index job is already running");
    this.name = "JobRunningError";
  }
}

interface DbCounts {
  total_chunks: number;
  total_files: number;
}

const store = () => useRagIndexStore.getState();

function isJobRunning(): boolean {
  return store().job?.state === "running";
}

async function fetchCounts(folder: string): Promise<DbCounts> {
  const { embeddingModel } = useSettingsStore.getState().ragSettings;
  try {
    const r = await invoke<Partial<DbCounts>>("rag_get_status", { folderPath: folder, modelName: embeddingModel });
    return { total_chunks: r.total_chunks ?? 0, total_files: r.total_files ?? 0 };
  } catch {
    return { total_chunks: 0, total_files: 0 };
  }
}

function runningStateFor(folder: string): RagIndexState | null {
  const job = store().job;
  if (job?.state !== "running" || job.folder !== folder) return null;
  return job.kind === "update" ? "updating" : "converting";
}

export async function refreshIndexStatus(folder: string): Promise<void> {
  // Drop per-folder state (error, progress, counts) left over from another folder.
  if (store().folder !== folder) store().resetFor(folder);
  const counts = await fetchCounts(folder);
  const running = runningStateFor(folder);
  store().patch({
    folder,
    state: running ?? (counts.total_chunks > 0 ? "ready" : "empty"),
    totalChunks: counts.total_chunks,
    totalFiles: counts.total_files,
  });
}

function errorMessage(e: unknown): string {
  // onnxruntime-web aborts surface as a bare number (a WASM heap address);
  // tag those so the UI can show actionable guidance.
  return e instanceof Error ? e.message : typeof e === "number" ? `ENGINE_CRASH:${e}` : String(e);
}

const fileNameOf = (p: string) => p.split(/[\\/]/).pop() ?? "";

function patchJob(id: string, p: Partial<RagJobInfo>): void {
  const job = store().job;
  if (job && job.id === id) store().patch({ job: { ...job, ...p } });
}

export function startUpdateIndex(folder: string, embedding: EmbeddingApi): RagJobInfo {
  if (isJobRunning()) throw new JobRunningError();
  const initial: RagJobInfo = {
    id: crypto.randomUUID(),
    kind: "update",
    folder,
    state: "running",
    done: 0,
    total: 0,
    current_file: "",
    errors: [],
  };
  store().patch({ folder, state: "updating", error: null, progress: null, job: initial });
  void runUpdate(initial.id, folder, embedding);
  return initial;
}

async function runUpdate(id: string, folder: string, embedding: EmbeddingApi): Promise<void> {
  const { embeddingModel, fileExtensions, minChunkLength } = useSettingsStore.getState().ragSettings;
  let unlisten: UnlistenFn | null = null;
  try {
    await embedding.load(embeddingModel);

    unlisten = await listen<{ current: number; total: number; file: string }>("rag-scan-progress", (e) => {
      const { current, total, file } = e.payload;
      const name = fileNameOf(file);
      // Once the final file is reached the scan still has to serialize the
      // chunk array over IPC with no events; show a transitional phase.
      if (store().folder !== folder) return;
      store().patch({
        progress:
          current >= total
            ? { phase: "preparing", current, total, currentFile: "" }
            : { phase: "scanning", current, total, currentFile: name },
      });
      patchJob(id, { current_file: name });
    });

    const chunks = await invoke<any[]>("rag_scan_folder", {
      folderPath: folder,
      fileExtensions,
      minChunkLength,
      modelName: embeddingModel,
    });
    unlisten();
    unlisten = null;

    if (chunks.length > 0) {
      patchJob(id, { total: chunks.length });
      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i++) {
        const name = fileNameOf(chunks[i].file as string);
        if (store().folder === folder) {
          store().patch({ progress: { phase: "embedding", current: i + 1, total: chunks.length, currentFile: name } });
        }
        patchJob(id, { current_file: name });
        embeddings.push(await embedding.embed(chunks[i].text, "passage"));
        patchJob(id, { done: i + 1 });
      }
      if (store().folder === folder) {
        store().patch({ progress: { phase: "saving", current: chunks.length, total: chunks.length, currentFile: "" } });
      }
      const withEmbed = chunks.map((c, i) => ({ ...c, embedding: embeddings[i] }));
      await invoke<number>("rag_save_chunks", { folderPath: folder, chunks: withEmbed, modelName: embeddingModel });
    }

    // Mark the job done and publish fresh counts in a single update.
    const counts = await fetchCounts(folder);
    const job = store().job;
    // Only touch the flat fields while the store still points at this job's folder.
    const sameFolder = store().folder === folder;
    store().patch({
      ...(sameFolder
        ? {
            progress: null,
            state: counts.total_chunks > 0 ? ("ready" as const) : ("empty" as const),
            totalChunks: counts.total_chunks,
            totalFiles: counts.total_files,
          }
        : {}),
      job: job && job.id === id ? { ...job, state: "done", current_file: "" } : job,
    });
  } catch (e) {
    console.error("Build index failed:", e);
    const message = errorMessage(e);
    const job = store().job;
    const sameFolder = store().folder === folder;
    store().patch({
      ...(sameFolder ? { error: message, state: "error" as const, progress: null } : {}),
      job:
        job && job.id === id
          ? { ...job, state: "failed", current_file: "", errors: [{ path: folder, message }] }
          : job,
    });
  } finally {
    if (unlisten) unlisten();
  }
}

export async function listUnconvertedOfficeDocs(folder: string): Promise<ConvertibleFile[]> {
  const tree = await invoke<FileEntry[]>("get_file_tree", {
    path: folder,
    showAll: true,
    includeDocx: true,
    includeXls: true,
    includePptx: true,
    includeKm: true,
    includeImages: true,
    includePdf: true,
    includeEmptyDirs: false,
  });
  const files = collectConvertibleFiles(tree).filter((f) => f.type !== "doc" && !f.hasExistingMdSibling);
  // FTP mirrors convert into .mdium/ (kept local), so count those as done too.
  if (!mirrorUri(folder) || files.length === 0) return files;
  const inMdium = await invoke<Record<string, boolean>>("check_mdium_md_exists", {
    paths: files.map((f) => f.path),
  });
  return files.filter((f) => !inMdium[f.path]);
}

export function toUnconvertedDocs(files: ConvertibleFile[]): RagUnconvertedDoc[] {
  return files
    .filter((f): f is ConvertibleFile & { type: RagUnconvertedDoc["type"] } => f.type !== "doc")
    .map((f) => ({ path: f.path, type: f.type }));
}

const toSlashes = (p: string) => p.replace(/\\/g, "/");
const isAbsolutePath = (p: string) => /^[A-Za-z]:\//.test(p) || p.startsWith("/");
// Windows-style (drive letter) paths compare case-insensitively.
const pathKey = (p: string) => (/^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p);

/** Normalize separators and collapse "." / ".." segments. */
function normalizePath(p: string): string {
  const unified = toSlashes(p);
  const parts: string[] = [];
  for (const seg of unified.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const joined = parts.join("/");
  return unified.startsWith("/") ? `/${joined}` : joined;
}

export function resolveConvertPaths(
  folder: string,
  paths: string[],
  all: ConvertibleFile[],
): { accepted: ConvertibleFile[]; rejected: { path: string; reason: RagRejectReason }[] } {
  const root = normalizePath(folder);
  const rootPrefix = `${pathKey(root).replace(/\/$/, "")}/`;
  const byPath = new Map(all.map((f) => [pathKey(normalizePath(f.path)), f]));
  const accepted: ConvertibleFile[] = [];
  const rejected: { path: string; reason: RagRejectReason }[] = [];
  for (const raw of paths) {
    const unified = toSlashes(raw);
    const abs = normalizePath(isAbsolutePath(unified) ? unified : `${root}/${unified}`);
    const reject = (reason: RagRejectReason) => rejected.push({ path: raw, reason });
    if (!pathKey(abs).startsWith(rootPrefix)) {
      reject("outside_folder");
      continue;
    }
    const file = byPath.get(pathKey(abs));
    if (!file) reject("not_found");
    else if (file.type === "doc") reject("unsupported");
    else if (file.hasExistingMdSibling) reject("exists");
    else accepted.push(file);
  }
  return { accepted, rejected };
}

export function startConvertDocs(folder: string, files: ConvertibleFile[]): RagJobInfo {
  if (isJobRunning()) throw new JobRunningError();
  const initial: RagJobInfo = {
    id: crypto.randomUUID(),
    kind: "convert",
    folder,
    state: "running",
    done: 0,
    total: files.length,
    current_file: "",
    errors: [],
  };
  store().patch({ folder, state: "converting", error: null, progress: null, job: initial });
  void runConvert(initial.id, folder, files);
  return initial;
}

async function runConvert(id: string, folder: string, files: ConvertibleFile[]): Promise<void> {
  const labels: PptxLabels = {
    slideFallback: (n: number) => i18n.t("common:pptxSlideLabel", { n }),
    notes: i18n.t("common:pptxNotesLabel"),
  };
  const errors: RagJobInfo["errors"] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    patchJob(id, { current_file: file.name });
    try {
      // The .md lands next to the source file, except in FTP mirrors where it
      // goes to .mdium/ so it is not uploaded to the server.
      await convertFileToMarkdown(file, mirrorUri(folder) !== null, labels);
    } catch (e) {
      errors.push({ path: file.path, message: errorMessage(e) });
    }
    patchJob(id, { done: i + 1, errors: [...errors] });
  }
  const counts = await fetchCounts(folder);
  const job = store().job;
  const sameFolder = store().folder === folder;
  store().patch({
    ...(sameFolder
      ? {
          state: counts.total_chunks > 0 ? ("ready" as const) : ("empty" as const),
          totalChunks: counts.total_chunks,
          totalFiles: counts.total_files,
        }
      : {}),
    job: job && job.id === id ? { ...job, state: "done", current_file: "" } : job,
  });
}

export async function deleteIndex(folder: string): Promise<void> {
  if (isJobRunning()) throw new JobRunningError();
  const { embeddingModel } = useSettingsStore.getState().ragSettings;
  await invoke("rag_delete_index", { folderPath: folder, modelName: embeddingModel });
  store().patch({ folder, state: "empty", totalChunks: 0, totalFiles: 0, progress: null, error: null });
}

export function statusPayloadFor(
  folder: string,
  unconverted: RagUnconvertedDoc[],
  dbCounts: DbCounts,
): RagStatusPayload {
  const s = store();
  const sameFolder = s.folder === folder;
  const running = runningStateFor(folder);
  const state: RagIndexState =
    running ?? (sameFolder && s.error ? "error" : dbCounts.total_chunks > 0 ? "ready" : "empty");
  const storeError = sameFolder ? s.error : null;
  return {
    ok: true,
    state,
    total_chunks: dbCounts.total_chunks,
    total_files: dbCounts.total_files,
    embedding_model: useSettingsStore.getState().ragSettings.embeddingModel,
    progress:
      sameFolder && s.progress
        ? { phase: s.progress.phase, current: s.progress.current, total: s.progress.total }
        : null,
    unconverted_office_docs: unconverted,
    job: s.job && s.job.folder === folder ? s.job : null,
    error: storeError === "MODEL_MISSING" ? "model_missing" : storeError,
  };
}

export function errorCodeFor(e: unknown): RagBridgeErrorCode {
  return e instanceof JobRunningError ? "job_running" : "internal";
}

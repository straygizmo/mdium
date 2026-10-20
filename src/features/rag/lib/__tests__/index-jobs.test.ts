// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async (_name: string, _cb: unknown) => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import {
  JobRunningError,
  deleteIndex,
  errorCodeFor,
  refreshIndexStatus,
  startUpdateIndex,
  statusPayloadFor,
  type EmbeddingApi,
} from "../index-jobs";
import { useRagIndexStore } from "../../stores/rag-index-store";

const store = () => useRagIndexStore.getState();
const noCounts = { total_chunks: 0, total_files: 0 };

function mockInvoke(handlers: Record<string, (args: any) => unknown>) {
  tauri.invoke.mockImplementation(async (cmd: string, args: any) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unexpected ${cmd}`);
    return h(args);
  });
}

function fakeEmbedding(overrides: Partial<EmbeddingApi> = {}): EmbeddingApi {
  return {
    load: vi.fn(async () => {}),
    embed: vi.fn(async () => [0.1, 0.2]),
    ...overrides,
  };
}

describe("rag index jobs", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    store().resetFor(null);
    store().patch({ job: null });
  });

  it("refreshIndexStatus maps DB counts to ready/empty", async () => {
    mockInvoke({ rag_get_status: () => ({ total_chunks: 3, total_files: 2 }) });
    await refreshIndexStatus("C:/w");
    expect(store()).toMatchObject({ folder: "C:/w", state: "ready", totalChunks: 3, totalFiles: 2 });

    mockInvoke({ rag_get_status: () => ({ total_chunks: 0, total_files: 0 }) });
    await refreshIndexStatus("C:/w");
    expect(store().state).toBe("empty");
  });

  it("refreshIndexStatus for another folder drops the previous folder's error and progress", async () => {
    mockInvoke({});
    startUpdateIndex("C:/w", fakeEmbedding({ load: vi.fn(async () => { throw new Error("boom"); }) }));
    await vi.waitFor(() => expect(store().state).toBe("error"));
    store().patch({ progress: { phase: "scanning", current: 1, total: 2, currentFile: "a" } });
    mockInvoke({ rag_get_status: () => noCounts });
    await refreshIndexStatus("C:/other");
    expect(store()).toMatchObject({ folder: "C:/other", error: null, progress: null, state: "empty" });
  });

  it("a running job does not write progress after the store moved to another folder", async () => {
    let finishScan!: (v: unknown) => void;
    mockInvoke({
      rag_scan_folder: () => new Promise((r) => (finishScan = r)),
      rag_save_chunks: () => 1,
      rag_get_status: () => noCounts,
    });
    startUpdateIndex("C:/w", fakeEmbedding());
    await vi.waitFor(() => expect(finishScan).toBeTypeOf("function"));
    await refreshIndexStatus("C:/other");
    finishScan([{ file: "C:/w/a.md", text: "a" }]);
    await vi.waitFor(() => expect(store().job?.state).toBe("done"));
    expect(store().folder).toBe("C:/other");
    expect(store().progress).toBeNull();
  });

  it("startUpdateIndex embeds chunks, saves them and finishes done/ready", async () => {
    const chunks = [
      { file: "C:/w/a.md", text: "a" },
      { file: "C:/w/b.md", text: "b" },
    ];
    let saved: any = null;
    mockInvoke({
      rag_scan_folder: () => chunks,
      rag_save_chunks: (a) => ((saved = a), 2),
      rag_get_status: () => ({ total_chunks: 2, total_files: 2 }),
    });
    const emb = fakeEmbedding();
    const info = startUpdateIndex("C:/w", emb);
    expect(info).toMatchObject({ kind: "update", folder: "C:/w", state: "running", done: 0 });
    expect(store().state).toBe("updating");

    await vi.waitFor(() => expect(store().job?.state).toBe("done"));
    expect(emb.embed).toHaveBeenCalledTimes(2);
    expect(emb.embed).toHaveBeenCalledWith("a", "passage");
    expect(saved.chunks).toHaveLength(2);
    expect(saved.chunks[0].embedding).toEqual([0.1, 0.2]);
    expect(store().job).toMatchObject({ id: info.id, done: 2, total: 2 });
    expect(store()).toMatchObject({ state: "ready", totalChunks: 2, progress: null });
    expect(info.state).toBe("running"); // returned object is the initial snapshot
  });

  it("records a failed job when the model is missing", async () => {
    mockInvoke({});
    startUpdateIndex("C:/w", fakeEmbedding({ load: vi.fn(async () => { throw new Error("MODEL_MISSING"); }) }));
    await vi.waitFor(() => expect(store().job?.state).toBe("failed"));
    expect(store().job?.errors[0].message).toBe("MODEL_MISSING");
    expect(store().state).toBe("error");
    expect(statusPayloadFor("C:/w", [], noCounts).error).toBe("model_missing");
    expect(statusPayloadFor("C:/w", [], noCounts).state).toBe("error");
  });

  it("tags numeric aborts as ENGINE_CRASH", async () => {
    mockInvoke({});
    startUpdateIndex("C:/w", fakeEmbedding({ load: vi.fn(async () => { throw 42; }) }));
    await vi.waitFor(() => expect(store().job?.state).toBe("failed"));
    expect(store().error).toBe("ENGINE_CRASH:42");
  });

  it("rejects a second job while one is running", async () => {
    let release: (v: unknown[]) => void = () => {};
    mockInvoke({
      rag_scan_folder: () => new Promise((r) => { release = r; }),
      rag_get_status: () => noCounts,
    });
    startUpdateIndex("C:/w", fakeEmbedding());
    let caught: unknown;
    try { startUpdateIndex("C:/w", fakeEmbedding()); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(JobRunningError);
    expect(errorCodeFor(caught)).toBe("job_running");
    expect(errorCodeFor(new Error("x"))).toBe("internal");
    await expect(deleteIndex("C:/w")).rejects.toBeInstanceOf(JobRunningError);
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("rag_scan_folder", expect.anything()));
    release([]);
    await vi.waitFor(() => expect(store().job?.state).toBe("done"));
  });

  it("statusPayloadFor ignores a job from another folder", () => {
    mockInvoke({ rag_scan_folder: () => new Promise(() => {}) });
    startUpdateIndex("C:/w", fakeEmbedding());
    const running = statusPayloadFor("C:/w", [], noCounts);
    expect(running.state).toBe("updating");
    expect(running.job?.state).toBe("running");
    const other = statusPayloadFor("C:/other", [], noCounts);
    expect(other.job).toBeNull();
    expect(other.state).toBe("empty");
    expect(statusPayloadFor("C:/other", [], { total_chunks: 5, total_files: 1 }).state).toBe("ready");
  });

  it("deleteIndex invokes rag_delete_index and leaves the store empty", async () => {
    mockInvoke({ rag_delete_index: () => undefined });
    store().patch({ folder: "C:/w", state: "ready", totalChunks: 4, totalFiles: 1 });
    await deleteIndex("C:/w");
    expect(tauri.invoke).toHaveBeenCalledWith("rag_delete_index", expect.objectContaining({ folderPath: "C:/w" }));
    expect(store()).toMatchObject({ state: "empty", totalChunks: 0, totalFiles: 0 });
  });
});

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
const jobs = vi.hoisted(() => ({
  listUnconvertedOfficeDocs: vi.fn(),
  resolveConvertPaths: vi.fn(),
  startConvertDocs: vi.fn(),
  startUpdateIndex: vi.fn(),
  statusPayloadFor: vi.fn(),
  toUnconvertedDocs: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("../index-jobs", async () => {
  const actual = await vi.importActual<typeof import("../index-jobs")>("../index-jobs");
  return { ...actual, ...jobs };
});

import { handleRagBridgeRequest, type BridgeDeps } from "../bridge-handlers";
import { JobRunningError } from "../index-jobs";
import { useRagIndexStore } from "../../stores/rag-index-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { RagBridgeRequest } from "@/shared/types/rag-bridge";

const file = (path: string) => ({ name: path.split("/").pop()!, path, type: "docx" });

function deps(over: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    embedding: { load: vi.fn(async () => {}), embed: vi.fn(async () => [0.1]) },
    confirm: vi.fn(async () => true),
    ...over,
  };
}
const req = (over: Partial<RagBridgeRequest>): RagBridgeRequest => ({
  id: "1",
  kind: "convert",
  folderPath: "C:/w",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useRagIndexStore.setState({ job: null });
  useSettingsStore.setState({
    replacement: { enabled: true, rules: [{ id: "r", from: "Secret", to: "XXX", enabled: true }] },
  } as any);
  jobs.listUnconvertedOfficeDocs.mockResolvedValue([file("C:/w/Secret.docx")]);
  jobs.toUnconvertedDocs.mockImplementation((fs: any[]) => fs.map((f) => ({ path: f.path, type: f.type })));
  jobs.statusPayloadFor.mockImplementation((_f, docs, counts) => ({ ok: true, docs, counts }));
  jobs.resolveConvertPaths.mockReturnValue({ accepted: [file("C:/w/Secret.docx")], rejected: [] });
  jobs.startConvertDocs.mockReturnValue({ id: "job1" });
  jobs.startUpdateIndex.mockReturnValue({ id: "job2" });
  tauri.invoke.mockResolvedValue({ total_chunks: 3, total_files: 2 });
});

describe("handleRagBridgeRequest", () => {
  it("status masks only the file-name segment", async () => {
    const r: any = await handleRagBridgeRequest(req({ kind: "status" }), "C:/w", deps());
    expect(r.docs).toEqual([{ path: "C:/w/XXX.docx", type: "docx" }]);
    expect(r.counts).toEqual({ total_chunks: 3, total_files: 2 });
  });

  it("returns no_folder for a drive root", async () => {
    const r = await handleRagBridgeRequest(req({ folderPath: "C:\\" }), null, deps());
    expect(r).toMatchObject({ ok: false, error: "no_folder" });
  });

  it("convert denied by the user starts no job", async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    const r = await handleRagBridgeRequest(req({ approval: "ask", paths: ["a"] }), "C:/w", d);
    expect(r).toMatchObject({ ok: false, error: "approval_denied" });
    expect(jobs.startConvertDocs).not.toHaveBeenCalled();
  });

  it("convert approval timeout starts no job", async () => {
    const d = deps({ confirm: vi.fn(() => new Promise<boolean>(() => {})), approvalTimeoutMs: 10 });
    const r = await handleRagBridgeRequest(req({ approval: "ask", paths: ["a"] }), "C:/w", d);
    expect(r).toMatchObject({ ok: false, error: "approval_timeout" });
    expect(jobs.startConvertDocs).not.toHaveBeenCalled();
  });

  it("convert with auto approval skips confirm", async () => {
    const d = deps();
    const r = await handleRagBridgeRequest(req({ approval: "auto", paths: ["a"] }), "C:/w", d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, job_id: "job1", accepted: ["C:/w/XXX.docx"], rejected: [] });
  });

  it("convert asks with the real file list (the dialog is local)", async () => {
    const d = deps();
    await handleRagBridgeRequest(req({ approval: "ask", paths: ["a"] }), "C:/w", d);
    const msg = (d.confirm as any).mock.calls[0][0] as string;
    expect(msg).toContain("Secret.docx");
  });

  it("convert accepts a masked path, converts the real file and reports masked accepted", async () => {
    jobs.resolveConvertPaths.mockImplementation((_f: string, paths: string[], all: any[]) => ({
      accepted: all.filter((f) => paths.includes(f.path)),
      rejected: paths.filter((p) => !all.some((f) => f.path === p)).map((p) => ({ path: p, reason: "not_found" })),
    }));
    const d = deps();
    const r: any = await handleRagBridgeRequest(req({ approval: "ask", paths: ["XXX.docx", "nope.docx"] }), "C:/w", d);
    expect(jobs.startConvertDocs).toHaveBeenCalledWith("C:/w", [file("C:/w/Secret.docx")]);
    expect(r.accepted).toEqual(["C:/w/XXX.docx"]);
    expect(r.rejected).toEqual([{ path: "nope.docx", reason: "not_found" }]);
    expect((d.confirm as any).mock.calls[0][0]).toContain("Secret.docx");
  });

  it.each(["status", "convert", "update"] as const)("%s without an active folder returns no_folder", async (kind) => {
    const d = deps();
    const r = await handleRagBridgeRequest(req({ kind, approval: "ask", paths: ["a"] }), null, d);
    expect(r).toMatchObject({ ok: false, error: "no_folder" });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(jobs.startConvertDocs).not.toHaveBeenCalled();
    expect(jobs.startUpdateIndex).not.toHaveBeenCalled();
  });

  it("search still falls back to req.folderPath without an active folder", async () => {
    tauri.invoke.mockImplementation(async (cmd: string) => (cmd === "rag_check_model" ? true : []));
    const r = await handleRagBridgeRequest(req({ kind: "search", query: "q", searchMode: "hybrid" }), null, deps());
    expect(r).toEqual({ ok: true, results: [] });
  });

  it("aborts the confirm signal when the approval times out", async () => {
    let seen: AbortSignal | undefined;
    const d = deps({
      confirm: vi.fn((_m: string, signal: AbortSignal) => {
        seen = signal;
        return new Promise<boolean>(() => {});
      }),
      approvalTimeoutMs: 10,
    });
    await handleRagBridgeRequest(req({ approval: "ask", paths: ["a"] }), "C:/w", d);
    expect(seen?.aborted).toBe(true);
  });

  it("convert with everything rejected returns nothing_to_convert", async () => {
    const rejected = [{ path: "x", reason: "not_found" }];
    jobs.resolveConvertPaths.mockReturnValue({ accepted: [], rejected });
    const r = await handleRagBridgeRequest(req({ approval: "auto", paths: ["x"] }), "C:/w", deps());
    expect(r).toEqual({ ok: false, error: "nothing_to_convert", message: JSON.stringify(rejected) });
  });

  it("update while a job runs returns job_running without asking", async () => {
    useRagIndexStore.setState({ job: { state: "running" } } as any);
    const d = deps();
    const r = await handleRagBridgeRequest(req({ kind: "update", approval: "ask" }), "C:/w", d);
    expect(r).toMatchObject({ ok: false, error: "job_running" });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("update approved starts the job; JobRunningError maps to job_running", async () => {
    const r = await handleRagBridgeRequest(req({ kind: "update", approval: "ask" }), "C:/w", deps());
    expect(r).toEqual({ ok: true, job_id: "job2" });
    jobs.startUpdateIndex.mockImplementation(() => {
      throw new JobRunningError();
    });
    const r2 = await handleRagBridgeRequest(req({ kind: "update", approval: "auto" }), "C:/w", deps());
    expect(r2).toMatchObject({ ok: false, error: "job_running" });
  });

  it("search masks heading and content", async () => {
    tauri.invoke.mockImplementation(async (cmd: string) =>
      cmd === "rag_check_model"
        ? true
        : [{ file: "f.md", heading: "Secret h", text: "Secret t", line: 4, score: 0.9 }],
    );
    const r: any = await handleRagBridgeRequest(
      req({ kind: "search", query: "q", searchMode: "hybrid" }),
      "C:/w",
      deps(),
    );
    expect(r.results[0]).toMatchObject({ heading: "XXX h", content: "XXX t", line_number: 4 });
  });
});

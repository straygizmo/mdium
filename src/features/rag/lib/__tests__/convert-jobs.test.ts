// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async (_name: string, _cb: unknown) => () => {}),
}));
const conv = vi.hoisted(() => ({ convertFileToMarkdown: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@/features/export/lib/convertFileToMarkdown", () => ({
  convertFileToMarkdown: conv.convertFileToMarkdown,
}));

import {
  JobRunningError,
  listUnconvertedOfficeDocs,
  resolveConvertPaths,
  startConvertDocs,
  startUpdateIndex,
  toUnconvertedDocs,
} from "../index-jobs";
import { useRagIndexStore } from "../../stores/rag-index-store";
import type { ConvertibleFile } from "@/features/export/lib/collectConvertibleFiles";

const store = () => useRagIndexStore.getState();

function cf(path: string, type: ConvertibleFile["type"], sibling = false): ConvertibleFile {
  return {
    name: path.split("/").pop()!,
    path,
    type,
    hasExistingMdSibling: sibling,
    hasExistingMdInMdium: false,
  };
}

function mockInvoke(handlers: Record<string, (args: any) => unknown>) {
  tauri.invoke.mockImplementation(async (cmd: string, args: any) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unexpected ${cmd}`);
    return h(args);
  });
}

describe("resolveConvertPaths", () => {
  const all = [
    cf("C:/w/sub/a.docx", "docx"),
    cf("C:/w/old.doc", "doc"),
    cf("C:/w/done.pdf", "pdf", true),
  ];

  it("accepts absolute and relative paths under the folder", () => {
    const r = resolveConvertPaths("C:/w", ["C:/w/sub/a.docx", "sub/a.docx", "C:\\w\\sub\\A.docx"], all);
    expect(r.accepted).toHaveLength(3);
    expect(r.rejected).toEqual([]);
  });

  it("rejects with the right reason", () => {
    const r = resolveConvertPaths(
      "C:/w",
      ["../x.docx", "C:/w/sub/../../x.docx", "old.doc", "done.pdf", "nope.docx"],
      all,
    );
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([
      { path: "../x.docx", reason: "outside_folder" },
      { path: "C:/w/sub/../../x.docx", reason: "outside_folder" },
      { path: "old.doc", reason: "unsupported" },
      { path: "done.pdf", reason: "exists" },
      { path: "nope.docx", reason: "not_found" },
    ]);
  });
});

describe("unconverted discovery", () => {
  it("lists convertible files without a sibling md and maps xlsm to xlsx", async () => {
    const f = (name: string) => ({ name, path: `C:/w/${name}`, is_dir: false, children: null });
    mockInvoke({
      get_file_tree: () => [f("a.docx"), f("a.md"), f("b.xlsm"), f("c.doc"), f("d.pdf")],
    });
    const files = await listUnconvertedOfficeDocs("C:/w");
    expect(files.map((x) => x.name)).toEqual(["b.xlsm", "d.pdf"]);
    expect(toUnconvertedDocs(files)).toEqual([
      { path: "C:/w/b.xlsm", type: "xlsx" },
      { path: "C:/w/d.pdf", type: "pdf" },
    ]);
  });
});

describe("startConvertDocs", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    conv.convertFileToMarkdown.mockReset();
    store().resetFor(null);
    store().patch({ job: null });
  });

  it("continues after a per-file failure and finishes done", async () => {
    mockInvoke({ rag_get_status: () => ({ total_chunks: 0, total_files: 0 }) });
    conv.convertFileToMarkdown
      .mockResolvedValueOnce({ mdPath: "C:/w/a.md" })
      .mockRejectedValueOnce(new Error("boom"));
    const info = startConvertDocs("C:/w", [cf("C:/w/a.docx", "docx"), cf("C:/w/b.pdf", "pdf")]);
    expect(info).toMatchObject({ kind: "convert", state: "running", done: 0, total: 2 });
    expect(store().state).toBe("converting");

    await vi.waitFor(() => expect(store().job?.state).toBe("done"));
    expect(conv.convertFileToMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ path: "C:/w/a.docx" }),
      false,
      expect.objectContaining({ notes: expect.any(String) }),
    );
    expect(store().job).toMatchObject({ done: 2, total: 2, current_file: "" });
    expect(store().job?.errors).toEqual([{ path: "C:/w/b.pdf", message: "boom" }]);
    expect(store().state).toBe("empty");
    expect(tauri.invoke).not.toHaveBeenCalledWith("rag_scan_folder", expect.anything());
  });

  it("rejects a second job while converting", async () => {
    mockInvoke({ rag_get_status: () => ({ total_chunks: 0, total_files: 0 }) });
    let release: (v: unknown) => void = () => {};
    conv.convertFileToMarkdown.mockImplementation(() => new Promise((r) => { release = r; }));
    startConvertDocs("C:/w", [cf("C:/w/a.docx", "docx")]);
    expect(() => startConvertDocs("C:/w", [cf("C:/w/b.docx", "docx")])).toThrow(JobRunningError);
    release({ mdPath: "x" });
    await vi.waitFor(() => expect(store().job?.state).toBe("done"));
  });

  it("does not touch flat store fields when the folder changed mid-job", async () => {
    mockInvoke({ rag_get_status: () => ({ total_chunks: 9, total_files: 9 }) });
    let release: (v: unknown) => void = () => {};
    conv.convertFileToMarkdown.mockImplementation(() => new Promise((r) => { release = r; }));
    startConvertDocs("C:/w", [cf("C:/w/a.docx", "docx")]);
    store().resetFor("C:/other");
    release({ mdPath: "x" });
    await vi.waitFor(() => expect(store().job?.state).toBe("done"));
    expect(store()).toMatchObject({ folder: "C:/other", state: "unknown", totalChunks: 0, totalFiles: 0 });
  });

  it("update job completion also leaves a switched folder untouched", async () => {
    let release: (v: unknown[]) => void = () => {};
    mockInvoke({
      rag_scan_folder: () => new Promise((r) => { release = r; }),
      rag_get_status: () => ({ total_chunks: 7, total_files: 7 }),
    });
    startUpdateIndex("C:/w", { load: async () => {}, embed: async () => [0] });
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("rag_scan_folder", expect.anything()));
    store().resetFor("C:/other");
    release([]);
    await vi.waitFor(() => expect(store().job?.state).toBe("done"));
    expect(store()).toMatchObject({ folder: "C:/other", state: "unknown", totalChunks: 0, totalFiles: 0 });
  });
});

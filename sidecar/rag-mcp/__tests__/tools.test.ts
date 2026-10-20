// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readBridgeInfo } from "../bridge-client";
import { callRagTool, listRagTools, parsePermission, type RagToolDeps } from "../tools";

function makeDeps(over: Partial<RagToolDeps> = {}) {
  const callBridge = vi.fn(async () => ({ status: 200, json: { ok: true, results: [] } as unknown }));
  const deps: RagToolDeps = {
    permission: "ask",
    folderPath: "/proj",
    readBridgeInfo: async () => ({ port: 1234, token: "tok" }),
    callBridge: callBridge as unknown as RagToolDeps["callBridge"],
    ...over,
  };
  return { deps, callBridge };
}

describe("listRagTools", () => {
  it("hides write tools in read-only", () => {
    expect(listRagTools("read-only").map((t) => t.name)).toEqual(["rag_search", "rag_status"]);
  });
  it("lists all four otherwise", () => {
    for (const p of ["ask", "auto"] as const) {
      expect(listRagTools(p).map((t) => t.name).sort()).toEqual([
        "convert_office_docs",
        "rag_search",
        "rag_status",
        "rag_update_index",
      ]);
    }
  });
});

describe("parsePermission", () => {
  it("parses with ask default", () => {
    expect(parsePermission(undefined)).toBe("ask");
    expect(parsePermission("auto")).toBe("auto");
    expect(parsePermission("junk")).toBe("ask");
  });
});

describe("callRagTool", () => {
  it("rejects convert in read-only without calling the bridge", async () => {
    const { deps, callBridge } = makeDeps({ permission: "read-only" });
    const r = await callRagTool("convert_office_docs", { paths: ["a.docx"] }, deps);
    expect(r.isError).toBe(true);
    expect(callBridge).not.toHaveBeenCalled();
  });
  it("posts approval auto/ask for convert", async () => {
    for (const [perm, approval] of [
      ["auto", "auto"],
      ["ask", "ask"],
    ] as const) {
      const { deps, callBridge } = makeDeps({ permission: perm });
      await callRagTool("convert_office_docs", { paths: ["a.docx"] }, deps);
      const call = callBridge.mock.calls[0] as unknown[];
      expect(call[1]).toBe("/rag/convert");
      expect(call[2]).toEqual({ folder_path: "/proj", paths: ["a.docx"], approval });
    }
  });
  it("posts update body", async () => {
    const { deps, callBridge } = makeDeps({ permission: "auto" });
    await callRagTool("rag_update_index", {}, deps);
    const call = callBridge.mock.calls[0] as unknown[];
    expect(call[1]).toBe("/rag/update");
    expect(call[2]).toEqual({ folder_path: "/proj", approval: "auto" });
  });
  it("search maps args and formats results", async () => {
    const { deps, callBridge } = makeDeps();
    callBridge.mockResolvedValueOnce({ status: 200, json: { ok: true, results: [{ a: 1 }] } });
    const r = await callRagTool("rag_search", { query: "q", top_k: 3 }, deps);
    const body = (callBridge.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(body).toMatchObject({ folder_path: "/proj", query: "q", limit: 3 });
    expect(r.content[0].text).toBe(JSON.stringify([{ a: 1 }], null, 2));
  });
  it("search with no results says none found", async () => {
    const { deps } = makeDeps();
    const r = await callRagTool("rag_search", { query: "q" }, deps);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("No documents found");
  });
  it("surfaces bridge errors", async () => {
    const { deps, callBridge } = makeDeps();
    callBridge.mockResolvedValueOnce({ status: 409, json: { ok: false, error: "job_running" } });
    const r = await callRagTool("rag_status", {}, deps);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("job_running");
  });
  it("reports unreachable mdium", async () => {
    const { deps } = makeDeps({ readBridgeInfo: async () => null });
    const r = await callRagTool("rag_status", {}, deps);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Cannot reach mdium");
  });
  it("turns thrown errors into error results", async () => {
    const { deps, callBridge } = makeDeps();
    callBridge.mockRejectedValueOnce(new Error("boom"));
    const r = await callRagTool("rag_status", {}, deps);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("boom");
  });
});

describe("readBridgeInfo", () => {
  it("reads env", async () => {
    expect(await readBridgeInfo({ MDIUM_BRIDGE_PORT: "1", MDIUM_BRIDGE_TOKEN: "t" })).toEqual({
      port: 1,
      token: "t",
    });
  });
  it("reads ~/.mdium/bridge.json", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mdium-home-"));
    fs.mkdirSync(path.join(home, ".mdium"));
    fs.writeFileSync(path.join(home, ".mdium", "bridge.json"), JSON.stringify({ port: 9, token: "x" }));
    expect(await readBridgeInfo({}, home)).toEqual({ port: 9, token: "x" });
    fs.rmSync(home, { recursive: true, force: true });
  });
  it("returns null when nothing is found", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mdium-home-"));
    expect(await readBridgeInfo({}, home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });
});

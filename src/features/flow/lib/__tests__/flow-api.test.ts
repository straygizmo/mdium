import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { flowApi, isFlowCommandError, subscribeSetupProgress } from "../flow-api";
import { setFlowTransport } from "../transport";
import type { SetupProgressEvent } from "@/shared/types/flow-run";
import { FLOW_ERROR_CODES, FLOW_WARNING_CODES } from "@/shared/types/flow";

const ROOT = "C:\proj";
const PATH = ".mdium/flows/a.flow.yaml";

describe("flowApi", () => {
  beforeEach(() => invoke.mockReset());

  it.each([
    ["list", () => flowApi.list(ROOT), "flow_list", { projectRoot: ROOT }],
    ["load", () => flowApi.load(ROOT, PATH), "flow_load", { projectRoot: ROOT, path: PATH }],
    [
      "validate",
      () => flowApi.validate(ROOT, PATH, "schemaVersion: 1"),
      "flow_validate",
      { projectRoot: ROOT, path: PATH, content: "schemaVersion: 1" },
    ],
    ["projectLoad", () => flowApi.projectLoad(ROOT), "flow_project_load", { projectRoot: ROOT }],
    ["projectSetup", () => flowApi.projectSetup(ROOT), "flow_project_setup", { projectRoot: ROOT }],
  ] as const)("%s invokes %s", async (_name, call, command, args) => {
    invoke.mockResolvedValueOnce("ok");
    await expect(call()).resolves.toBe("ok");
    expect(invoke).toHaveBeenCalledWith(command, args);
  });

  it("normalizes command errors given as objects or JSON strings", async () => {
    invoke.mockRejectedValueOnce({ code: "FLOW_FILE_NOT_FOUND", message: "m", extra: 1 });
    await expect(flowApi.load(ROOT, PATH)).rejects.toEqual({ code: "FLOW_FILE_NOT_FOUND", message: "m" });
    invoke.mockRejectedValueOnce(JSON.stringify({ code: "FLOW_PROJECT_INVALID", message: "x" }));
    await expect(flowApi.list(ROOT)).rejects.toEqual({ code: "FLOW_PROJECT_INVALID", message: "x" });
  });

  it("rethrows anything else unchanged", async () => {
    const err = new Error("boom");
    invoke.mockRejectedValueOnce(err);
    await expect(flowApi.list(ROOT)).rejects.toBe(err);
    invoke.mockRejectedValueOnce("not json");
    await expect(flowApi.list(ROOT)).rejects.toBe("not json");
  });

  it("subscribes to setup progress through the transport", async () => {
    const seen: Array<[string, (payload: unknown) => void]> = [];
    const unlisten = () => {};
    setFlowTransport({
      call: async () => undefined as never,
      subscribe: async <T,>(event: string, handler: (payload: T) => void) => {
        seen.push([event, handler as (payload: unknown) => void]);
        return unlisten;
      },
    });
    try {
      const received: SetupProgressEvent[] = [];
      await expect(subscribeSetupProgress((e) => received.push(e))).resolves.toBe(unlisten);
      expect(seen[0][0]).toBe("flow://setup-progress");
      const payload: SetupProgressEvent = {
        projectRoot: ROOT,
        setupId: "s1",
        step: 1,
        total: 2,
        status: "started",
        run: ["npm", "ci"],
      };
      seen[0][1](payload);
      expect(received).toEqual([payload]);
    } finally {
      setFlowTransport(null);
    }
  });

  it("recognizes command errors", () => {
    expect(isFlowCommandError({ code: "A", message: "b" })).toBe(true);
    expect(isFlowCommandError({ code: "A" })).toBe(false);
    expect(isFlowCommandError(null)).toBe(false);
  });
});

describe("issue codes", () => {
  it("mirror the Rust constants exactly", () => {
    const rust = readFileSync(resolve(__dirname, "../../../../../src-tauri/crates/flow-core/src/issues.rs"), "utf8");
    const codes = [...rust.matchAll(/pub const (FLOW_[A-Z_]+): &str = "\1";/g)].map((m) => m[1]);
    expect([...codes].sort()).toEqual([...FLOW_ERROR_CODES, ...FLOW_WARNING_CODES].sort());
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

import { getFlowTransport, setFlowTransport, type FlowTransport } from "../transport";
import { createTauriTransport } from "../tauri-transport";
import { flowApi } from "../flow-api";
import { flowRunApi, subscribeFlowRunEvents } from "../flow-run-api";

describe("FlowTransport registry", () => {
  beforeEach(() => {
    invoke.mockReset();
    listeners.clear();
  });
  afterEach(() => setFlowTransport(null));

  it("defaults to the Tauri transport", async () => {
    invoke.mockResolvedValueOnce(["x"]);
    await expect(getFlowTransport().call("flow_list", { projectRoot: "C:\\p" })).resolves.toEqual(["x"]);
    expect(invoke).toHaveBeenCalledWith("flow_list", { projectRoot: "C:\\p" });
  });

  it("routes flowApi and flowRunApi through the registered transport", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const fake: FlowTransport = {
      call: async <T,>(command: string, args: Record<string, unknown>) => {
        calls.push([command, args]);
        return "ok" as T;
      },
      subscribe: async () => () => {},
    };
    setFlowTransport(fake);
    await expect(flowApi.list("C:\\p")).resolves.toBe("ok");
    await expect(flowRunApi.get("C:\\p", "r1")).resolves.toBe("ok");
    expect(calls).toEqual([
      ["flow_list", { projectRoot: "C:\\p" }],
      ["flow_run_get", { projectRoot: "C:\\p", runId: "r1" }],
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still normalizes command errors coming from a custom transport", async () => {
    setFlowTransport({
      call: async () => {
        throw JSON.stringify({ code: "FLOW_PROJECT_INVALID", message: "x" });
      },
      subscribe: async () => () => {},
    });
    await expect(flowApi.list("")).rejects.toEqual({ code: "FLOW_PROJECT_INVALID", message: "x" });
  });

  it("keeps an earlier unsubscribe bound to the transport that created it", async () => {
    // Review Focus 3: swapping the transport must not orphan live listeners.
    const detached: string[] = [];
    const first: FlowTransport = {
      call: async <T,>() => undefined as T,
      subscribe: async (event) => () => {
        detached.push(event);
      },
    };
    setFlowTransport(first);
    const unlisten = await subscribeFlowRunEvents({ onRunChanged: vi.fn() });
    setFlowTransport({ call: async <T,>() => undefined as T, subscribe: async () => () => {} });
    unlisten();
    expect(detached).toEqual(["flow://run-changed"]);
  });
});

describe("Tauri transport", () => {
  beforeEach(() => {
    invoke.mockReset();
    listeners.clear();
  });

  it("subscribe hands the handler the event payload only", async () => {
    // Review Focus 4: handlers get `event.payload`, not the envelope.
    const transport = createTauriTransport();
    const seen: unknown[] = [];
    const off = await transport.subscribe("flow://progress", (p) => seen.push(p));
    listeners.get("flow://progress")!({ payload: { runId: "r", text: "t" } });
    expect(seen).toEqual([{ runId: "r", text: "t" }]);
    off();
    expect(listeners.has("flow://progress")).toBe(false);
  });

  it("call forwards to invoke unchanged", async () => {
    invoke.mockResolvedValueOnce(7);
    await expect(createTauriTransport().call("flow_run_log", { maxBytes: 1 })).resolves.toBe(7);
    expect(invoke).toHaveBeenCalledWith("flow_run_log", { maxBytes: 1 });
  });
});

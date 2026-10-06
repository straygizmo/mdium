// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import type { FlowDef } from "@/shared/types/flow";
import type { CommandReview, RunSnapshot, RunSummary } from "@/shared/types/flow-run";

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));
const showConfirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/stores/dialog-store", async (orig) => ({ ...(await orig<object>()), showConfirm }));

import { RunPanel, sameRoot } from "../RunPanel";
import { RunStartDialog, initialParamValues, paramsFromForm } from "../RunStartDialog";
import { flowRunApi, subscribeFlowRunEvents, toFlowRunError } from "../../lib/flow-run-api";
import { describeError, describeReason, formatUsd } from "../../lib/run-format";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "C:\\proj";
const PATH = ".mdium/flows/f.flow.yaml";

const flow: FlowDef = {
  schemaVersion: 1,
  id: "f",
  name: "F",
  params: {
    dir: { type: "path", required: true },
    n: { type: "number", default: 3 },
    flag: { type: "bool", default: true },
  },
  nodes: [
    { id: "a", kind: "command", run: ["tool", "${{ params.dir }}"], shell: false, protocol: "mdium-v1" },
    { id: "ok", kind: "approval", options: ["publish", "reject"] },
  ],
  edges: [{ from: "a", to: "ok" }],
};

const review: CommandReview = {
  path: PATH,
  sha256: "abc",
  confirmed: false,
  commands: [{ nodeId: "a", run: ["tool", "${{ params.dir }}"], shell: false, env: { K: "v" }, templated: true }],
};

function summary(runId: string, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    runId,
    flowPath: PATH,
    flowName: "F",
    status: "running",
    createdAt: "2026-10-06T00:00:00.000Z",
    costUsd: 0,
    pendingApprovals: 0,
    ...extra,
  };
}

function snapshot(runId: string, extra: Partial<RunSnapshot["state"]> = {}, active = false): RunSnapshot {
  return {
    meta: { schemaVersion: 1, runId, flowPath: PATH, flowSha256: "abc", flow, params: {}, createdAt: "t", startedBy: "user" },
    state: {
      seq: 3,
      status: "interrupted",
      nodes: {
        a: { status: "interrupted", attempt: 1, cost: { actual: 0.5, estimated: 0 }, costReported: true, reason: { code: "FLOW_APP_EXITED" } },
        ok: { status: "pending", attempt: 0, cost: { actual: 0, estimated: 0 }, costReported: false },
      },
      cost: { actual: 0.5, estimated: 0 },
      ...extra,
    },
    active,
  };
}

/** Routes invoke calls by command name. */
function route(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const handler = handlers[command];
    if (!handler) throw { code: "FLOW_COMMAND_FAILED", message: `unexpected ${command}` };
    return handler(args);
  });
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function waitFor(check: () => void, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    }
  }
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`no button "${text}" in: ${container.textContent}`);
  return found as HTMLButtonElement;
}

describe("flow run api", () => {
  beforeEach(() => invoke.mockReset());

  it("passes arguments and keeps error details", async () => {
    invoke.mockResolvedValueOnce([]);
    await flowRunApi.list(ROOT);
    expect(invoke).toHaveBeenCalledWith("flow_run_list", { projectRoot: ROOT });
    invoke.mockResolvedValueOnce(undefined);
    await flowRunApi.approve(ROOT, "r", null, "approve", null);
    expect(invoke).toHaveBeenLastCalledWith("flow_run_approve", { projectRoot: ROOT, runId: "r", nodeKey: null, choice: "approve", comment: null });
    invoke.mockRejectedValueOnce({ code: "FLOW_PARAMS_INVALID", message: "m", details: [{ code: "FLOW_PARAM_MISSING", params: { param: "dir" } }] });
    await expect(flowRunApi.start(ROOT, PATH, {}, "s")).rejects.toEqual({
      code: "FLOW_PARAMS_INVALID",
      message: "m",
      details: [{ code: "FLOW_PARAM_MISSING", params: { param: "dir" } }],
    });
    expect(toFlowRunError("nope")).toBeNull();
    expect(toFlowRunError(JSON.stringify({ code: "C", message: "m" }))).toEqual({ code: "C", message: "m" });
  });

  it("subscribes to the four run events", async () => {
    listeners.clear();
    const onRunChanged = vi.fn();
    const unlisten = await subscribeFlowRunEvents({ onRunChanged, onNodeChanged: vi.fn(), onProgress: vi.fn(), onApprovalRequested: vi.fn() });
    expect([...listeners.keys()].sort()).toEqual([
      "flow://approval-requested",
      "flow://node-changed",
      "flow://progress",
      "flow://run-changed",
    ]);
    listeners.get("flow://run-changed")!({ payload: { runId: "r" } });
    expect(onRunChanged).toHaveBeenCalledWith({ runId: "r" });
    unlisten();
    expect(listeners.size).toBe(0);
  });
});

describe("run formatting", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("localizes reasons via reason.*, then issue.*, else the code", () => {
    const ft = i18n.getFixedT("en", "flow");
    expect(describeReason(ft, { code: "FLOW_NODE_FAILED", params: { node: "a", cause: "X" } })).toBe('Node "a" failed (X).');
    expect(describeReason(ft, { code: "FLOW_UNKNOWN_FIELD", params: { field: "x" } })).toBe('Unknown attribute "x".');
    expect(describeReason(ft, { code: "SOMETHING_NEW" })).toBe("SOMETHING_NEW");
  });

  it("describes errors with details and locations", () => {
    const ft = i18n.getFixedT("en", "flow");
    const described = describeError(ft, {
      code: "FLOW_FILE_INVALID",
      message: "m",
      details: [
        { code: "FLOW_UNKNOWN_FIELD", params: { field: "x", path: "nodes[0].x" } },
        { code: "FLOW_RUN_UNSUPPORTED", params: { feature: "agent", path: "nodes[1]" } },
      ],
    });
    expect(described.message).toBe("The flow has validation errors.");
    expect(described.details).toEqual(['Unknown attribute "x". (nodes[0].x)', "Not supported yet: agent (nodes[1])."]);
    expect(describeError(ft, { code: "WHO_KNOWS", message: "m" }).message).toBe("WHO_KNOWS");
  });

  it("formats money", () => {
    expect(formatUsd(0)).toBe("0.00");
    expect(formatUsd(1.5)).toBe("1.50");
    expect(formatUsd(0.0042)).toBe("0.0042");
    expect(formatUsd(Number.NaN)).toBe("0");
  });

  it("compares project roots loosely", () => {
    expect(sameRoot("C:\\Proj\\", "c:/proj")).toBe(true);
    expect(sameRoot("C:\\a", "C:\\b")).toBe(false);
  });
});

describe("run views", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    invoke.mockReset();
    listeners.clear();
    showConfirm.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("builds parameter values from defaults and the form", () => {
    const values = initialParamValues(flow);
    expect(values).toEqual({ dir: "", n: "3", flag: true });
    expect(paramsFromForm(flow, { ...values, dir: "in" })).toEqual({ dir: "in", n: 3, flag: true });
    expect(paramsFromForm(flow, { ...values, n: "" })).toEqual({ flag: true });
  });

  it("requires the command confirmation, then confirms and starts", async () => {
    const calls: string[] = [];
    route({
      flow_command_review: () => review,
      flow_confirm_commands: (a) => {
        calls.push(`confirm ${a.sha256}`);
      },
      flow_run_start: (a) => {
        calls.push(`start ${JSON.stringify(a.params)} ${a.sha256}`);
        return summary("r1");
      },
    });
    const onStarted = vi.fn();
    await act(async () =>
      root.render(<RunStartDialog projectRoot={ROOT} flowPath={PATH} flow={flow} onClose={() => {}} onStarted={onStarted} />),
    );
    await waitFor(() => expect(container.textContent).toContain('tool "${{ params.dir }}"'));
    expect(container.textContent).toContain("templated");
    expect(container.textContent).toContain("K=v");
    const start = button(container, "Start");
    expect(start.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "data");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((c) => !c.hasAttribute("data-switch"))!;
    await act(async () => confirm.click());
    expect(button(container, "Start").disabled).toBe(false);
    await act(async () => button(container, "Start").click());
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("r1"));
    expect(calls).toEqual(["confirm abc", 'start {"dir":"data","n":3,"flag":true} abc']);
  });

  it("shows start errors with details", async () => {
    route({
      flow_command_review: () => ({ ...review, confirmed: true }),
      flow_run_start: () => {
        throw { code: "FLOW_PARAMS_INVALID", message: "m", details: [{ code: "FLOW_PARAM_MISSING", params: { param: "dir" } }] };
      },
    });
    await act(async () =>
      root.render(<RunStartDialog projectRoot={ROOT} flowPath={PATH} flow={flow} onClose={() => {}} onStarted={() => {}} />),
    );
    await waitFor(() => expect(container.textContent).toContain("These commands were confirmed on this machine."));
    await act(async () => button(container, "Start").click());
    await waitFor(() => expect(container.textContent).toContain("Some parameters are invalid."));
    expect(container.textContent).toContain('Missing parameter "dir".');
  });

  it("lists this flow's runs and drives the selected run", async () => {
    const calls: string[] = [];
    let current = snapshot("r1");
    route({
      flow_run_list: () => [summary("r1", { status: "interrupted" }), { ...summary("r2"), flowPath: "other.flow.yaml" }],
      flow_run_get: () => current,
      flow_gitignore_status: () => ({ ignored: false }),
      flow_run_rerun_node: (a) => {
        calls.push(`rerun ${a.nodeKey}`);
      },
      flow_run_cancel: () => {
        calls.push("cancel");
      },
      flow_run_approve: (a) => {
        calls.push(`approve ${a.nodeKey} ${a.choice} ${a.comment}`);
      },
    });
    await act(async () => root.render(<RunPanel projectRoot={ROOT} flowPath={PATH} flow={flow} />));
    await waitFor(() => expect(container.querySelectorAll(".flow-runs__item").length).toBe(1));
    expect(container.textContent).toContain("Consider adding it to .gitignore");
    await act(async () => container.querySelector<HTMLButtonElement>(".flow-runs__item")!.click());
    await waitFor(() => expect(container.textContent).toContain("The app exited while this was running."));
    expect(container.textContent).toContain("Cost: $0.50");
    // Interrupted node: re-run; the run can be resumed or cancelled.
    await act(async () => button(container, "Re-run").click());
    await waitFor(() => expect(calls).toContain("rerun a"));
    button(container, "Resume");
    await act(async () => button(container, "Cancel run").click());
    await waitFor(() => expect(calls).toContain("cancel"));
    expect(showConfirm).toHaveBeenCalled();

    // A pending approval arrives (event-driven refresh).
    current = snapshot(
      "r1",
      {
        status: "awaiting_approval",
        nodes: {
          a: { status: "succeeded", attempt: 1, cost: { actual: 0, estimated: 0 }, costReported: false },
          ok: { status: "awaiting_approval", attempt: 1, cost: { actual: 0, estimated: 0 }, costReported: false },
        },
        approvals: [{ nodeKey: "ok", options: ["publish", "reject"], message: "Ship it?", show: { "nodes.a.outputs.doc": "d.md" }, reason: { code: "FLOW_APPROVAL_NODE" } }],
      },
      true,
    );
    await act(async () => {
      listeners.get("flow://approval-requested")!({ payload: { projectRoot: "c:/proj", runId: "r1", nodeKey: "ok", reason: { code: "FLOW_APPROVAL_NODE" } } });
    });
    await waitFor(() => expect(container.textContent).toContain("Ship it?"));
    expect(container.textContent).toContain("A run is waiting for approval.");
    expect(container.textContent).toContain("d.md");
    button(container, "Stop");
    const comment = container.querySelector<HTMLInputElement>(".flow-run__approval input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(comment, "lgtm");
      comment.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "publish").click());
    await waitFor(() => expect(calls).toContain("approve ok publish lgtm"));
  });

  it("localizes built-in approval options and budget approvals", async () => {
    route({
      flow_run_list: () => [summary("r1", { status: "awaiting_approval", pendingApprovals: 1 })],
      flow_run_get: () =>
        snapshot("r1", {
          status: "awaiting_approval",
          approvals: [{ options: ["approve", "stop"], reason: { code: "FLOW_BUDGET_EXCEEDED", params: { spentUsd: 1.5, limitUsd: 1 } } }],
        }),
      flow_gitignore_status: () => ({ ignored: true }),
    });
    await act(async () => root.render(<RunPanel projectRoot={ROOT} flowPath={PATH} flow={null} />));
    await waitFor(() => expect(container.querySelectorAll(".flow-runs__item").length).toBe(1));
    expect(button(container, "Run").disabled).toBe(true);
    expect(container.textContent).not.toContain(".gitignore");
    await act(async () => container.querySelector<HTMLButtonElement>(".flow-runs__item")!.click());
    await waitFor(() => expect(container.textContent).toContain("Budget exceeded"));
    expect(container.textContent).toContain("Spent $1.5 of the $1 budget.");
    button(container, "Approve");
    button(container, "Stop");
    await flush();
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import type { FlowDef } from "@/shared/types/flow";
import type { CommandReview, NodeState, RunSnapshot, RunSummary } from "@/shared/types/flow-run";

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: vi.fn((p: string, proto: string) => `${proto}://${p}`),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));
const showConfirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/stores/dialog-store", async (orig) => ({ ...(await orig<object>()), showConfirm }));

import { RunPanel, sameRoot } from "../RunPanel";
import { isLiveInstance, splitNodeKey, type RunState } from "@/shared/types/flow-run";
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
  commands: [
    { file: PATH, nodeId: "a", run: ["tool", "${{ params.dir }}"], shell: false, env: { K: "v" }, templated: true },
    { file: ".mdium/flows/child.flow.yaml", within: ["docs"], nodeId: "inner", run: ["x"], shell: false, env: {}, templated: false },
  ],
  runtimes: [],
  setup: [],
  stages: [],
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

function setNativeValue(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
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

  it("uses the detail wording of python reasons only when a detail is present", () => {
    const ft = i18n.getFixedT("en", "flow");
    expect(describeReason(ft, { code: "FLOW_PYTHON_INPUT_INVALID", params: { input: "n", reason: "type" } })).toBe(
      'Input "n" is invalid (type).',
    );
    expect(
      describeReason(ft, { code: "FLOW_PYTHON_INPUT_INVALID", params: { entry: "a.b", detail: "n: missing" } }),
    ).toBe('Stage "a.b" rejected its inputs: n: missing');
    expect(describeReason(ft, { code: "FLOW_PYTHON_ENTRY_UNKNOWN", params: { runtime: "r", entry: "a.b" } })).toBe(
      'Stage "a.b" is not provided by the runtime.',
    );
    expect(
      describeReason(ft, { code: "FLOW_PYTHON_PROTOCOL", params: { code: "WEIRD", detail: "odd" } }),
    ).toBe("The Python worker reported an error (WEIRD): odd");
    expect(describeReason(ft, { code: "FLOW_PYTHON_PROTOCOL", params: { detail: "" } })).toBe(
      "The Python worker sent an invalid message.",
    );
    expect(describeReason(ft, { code: "FLOW_RUNTIME_UNKNOWN", params: { runtime: "r" } })).toBe(
      'Runtime "r" is not declared in project.yaml.',
    );
    // Reasons without a `_detail` variant keep their wording.
    expect(describeReason(ft, { code: "FLOW_COMMAND_EXIT_CODE", params: { detail: "3" } })).toBe(
      "The command exited with code 3.",
    );
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
    // Commands of referenced files are listed with their file and enclosing loops.
    expect(container.textContent).toContain("docs / inner");
    expect(container.textContent).toContain(".mdium/flows/child.flow.yaml");
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

  it("requires confirmation for manifest runtimes even without commands", async () => {
    route({
      flow_command_review: () => ({
        ...review,
        commands: [],
        runtimes: [{ name: "r", python: [".venv/bin/python"], module: "m", cwd: "." }],
        setup: [],
        stages: [],
        confirmed: false,
      }),
    });
    await act(async () =>
      root.render(<RunStartDialog projectRoot={ROOT} flowPath={PATH} flow={flow} onClose={() => {}} onStarted={() => {}} />),
    );
    await waitFor(() => expect(container.textContent).toContain(i18n.t("run.runtimesTitle", { ns: "flow" })));
    expect(container.textContent).toContain(".venv/bin/python");
    expect(button(container, "Start").disabled).toBe(true);
    const confirm = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((c) => !c.hasAttribute("data-switch"))!;
    await act(async () => confirm.click());
    expect(button(container, "Start").disabled).toBe(false);
  });

  it("requires confirmation for python stages even without commands", async () => {
    route({
      flow_command_review: () => ({
        ...review,
        commands: [],
        runtimes: [],
        setup: [],
        stages: [{ file: PATH, nodeId: "r", runtime: "video_gen", entry: "video.render" }],
        confirmed: false,
      }),
    });
    await act(async () =>
      root.render(<RunStartDialog projectRoot={ROOT} flowPath={PATH} flow={flow} onClose={() => {}} onStarted={() => {}} />),
    );
    await waitFor(() => expect(container.textContent).toContain(i18n.t("run.stagesTitle", { ns: "flow" })));
    expect(container.textContent).toContain("video_gen");
    expect(button(container, "Start").disabled).toBe(true);
    const confirm = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((c) => !c.hasAttribute("data-switch"))!;
    await act(async () => confirm.click());
    expect(button(container, "Start").disabled).toBe(false);
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
    expect(container.textContent).toContain(i18n.t("run.gitignoreHint", { ns: "flow" }));
    await act(async () => container.querySelector<HTMLButtonElement>(".flow-runs__item")!.click());
    await waitFor(() => expect(container.textContent).toContain("Cost: $0.50"));
    // The node's reason is part of its detail, opened by selecting the row.
    await act(async () => container.querySelector<HTMLElement>('[role="treeitem"]')!.click());
    await waitFor(() => expect(container.textContent).toContain("The app exited while this was running."));
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
        approvals: [{ nodeKey: "ok", options: [{ name: "publish" }, { name: "reject" }], message: "Ship it?", show: { "nodes.a.outputs.doc": "d.md" }, reason: { code: "FLOW_APPROVAL_NODE" } }],
      },
      true,
    );
    await act(async () => {
      listeners.get("flow://approval-requested")!({ payload: { projectRoot: "c:/proj", runId: "r1", nodeKey: "ok", reason: { code: "FLOW_APPROVAL_NODE" } } });
    });
    await waitFor(() => expect(container.textContent).toContain("Review"));
    expect(container.textContent).toContain("A run is waiting for approval.");
    await act(async () => button(container, "Review").click());
    const dialog = document.querySelector(".flow-dialog") as HTMLElement;
    expect(dialog.textContent).toContain("Ship it?");
    expect(dialog.textContent).toContain("d.md");
    button(dialog, "Reject");
    const comment = dialog.querySelector("textarea")!;
    await act(async () => {
      setNativeValue(comment, "lgtm");
      comment.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(dialog, "publish").click());
    await waitFor(() => expect(calls).toContain("approve ok publish lgtm"));
  });
});

describe("node instance keys", () => {
  it("splits keys and finds live instances", () => {
    expect(splitNodeKey("a")).toEqual({ prefix: "", id: "a", pass: 1 });
    expect(splitNodeKey("docs[2]/check@3")).toEqual({ prefix: "docs[2]/", id: "check", pass: 3 });
    const state = {
      seq: 1,
      status: "failed",
      nodes: {},
      cost: { actual: 0, estimated: 0 },
      scopes: { "": { status: "running" }, "docs[0]/": { status: "failed" }, "docs@2[0]/": { status: "running" } },
      passes: { docs: 2, gen: 3 },
    } as RunState;
    expect(isLiveInstance(state, "docs")).toBe(false);
    expect(isLiveInstance(state, "docs@2")).toBe(true);
    expect(isLiveInstance(state, "gen@3")).toBe(true);
    expect(isLiveInstance(state, "docs[0]/proc")).toBe(false);
    expect(isLiveInstance(state, "docs@2[0]/proc")).toBe(true);
    expect(isLiveInstance(state, "other")).toBe(true);
  });
});

describe("run panel tree and artifacts", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    invoke.mockReset();
    listeners.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  /** Builds a node state with sensible defaults. */
  function node(status: NodeState["status"], extra: Partial<NodeState> = {}): NodeState {
    return { status, attempt: 1, cost: { actual: 0, estimated: 0 }, costReported: false, ...extra };
  }

  /** Mounts the run panel and opens run r1 (the routes must already be set). */
  async function renderPanel() {
    await act(async () => root.render(<RunPanel projectRoot={ROOT} flowPath={PATH} flow={flow} />));
    await waitFor(() => expect(container.querySelectorAll(".flow-runs__item").length).toBe(1));
    await act(async () => container.querySelector<HTMLButtonElement>(".flow-runs__item")!.click());
    await waitFor(() => expect(container.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0));
    return { container };
  }

  const clickFirstRow = () => act(async () => container.querySelector<HTMLElement>('[role="treeitem"]')!.click());

  it("renders the node tree with iteration rows and aggregates", async () => {
    const snap = snapshot("r1", {
      nodes: { docs: node("running"), "docs[0]/sum": node("succeeded"), "docs[1]/sum": node("running", { progress: { text: "half" } }) },
      scopes: { "": { status: "running" }, "docs[0]/": { status: "completed", owner: "docs", index: 0 }, "docs[1]/": { status: "running", owner: "docs", index: 1 } },
    });
    route({ flow_run_list: () => [summary("r1")], flow_run_get: () => snap, flow_gitignore_status: () => ({ ignored: true }) });
    await renderPanel();
    await waitFor(() => expect(container.querySelectorAll('[role="treeitem"]').length).toBeGreaterThanOrEqual(4));
    const items = [...container.querySelectorAll('[role="treeitem"]')];
    expect(items.map((i) => i.getAttribute("aria-level"))).toEqual(["1", "2", "2", "3"]);
    expect(items[0].textContent).toContain("2 running");
    expect(items[0].textContent).toContain("half");
    expect(items[1].textContent).toContain("Iteration 0");
    expect(items[1].getAttribute("aria-expanded")).toBe("false");
    expect(items[2].getAttribute("aria-expanded")).toBe("true");
  });

  it("shows outputs and artifacts of the selected node with an image preview", async () => {
    const snap = snapshot("r1", {
      nodes: { a: node("succeeded", { outputs: { n: 7 }, artifacts: [{ index: 0, path: "C:/p/a.png", label: "pic", mediaType: "image/png", bytes: 3, recordedAt: "t" }] }) },
    });
    route({
      flow_run_list: () => [summary("r1")],
      flow_run_get: () => snap,
      flow_gitignore_status: () => ({ ignored: true }),
      flow_artifact_path: (args) => {
        expect(args).toEqual({ projectRoot: ROOT, runId: "r1", nodeKey: "a", attempt: 1, index: 0 });
        return { path: "C:/p/a.png", mediaType: "image/png" };
      },
    });
    await renderPanel();
    await clickFirstRow();
    await waitFor(() => expect(container.querySelector(".flow-node-detail dl")).not.toBeNull());
    expect(container.querySelector(".flow-node-detail dl")!.textContent).toContain("7");
    await act(async () => button(container, "Artifacts").click());
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(container.querySelector("img")!.getAttribute("src")).toBe("asset://C:/p/a.png");
    expect(container.textContent).toContain("pic");
  });

  it("previews text artifacts with a truncation notice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("head", { status: 206, headers: { "Content-Range": "bytes 0-3/999999" } })));
    const snap = snapshot("r1", { nodes: { a: node("succeeded", { artifacts: [{ index: 0, path: "C:/p/log.txt", mediaType: "text/plain", recordedAt: "t" }] }) } });
    route({
      flow_run_list: () => [summary("r1")],
      flow_run_get: () => snap,
      flow_gitignore_status: () => ({ ignored: true }),
      flow_artifact_path: () => ({ path: "C:/p/log.txt", mediaType: "text/plain" }),
    });
    await renderPanel();
    await clickFirstRow();
    await act(async () => button(container, "Artifacts").click());
    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")!.textContent).toBe("head");
    expect(container.textContent).toContain("Showing the first 256 KiB.");
  });

  it("re-seeds the tree expansion when another run is selected", async () => {
    const hotState = {
      nodes: { docs: node("running"), "docs[1]/sum": node("running") },
      scopes: { "": { status: "running" as const }, "docs[1]/": { status: "running" as const, owner: "docs", index: 1 } },
    };
    route({
      flow_run_list: () => [summary("r1"), summary("r2")],
      flow_run_get: (args) => snapshot(args.runId as string, hotState),
      flow_gitignore_status: () => ({ ignored: true }),
    });
    await act(async () => root.render(<RunPanel projectRoot={ROOT} flowPath={PATH} flow={flow} />));
    await waitFor(() => expect(container.querySelectorAll(".flow-runs__item").length).toBe(2));
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".flow-runs__item")[0].click());
    await waitFor(() => expect(container.querySelectorAll('[role="treeitem"]').length).toBe(3));
    expect(container.querySelector('[role="treeitem"]')!.getAttribute("aria-expanded")).toBe("true");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="treeitem"] button')!.click());
    expect(container.querySelector('[role="treeitem"]')!.getAttribute("aria-expanded")).toBe("false");
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".flow-runs__item")[1].click());
    await waitFor(() => expect(container.querySelectorAll('[role="treeitem"]').length).toBe(3));
    expect(container.querySelector('[role="treeitem"]')!.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows an unavailable notice when the artifact url fails", async () => {
    const snap = snapshot("r1", { nodes: { a: node("succeeded", { artifacts: [{ index: 0, path: "C:/p/gone.png", mediaType: "image/png", recordedAt: "t" }] }) } });
    route({
      flow_run_list: () => [summary("r1")],
      flow_run_get: () => snap,
      flow_gitignore_status: () => ({ ignored: true }),
      flow_artifact_path: () => {
        throw { code: "FLOW_ARTIFACT_NOT_FOUND", message: "x" };
      },
    });
    await renderPanel();
    await clickFirstRow();
    await act(async () => button(container, "Artifacts").click());
    await waitFor(() => expect(container.textContent).toContain("Preview unavailable."));
  });

  it("opens the approval dialog from the awaiting row, previews artifacts and sends the comment", async () => {
    const request = {
      nodeKey: "review",
      options: [{ name: "accept" }, { name: "revise", commentRequired: true }],
      message: "Check it",
      show: {
        "nodes.a.outputs.n": 7,
        "nodes.a.artifacts.shot": { kind: "artifacts", nodeKey: "a", attempt: 1, artifacts: [{ index: 0, path: "C:/p/shot.png", label: "shot", mediaType: "image/png", recordedAt: "t" }] },
      },
      reason: { code: "FLOW_APPROVAL_NODE" },
    };
    const snap = snapshot("r1", { status: "awaiting_approval", approvals: [request], nodes: { a: node("succeeded"), review: node("awaiting_approval") } });
    const approve = vi.fn(async () => undefined);
    route({
      flow_run_list: () => [summary("r1")],
      flow_run_get: () => snap,
      flow_gitignore_status: () => ({ ignored: true }),
      flow_artifact_path: () => ({ path: "C:/p/shot.png", mediaType: "image/png" }),
      flow_run_approve: approve,
    });
    await renderPanel();
    const rows = [...container.querySelectorAll('[role="treeitem"]')];
    await act(async () => {
      (rows.find((r) => r.textContent!.includes("review")) as HTMLElement).click();
    });
    await waitFor(() => expect(document.querySelector(".flow-dialog")).not.toBeNull());
    const dialog = document.querySelector(".flow-dialog") as HTMLElement;
    expect(dialog.textContent).toContain("Check it");
    expect(dialog.textContent).toContain("7");
    await waitFor(() => expect(dialog.querySelector("img")).not.toBeNull());
    const revise = button(dialog, "revise");
    expect(revise.disabled).toBe(true);
    expect(revise.title).toBe("This option needs a comment.");
    const comment = dialog.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(comment, "fix the title");
      comment.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(revise.disabled).toBe(false);
    await act(async () => {
      revise.click();
    });
    expect(approve).toHaveBeenCalledWith({ projectRoot: ROOT, runId: "r1", nodeKey: "review", choice: "revise", comment: "fix the title" });
    await waitFor(() => expect(document.querySelector(".flow-dialog")).toBeNull());
  });

  it("disables a commentRequired option until a comment is typed and localizes built-in options", async () => {
    const request = { nodeKey: "review", options: [{ name: "approve" }, { name: "reject", commentRequired: true }], reason: { code: "FLOW_APPROVAL_NODE" } };
    const snap = snapshot("r1", { status: "awaiting_approval", approvals: [request], nodes: { review: node("awaiting_approval") } });
    route({ flow_run_list: () => [summary("r1")], flow_run_get: () => snap, flow_gitignore_status: () => ({ ignored: true }) });
    await renderPanel();
    await act(async () => {
      button(container, "Review").click();
    });
    await waitFor(() => expect(document.querySelector(".flow-dialog")).not.toBeNull());
    const dialog = document.querySelector(".flow-dialog") as HTMLElement;
    expect(button(dialog, "Approve")).toBeTruthy();
    expect(button(dialog, "Reject").disabled).toBe(true);
  });

  it("opens the budget approval from its review button", async () => {
    const request = { options: [{ name: "approve" }, { name: "stop" }], reason: { code: "FLOW_BUDGET_EXCEEDED" } };
    const snap = snapshot("r1", { status: "awaiting_approval", approvals: [request], nodes: {} });
    route({ flow_run_list: () => [summary("r1")], flow_run_get: () => snap, flow_gitignore_status: () => ({ ignored: true }) });
    // A budget approval has no node, so the tree is empty: select the run without waiting for rows.
    await act(async () => root.render(<RunPanel projectRoot={ROOT} flowPath={PATH} flow={flow} />));
    await waitFor(() => expect(container.querySelectorAll(".flow-runs__item").length).toBe(1));
    await act(async () => container.querySelector<HTMLButtonElement>(".flow-runs__item")!.click());
    await waitFor(() => expect(container.textContent).toContain("Review"));
    await act(async () => {
      button(container, "Review").click();
    });
    await waitFor(() => expect(document.querySelector(".flow-dialog")).not.toBeNull());
    expect(document.querySelector(".flow-dialog")!.textContent).toContain("Budget");
  });
});

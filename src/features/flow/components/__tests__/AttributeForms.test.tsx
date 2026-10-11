// @vitest-environment happy-dom
import { useState, type ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import type {
  FlowActionNode,
  FlowAgentNode,
  FlowApprovalNode,
  FlowBranchNode,
  FlowCommandNode,
  FlowCondition,
  FlowDef,
  FlowLoopNode,
  FlowNode,
  FlowPythonNode,
  FlowSubflowNode,
  FlowSummary,
  Manifest,
  ProjectLoadResult,
} from "@/shared/types/flow";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: vi.fn((p: string, proto: string) => `${proto}://${p}`),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { AttributePanel } from "../attrs/AttributePanel";
import { ConditionEditor } from "../attrs/ConditionEditor";
import { FlowAttrsForm } from "../attrs/FlowAttrsForm";
import { NodeCommonForm } from "../attrs/NodeCommonForm";
import { ActionForm } from "../attrs/kinds/ActionForm";
import { AgentForm } from "../attrs/kinds/AgentForm";
import { ApprovalForm } from "../attrs/kinds/ApprovalForm";
import { BranchForm } from "../attrs/kinds/BranchForm";
import { CommandForm } from "../attrs/kinds/CommandForm";
import { LoopForm } from "../attrs/kinds/LoopForm";
import { PythonForm } from "../attrs/kinds/PythonForm";
import { SubflowForm } from "../attrs/kinds/SubflowForm";
import type { KindFormProps } from "../attrs/kinds/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
}

/** Types into a text field and leaves it (React maps blur to `focusout`). */
async function typeAndBlur(el: HTMLElement, value: string) {
  await act(async () => {
    setNativeValue(el as HTMLInputElement, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

async function choose(el: HTMLElement, value: string) {
  await act(async () => {
    setNativeValue(el as HTMLSelectElement, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function all(label: string): HTMLElement[] {
  return [...container.querySelectorAll(`[aria-label="${label}"]`)] as HTMLElement[];
}

function one(label: string): HTMLElement {
  const found = all(label);
  if (found.length !== 1) throw new Error(`expected one "${label}", found ${found.length}`);
  return found[0];
}

function button(text: string, index = 0): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].filter((b) => b.textContent === text);
  if (!found[index]) throw new Error(`no button "${text}" (#${index}) in: ${container.textContent}`);
  return found[index];
}

const ROOT = "C:/proj";
const ENTRY = ".mdium/flows/main.flow.yaml";

const runNode: FlowNode = { id: "run", kind: "command", run: ["echo"], shell: false, protocol: "none", timeout: "30s" };

describe("NodeCommonForm", () => {
  it("writes name on blur, clears timeout to undefined, and validates the id", async () => {
    const onChange = vi.fn();
    const onRename = vi.fn();
    await act(async () => root.render(<NodeCommonForm node={runNode} path="nodes[0]" issues={[]} onChange={onChange} onRename={onRename} />));

    await typeAndBlur(one("Name"), "Run");
    expect(onChange).toHaveBeenCalledWith("nodes[0]", { name: "Run" });

    await typeAndBlur(one("Timeout"), "");
    const patch = onChange.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect("timeout" in patch).toBe(true);
    expect(patch.timeout).toBeUndefined();

    await typeAndBlur(one("ID"), "Bad-Id");
    expect(container.textContent).toContain(i18n.t("attrs.invalidId", { ns: "flow" }));
    expect(onRename).not.toHaveBeenCalled();

    await typeAndBlur(one("ID"), "run_1");
    expect(onRename).toHaveBeenCalledWith("nodes[0]", "run_1");
  });
});

describe("EdgeForm", () => {
  const def: FlowDef = {
    schemaVersion: 1,
    id: "f",
    name: "F",
    nodes: [{ id: "gate", kind: "approval" }, runNode],
    edges: [{ from: "gate", to: "run" }],
  };

  function mount(onEditEdge = vi.fn(), onDeleteEdge = vi.fn()) {
    return act(async () =>
      root.render(
        <AttributePanel
          def={def}
          selection={{ kind: "edge", path: "edges[0]" }}
          issues={[]}
          parts={[]}
          project={null}
          projectRoot={ROOT}
          currentFile={ENTRY}
          onEditNode={vi.fn()}
          onRenameNode={vi.fn()}
          onEditEdge={onEditEdge}
          onDeleteEdge={onDeleteEdge}
          onEditFlow={vi.fn()}
        />,
      ),
    );
  }

  it("offers the source ports and writes port and maxTraversals", async () => {
    const onEditEdge = vi.fn();
    await mount(onEditEdge);
    const options = [...one("Exit port").querySelectorAll("option")].map((o) => o.value);
    expect(options).toEqual(["approve", "reject", "failure"]);

    await choose(one("Exit port"), "reject");
    expect(onEditEdge).toHaveBeenCalledWith("edges[0]", { port: "reject" });

    await typeAndBlur(one("Max traversals"), "3");
    expect(onEditEdge).toHaveBeenCalledWith("edges[0]", { maxTraversals: 3 });
  });

  it("clears maxTraversals to undefined and deletes the edge", async () => {
    const edgeDef: FlowDef = { ...def, edges: [{ from: "gate", to: "run", maxTraversals: 3 }] };
    const onEditEdge = vi.fn();
    const onDeleteEdge = vi.fn();
    await act(async () =>
      root.render(
        <AttributePanel
          def={edgeDef}
          selection={{ kind: "edge", path: "edges[0]" }}
          issues={[]}
          parts={[]}
          project={null}
          projectRoot={ROOT}
          currentFile={ENTRY}
          onEditNode={vi.fn()}
          onRenameNode={vi.fn()}
          onEditEdge={onEditEdge}
          onDeleteEdge={onDeleteEdge}
          onEditFlow={vi.fn()}
        />,
      ),
    );
    await typeAndBlur(one("Max traversals"), "");
    const patch = onEditEdge.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect("maxTraversals" in patch).toBe(true);
    expect(patch.maxTraversals).toBeUndefined();

    await act(async () => button("Delete edge").click());
    expect(onDeleteEdge).toHaveBeenCalledWith("edges[0]");
  });
});

describe("FlowAttrsForm", () => {
  const base: FlowDef = { schemaVersion: 1, id: "f", name: "F", nodes: [] };

  it("adds a param row", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<FlowAttrsForm def={base} onChange={onChange} />));
    await typeAndBlur(all("New key")[0], "x");
    await act(async () => button("Add", 0).click());
    expect(onChange).toHaveBeenCalledWith({ params: { x: { type: "string", required: false } } });
  });

  it("refuses a duplicate param key", async () => {
    const onChange = vi.fn();
    const def: FlowDef = { ...base, params: { x: { type: "string" } } };
    await act(async () => root.render(<FlowAttrsForm def={def} onChange={onChange} />));
    await typeAndBlur(all("New key")[0], "x");
    await act(async () => button("Add", 0).click());
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain(i18n.t("attrs.duplicateKey", { ns: "flow" }));
  });

  it("writes limits.budgetUsd", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<FlowAttrsForm def={base} onChange={onChange} />));
    await typeAndBlur(one("Budget (USD)"), "5");
    expect(onChange).toHaveBeenCalledWith({ limits: { budgetUsd: 5 } });
  });
});

describe("ConditionEditor", () => {
  it("builds a nested condition and hides the value for exists", async () => {
    const seen: FlowCondition[] = [];
    function Harness() {
      const [value, setValue] = useState<FlowCondition>({ all: [] });
      seen.push(value);
      return <ConditionEditor value={value} onChange={setValue} />;
    }
    await act(async () => root.render(<Harness />));

    await act(async () => button("Add comparison").click());
    await typeAndBlur(all("Reference")[0], "params.x");
    await choose(all("Operator")[0], ">=");
    await typeAndBlur(all("Value")[0], "7");

    await act(async () => button("Add group").click());
    // The new group is the third "Condition type" select (root, comparison, group).
    await choose(all("Condition type")[2], "not");
    await typeAndBlur(all("Reference")[1], "nodes.a.outputs.ok");
    await choose(all("Operator")[1], "exists");

    expect(seen.at(-1)).toEqual({
      all: [
        { ref: "params.x", op: ">=", value: 7 },
        { not: { ref: "nodes.a.outputs.ok", op: "exists" } },
      ],
    });
    expect(all("Value")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Kind forms
// ---------------------------------------------------------------------------

type Patch = Record<string, unknown>;

/** Applies a patch the way `updateNode` does: `undefined` deletes the key. */
function applyPatch<N extends FlowNode>(node: N, patch: Patch): N {
  const merged: Record<string, unknown> = { ...node, ...patch };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as N;
}

const flowPart: FlowSummary = {
  path: ".mdium/flows/lib/p.flow.yaml",
  kind: "part",
  id: "p",
  name: "P",
  params: { doc: { type: "path", required: true } },
  outputs: ["summary"],
  errorCount: 0,
  warningCount: 0,
};

const pythonProject: ProjectLoadResult = {
  exists: true,
  path: ".mdium/project.yaml",
  sha256: "abc",
  project: {
    schemaVersion: 1,
    runtimes: { demo: { kind: "python", python: "python", module: "demo", cwd: "." } },
  } as unknown as ProjectLoadResult["project"],
  errors: [],
  warnings: [],
};

const manifest: Manifest = {
  module: "demo",
  stages: [
    {
      name: "demo.add",
      inputs: { a: { type: "number", required: true }, b: { type: "number", required: false, default: 1 } },
      outputs: {},
      artifacts: [],
    },
  ],
};

async function waitFor(check: () => void, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
  }
}

/** Mounts a kind form over a stateful node and records every patch it writes. */
async function mountKind<N extends FlowNode>(
  Form: ComponentType<KindFormProps<N>>,
  initial: N,
  extra: { parts?: FlowSummary[]; project?: ProjectLoadResult | null } = {},
): Promise<Patch[]> {
  const patches: Patch[] = [];
  function Harness() {
    const [node, setNode] = useState(initial);
    return (
      <Form
        node={node}
        path="nodes[0]"
        parts={extra.parts ?? []}
        project={extra.project ?? null}
        currentFile={ENTRY}
        onChange={(_path, patch) => {
          patches.push(patch as Patch);
          setNode((n) => applyPatch(n, patch as Patch));
        }}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  return patches;
}

/** Clicks the checkbox / radio inside the label with this text. */
async function toggle(text: string, index = 0) {
  const labels = [...container.querySelectorAll("label")].filter((l) => l.textContent === text);
  if (!labels[index]) throw new Error(`no label "${text}" (#${index})`);
  await act(async () => (labels[index].querySelector("input") as HTMLInputElement).click());
}

describe("CommandForm", () => {
  it("writes argv per line, converts to a shell string and back", async () => {
    const node: FlowCommandNode = { id: "c", kind: "command", run: [""], shell: false, protocol: "mdium-v1" };
    const patches = await mountKind(CommandForm, node);

    await typeAndBlur(one("Command (one argument per line)"), "python\nx.py");
    expect(patches.at(-1)).toEqual({ run: ["python", "x.py"] });

    await toggle("Run through a shell");
    expect(patches.at(-1)).toEqual({ shell: true, run: "python x.py" });
    await typeAndBlur(one("Shell command"), "python x.py --fast");
    expect(patches.at(-1)).toEqual({ run: "python x.py --fast" });

    await toggle("Run through a shell");
    expect(patches.at(-1)).toEqual({ shell: false, run: ["python x.py --fast"] });

    await typeAndBlur(one("Success exit codes (comma-separated)"), "0, 2");
    expect(patches.at(-1)).toEqual({ successCodes: [0, 2] });

    await choose(one("Protocol"), "none");
    expect(patches.at(-1)).toEqual({ protocol: "none" });

    await toggle("Detach (do not wait for exit)");
    expect(patches.at(-1)).toEqual({ detach: true });

    await typeAndBlur(all("New key")[0], "FOO");
    await act(async () => button("Add").click());
    expect(patches.at(-1)).toEqual({ env: { FOO: "" } });
  });
});

describe("ApprovalForm", () => {
  it("serializes options: plain strings unless a comment is required", async () => {
    const node: FlowApprovalNode = { id: "gate", kind: "approval" };
    const patches = await mountKind(ApprovalForm, node);

    await typeAndBlur(all("Option name").at(-1)!, "ok");
    await act(async () => button("Add", 1).click());
    expect(patches.at(-1)).toEqual({ options: ["ok"] });

    await typeAndBlur(all("Option name").at(-1)!, "fix");
    await act(async () => button("Add", 1).click());
    expect(patches.at(-1)).toEqual({ options: ["ok", "fix"] });

    await toggle("Comment required", 1);
    expect(patches.at(-1)).toEqual({ options: ["ok", { name: "fix", commentRequired: true }] });

    await toggle("Comment required", 1);
    expect(patches.at(-1)).toEqual({ options: ["ok", "fix"] });
    await toggle("Comment required", 1);

    await typeAndBlur(one("Message"), "Please review");
    expect(patches.at(-1)).toEqual({ message: "Please review" });
  });
});

describe("BranchForm", () => {
  it("adds a case with a condition and a port, and sets the default port", async () => {
    const node: FlowBranchNode = { id: "b", kind: "branch", cases: [] };
    const patches = await mountKind(BranchForm, node);

    await act(async () => button("Add case").click());
    await typeAndBlur(one("Reference"), "params.p");
    await choose(one("Operator"), "exists");
    await typeAndBlur(one("Case exit port"), "yes");
    expect(patches.at(-1)).toEqual({ cases: [{ when: { ref: "params.p", op: "exists" }, port: "yes" }] });

    await typeAndBlur(one("Default exit port"), "no");
    expect(patches.at(-1)).toEqual({ default: "no" });
  });
});

describe("LoopForm", () => {
  const loop: FlowLoopNode = { id: "l", kind: "loop", mode: "foreach", items: "${{ params.items }}", maxIterations: 10, body: "" };

  it("chooses a part body, fills params from its signature and edits the other fields", async () => {
    const patches = await mountKind(LoopForm, loop, { parts: [flowPart] });

    await choose(one("Body"), "lib/p.flow.yaml");
    expect(patches.at(-1)).toEqual({ body: "lib/p.flow.yaml", params: { doc: "" } });
    expect(container.textContent).toContain("doc");

    await typeAndBlur(one("doc *"), "a.md");
    expect(patches.at(-1)).toEqual({ params: { doc: "a.md" } });

    await typeAndBlur(one("Items"), '["a","b"]');
    expect(patches.at(-1)).toEqual({ items: ["a", "b"] });
    await typeAndBlur(one("Max iterations"), "3");
    expect(patches.at(-1)).toEqual({ maxIterations: 3 });
    await typeAndBlur(one("Parallelism"), "2");
    expect(patches.at(-1)).toEqual({ parallelism: 2 });
    await typeAndBlur(one("Item variable"), "doc");
    expect(patches.at(-1)).toEqual({ as: "doc" });
    await choose(one("On item failure"), "continue");
    expect(patches.at(-1)).toEqual({ onItemFailure: "continue" });

    expect(all("Stop when")).toHaveLength(0);
    await choose(one("Mode"), "while");
    expect(patches.at(-1)).toEqual({ mode: "while" });
    await toggle("Enable");
    expect(patches.at(-1)).toEqual({ until: { ref: "", op: "==" } });
  });

  it("shows only a hint for an inline body", async () => {
    const inline: FlowLoopNode = { ...loop, body: { nodes: [{ id: "x", kind: "approval" }] } };
    await mountKind(LoopForm, inline, { parts: [flowPart] });
    expect(container.textContent).toContain(i18n.t("attrs.inlineBodyHint", { ns: "flow" }));
    expect(all("Body")).toHaveLength(0);
  });
});

describe("SubflowForm", () => {
  it("chooses a part and writes its params", async () => {
    const node: FlowSubflowNode = { id: "s", kind: "subflow", flow: "" };
    const patches = await mountKind(SubflowForm, node, { parts: [flowPart] });

    await choose(one("Sub-flow"), "lib/p.flow.yaml");
    expect(patches.at(-1)).toEqual({ flow: "lib/p.flow.yaml", params: { doc: "" } });

    await typeAndBlur(one("doc *"), "x.md");
    expect(patches.at(-1)).toEqual({ params: { doc: "x.md" } });
  });
});

describe("AgentForm", () => {
  it("switches the prompt to a file reference and clears the inline prompt", async () => {
    const node: FlowAgentNode = { id: "a", kind: "agent", provider: "claude", permission: "read-only", outputContract: "outcome", prompt: "hi" };
    const patches = await mountKind(AgentForm, node);

    await toggle("Prompt file");
    await typeAndBlur(one("Prompt file path"), "prompts/a.md");
    expect(patches.at(-1)).toStrictEqual({ promptRef: "prompts/a.md", prompt: undefined });

    await choose(one("Provider"), "codex");
    expect(patches.at(-1)).toEqual({ provider: "codex" });
    await choose(one("Permission"), "full-access");
    expect(patches.at(-1)).toEqual({ permission: "full-access" });
    await choose(one("Output contract"), "free");
    expect(patches.at(-1)).toEqual({ outputContract: "free" });
    await typeAndBlur(one("Model"), "opus");
    expect(patches.at(-1)).toEqual({ model: "opus" });
  });
});

function PythonWithRoot(props: KindFormProps<FlowPythonNode>) {
  return <PythonForm {...props} projectRoot={ROOT} />;
}

describe("PythonForm", () => {
  it("lists the stages of the runtime and generates the with rows from the input schema", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "flow_runtime_describe") return manifest;
      throw { code: "FLOW_COMMAND_FAILED", message: `unexpected ${command}` };
    });
    const node: FlowPythonNode = { id: "p", kind: "python", runtime: "demo", entry: "" };
    const patches = await mountKind(PythonWithRoot, node, { project: pythonProject });

    await waitFor(() => {
      const options = [...one("Stage").querySelectorAll("option")].map((o) => o.value);
      expect(options).toContain("demo.add");
    });
    expect(invoke).toHaveBeenCalledWith("flow_runtime_describe", { projectRoot: ROOT, runtime: "demo", sha256: "abc" });

    await choose(one("Stage"), "demo.add");
    expect(patches.at(-1)).toEqual({ entry: "demo.add", with: { a: "", b: 1 } });

    // Required marker on `a`, the default value on `b`.
    expect(one("a *")).toBeTruthy();
    expect((one("b") as HTMLInputElement).value).toBe("1");

    await typeAndBlur(one("a *"), "5");
    expect(patches.at(-1)).toEqual({ with: { a: 5, b: 1 } });
  });

  it("shows keys outside the schema as removable rows", async () => {
    invoke.mockImplementation(async () => manifest);
    const node: FlowPythonNode = { id: "p", kind: "python", runtime: "demo", entry: "demo.add", with: { a: 1, b: 2, zz: "old" } };
    const patches = await mountKind(PythonWithRoot, node, { project: pythonProject });
    await waitFor(() => expect(all("a *")).toHaveLength(1));

    expect(container.textContent).toContain("zz");
    const removeButtons = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Remove");
    expect(removeButtons).toHaveLength(1);
    await act(async () => removeButtons[0].click());
    expect(patches.at(-1)).toEqual({ with: { a: 1, b: 2 } });
  });
});
describe("ActionForm", () => {
  it("chooses a built-in action and edits with rows", async () => {
    const node: FlowActionNode = { id: "act", kind: "action", uses: "mdium/flow-run-latest" };
    const patches = await mountKind(ActionForm, node);

    await choose(one("Action"), "mdium/metrics-compare");
    expect(patches.at(-1)).toEqual({ uses: "mdium/metrics-compare" });

    await typeAndBlur(all("New key")[0], "base");
    await act(async () => button("Add").click());
    expect(patches.at(-1)).toEqual({ with: { base: "" } });
  });
});
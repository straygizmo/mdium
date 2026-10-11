// @vitest-environment happy-dom
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import type { FlowCondition, FlowDef, FlowNode } from "@/shared/types/flow";
import { AttributePanel } from "../attrs/AttributePanel";
import { ConditionEditor } from "../attrs/ConditionEditor";
import { FlowAttrsForm } from "../attrs/FlowAttrsForm";
import { NodeCommonForm } from "../attrs/NodeCommonForm";

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

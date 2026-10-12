// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import type { FlowDef } from "@/shared/types/flow";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((p: string, proto: string) => `${proto}://${p}`),
}));

import { docDigest } from "../../lib/__tests__/doc-digest";
import { buildFlowGraph } from "../../lib/flow-graph";
import type { FlowLayout } from "../../lib/flow-layout";
import {
  FlowCanvas,
  applyGeometryChanges,
  handleEdgeClick,
  handleNodeDragStop,
  makeIsValidConnection,
  toConnectRequest,
  toReactFlow,
} from "../FlowCanvas";
import { PortPopover } from "../PortPopover";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // React Flow measures its viewport; happy-dom has no layout engine.
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

/** Places every graph node on a simple grid (no ELK needed). */
function gridLayout(nodeIds: string[]): FlowLayout {
  const layout: FlowLayout = {};
  nodeIds.forEach((id, i) => {
    layout[id] = { x: i * 300, y: 0, width: 220, height: 88 };
  });
  return layout;
}

describe("editor views", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function mountCanvas(props: Partial<React.ComponentProps<typeof FlowCanvas>> = {}) {
    const graph = buildFlowGraph(docDigest(), new Set());
    const layout = gridLayout(graph.nodes.map((n) => n.id));
    const handlers = {
      onSelect: vi.fn(),
      onToggle: vi.fn(),
      onMoveNode: vi.fn(),
      onConnect: vi.fn(),
      onDeleteSelection: vi.fn(),
    };
    await act(async () => {
      root.render(
        <FlowCanvas graph={graph} layout={layout} selection={null} editable {...handlers} {...props} />,
      );
    });
    return handlers;
  }

  it("renders draggable, connectable nodes when editable", async () => {
    await mountCanvas();
    const nodes = container.querySelectorAll(".react-flow__node");
    expect(nodes.length).toBeGreaterThan(0);
    // Children of a loop group stay inside it, so only top-level nodes are draggable.
    const topLevel = Array.from(nodes).filter((n) => !n.getAttribute("data-id")!.includes(".body."));
    expect(topLevel.length).toBeGreaterThan(0);
    topLevel.forEach((n) => expect(n.classList.contains("draggable")).toBe(true));
    Array.from(nodes)
      .filter((n) => n.getAttribute("data-id")!.includes(".body."))
      .forEach((n) => expect(n.classList.contains("draggable")).toBe(false));
    const out = container.querySelector('.react-flow__handle[data-handleid="out"]');
    const input = container.querySelector('.react-flow__handle[data-handleid="in"]');
    expect(out).not.toBeNull();
    expect(input).not.toBeNull();
    expect(out!.classList.contains("connectable")).toBe(true);
    expect(out!.classList.contains("connectablestart")).toBe(true);
  });

  it("selects an edge on click", () => {
    // Edges only render once React Flow has measured handles, which happy-dom cannot do:
    // exercise the exported click handler and the edge props instead.
    const onSelect = vi.fn();
    handleEdgeClick(onSelect)({} as never, { id: "edges[0]" } as never);
    expect(onSelect).toHaveBeenCalledWith({ kind: "edge", path: "edges[0]" });

    const graph = buildFlowGraph(docDigest(), new Set());
    const { edges } = toReactFlow(
      graph,
      gridLayout(graph.nodes.map((n) => n.id)),
      { kind: "edge", path: "edges[0]" },
      vi.fn(),
      true,
    );
    const picked = edges.find((e) => e.id === "edges[0]")!;
    expect(picked.selected).toBe(true);
    expect(picked.className).toContain("flow-edge--selected");
    expect(edges.filter((e) => e.selected)).toHaveLength(1);
  });

  it("ignores Delete when nothing is selected", async () => {
    const h = await mountCanvas();
    const wrapper = container.querySelector(".flow-canvas-wrapper") as HTMLElement;
    expect(wrapper).not.toBeNull();
    await act(async () => {
      wrapper.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(h.onDeleteSelection).not.toHaveBeenCalled();
  });

  it("ignores Delete typed into an input inside the wrapper", async () => {
    const h = await mountCanvas({ selection: { kind: "node", path: "nodes[0]" } });
    const wrapper = container.querySelector(".flow-canvas-wrapper") as HTMLElement;
    const input = document.createElement("input");
    wrapper.appendChild(input);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(h.onDeleteSelection).not.toHaveBeenCalled();
  });

  it("validates connections: same scope only, never a self-edge", () => {
    const valid = makeIsValidConnection(
      new Map<string, string | undefined>([
        ["a", undefined],
        ["b", undefined],
        ["c", "loop"],
        ["d", "loop"],
      ]),
    );
    const conn = (source: string, target: string) => ({ source, target, sourceHandle: "out", targetHandle: "in" });
    expect(valid(conn("a", "b"))).toBe(true);
    expect(valid(conn("c", "d"))).toBe(true);
    expect(valid(conn("a", "a"))).toBe(false);
    expect(valid(conn("a", "c"))).toBe(false);
  });

  it("flags connections that use a back handle", () => {
    const req = (sourceHandle: string, targetHandle: string) =>
      toConnectRequest({ source: "nodes[0]", target: "nodes[1]", sourceHandle, targetHandle });
    expect(req("out", "in").fromBackHandle).toBe(false);
    expect(req("back-out", "in").fromBackHandle).toBe(true);
    expect(req("out", "back-in").fromBackHandle).toBe(true);
    expect(req("out", "in")).toMatchObject({ sourcePath: "nodes[0]", targetPath: "nodes[1]" });
  });

  it("reports Delete for a selected edge", async () => {
    const h = await mountCanvas({ selection: { kind: "edge", path: "edges[0]" } });
    const wrapper = container.querySelector(".flow-canvas-wrapper") as HTMLElement;
    await act(async () => {
      wrapper.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(h.onDeleteSelection).toHaveBeenCalledTimes(1);
  });

  it("calls onDeleteSelection for a selected node on Backspace", async () => {
    const h = await mountCanvas({ selection: { kind: "node", path: "nodes[0]" } });
    const wrapper = container.querySelector(".flow-canvas-wrapper") as HTMLElement;
    await act(async () => {
      wrapper.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    expect(h.onDeleteSelection).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".flow-node--selected")).not.toBeNull();
  });

  it("keeps nodes non-draggable when read-only", async () => {
    await mountCanvas({ editable: false });
    const nodes = container.querySelectorAll(".react-flow__node");
    expect(nodes.length).toBeGreaterThan(0);
    nodes.forEach((n) => expect(n.classList.contains("draggable")).toBe(false));
  });

  it("reports node moves with the dropped position", () => {
    const onMoveNode = vi.fn();
    const handler = handleNodeDragStop(onMoveNode);
    const node = { id: "nodes[0]", data: { node: { nodeId: "collect" } }, position: { x: 3, y: 4 } };
    handler({} as never, node as never, [] as never);
    expect(onMoveNode).toHaveBeenCalledWith("collect", { x: 3, y: 4 });
  });

  it("applies live drag positions locally and ignores selection changes", () => {
    const graph = buildFlowGraph(docDigest(), new Set());
    const { nodes } = toReactFlow(graph, gridLayout(graph.nodes.map((n) => n.id)), null, vi.fn(), true);
    const moved = applyGeometryChanges([{ type: "position", id: nodes[0].id, position: { x: 50, y: 60 }, dragging: true }], nodes);
    expect(moved[0].position).toEqual({ x: 50, y: 60 });
    expect(moved[1]).toBe(nodes[1]);
    // Selection stays controlled by the editor store.
    expect(applyGeometryChanges([{ type: "select", id: nodes[0].id, selected: true }], nodes)).toBe(nodes);
    expect(applyGeometryChanges([{ type: "remove", id: nodes[0].id }], nodes)).toBe(nodes);
  });

  it("resets the local node copy when the layout changes", async () => {
    const graph = buildFlowGraph(docDigest(), new Set());
    const ids = graph.nodes.map((n) => n.id);
    const props = { graph, selection: null, editable: true, onSelect: vi.fn(), onToggle: vi.fn(), onMoveNode: vi.fn(), onConnect: vi.fn(), onDeleteSelection: vi.fn() };
    await act(async () => root.render(<FlowCanvas {...props} layout={gridLayout(ids)} />));
    const first = () => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${ids[0]}"]`)!;
    expect(first().style.transform.replace(/\s/g, "")).toContain("translate(0px,0px)");
    const shifted = gridLayout(ids);
    shifted[ids[0]] = { ...shifted[ids[0]], x: 40, y: 70 };
    await act(async () => root.render(<FlowCanvas {...props} layout={shifted} />));
    expect(first().style.transform.replace(/\s/g, "")).toContain("translate(40px,70px)");
  });

  it("PortPopover lists ports with success first and confirms with Enter", async () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    await act(async () => {
      root.render(
        <PortPopover
          ports={["success", "failure", "attention"]}
          anchor={{ x: 10, y: 20 }}
          onChoose={onChoose}
          onCancel={onCancel}
        />,
      );
    });
    const options = container.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(3);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    const list = container.querySelector('[role="listbox"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith("success");
    await act(async () => {
      (options[2] as HTMLElement).click();
    });
    expect(onChoose).toHaveBeenLastCalledWith("attention");
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("reports a double-click on a node with a signature as a drill request", async () => {
    const def = {
      schemaVersion: 1,
      id: "f",
      nodes: [
        { id: "call", kind: "subflow", flow: "parts/p.flow.yaml" },
        { id: "plain", kind: "approval" },
      ],
      edges: [],
    } as unknown as FlowDef;
    const graph = buildFlowGraph(def, new Set(), { errors: [], warnings: [] }, {}, "main.flow.yaml");
    const onDrill = vi.fn();
    await act(async () => {
      root.render(
        <FlowCanvas
          graph={graph}
          layout={gridLayout(graph.nodes.map((n) => n.id))}
          selection={null}
          editable
          onSelect={vi.fn()}
          onToggle={vi.fn()}
          onMoveNode={vi.fn()}
          onConnect={vi.fn()}
          onDeleteSelection={vi.fn()}
          onDrill={onDrill}
        />,
      );
    });
    const dbl = async (id: string) =>
      act(async () => {
        container
          .querySelector(`.react-flow__node[data-id="${id}"]`)!
          .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
    await dbl("nodes[1]");
    expect(onDrill).not.toHaveBeenCalled();
    await dbl("nodes[0]");
    expect(onDrill).toHaveBeenCalledWith("nodes[0]");
  });
});

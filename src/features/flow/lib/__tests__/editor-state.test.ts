import { describe, expect, it } from "vitest";
import type { FlowDef } from "@/shared/types/flow";
import {
  EDGE_PATH,
  addEdge,
  addNode,
  defaultsFor,
  edgeAt,
  edgePathOf,
  emptyFlow,
  moveNode,
  nodeAt,
  removeEdge,
  removeNode,
  renameNode,
  scopeOf,
  updateEdge,
  updateFlowAttrs,
  updateNode,
} from "../editor-state";

const base = (): FlowDef => ({
  schemaVersion: 1, id: "f", name: "F",
  nodes: [
    { id: "a", kind: "command", run: ["x"], shell: false, protocol: "none" },
    { id: "b", kind: "approval" },
    { id: "l", kind: "loop", mode: "foreach", items: "${{ params.items }}", maxIterations: 3, body: { nodes: [{ id: "i1", kind: "approval" }, { id: "i2", kind: "approval" }], edges: [{ from: "i1", to: "i2" }] } },
  ],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "a", port: "reject", maxTraversals: 2 }],
  outputs: { r: "${{ nodes.a.outputs.r }}" },
  ui: { positions: { a: { x: 1, y: 2 } } },
});

describe("editor-state", () => {
  it("addNode appends with a position and never mutates", () => {
    const d = base();
    const n = addNode(d, { id: "c", ...defaultsFor("approval") }, { x: 5, y: 6 });
    expect(d.nodes).toHaveLength(3);
    expect(n.nodes.map((x) => x.id)).toEqual(["a", "b", "l", "c"]);
    expect((n.ui as { positions: Record<string, unknown> }).positions.c).toEqual({ x: 5, y: 6 });
  });
  it("removeNode drops its edges and keeps references for validation to flag", () => {
    const n = removeNode(base(), "nodes[0]");
    expect(n.nodes.map((x) => x.id)).toEqual(["b", "l"]);
    expect(n.edges).toEqual([]);
    expect(n.outputs).toEqual({ r: "${{ nodes.a.outputs.r }}" });
    expect((n.ui as { positions: Record<string, unknown> }).positions.a).toBeUndefined();
  });
  it("removes a node inside an inline body together with its scope's edges", () => {
    const n = removeNode(base(), "nodes[2].body.nodes[0]");
    const loop = n.nodes[2] as { body: { nodes: { id: string }[]; edges?: unknown[] } };
    expect(loop.body.nodes.map((x) => x.id)).toEqual(["i2"]);
    expect(loop.body.edges ?? []).toEqual([]);
  });
  it("moveNode writes ui.positions for top-level nodes", () => {
    const n = moveNode(base(), "b", { x: 7, y: 8 });
    expect((n.ui as { positions: Record<string, unknown> }).positions).toEqual({ a: { x: 1, y: 2 }, b: { x: 7, y: 8 } });
  });
  it("addEdge appends to the right scope and ignores duplicates", () => {
    let n = addEdge(base(), "", { from: "a", to: "b", port: "failure" });
    expect(n.edges).toHaveLength(3);
    n = addEdge(n, "", { from: "a", to: "b", port: "failure" });
    expect(n.edges).toHaveLength(3);
    n = addEdge(n, "nodes[2]", { from: "i2", to: "i1", maxTraversals: 1 });
    expect((n.nodes[2] as { body: { edges: unknown[] } }).body.edges).toHaveLength(2);
  });
  it("updateEdge normalizes defaults and removeEdge removes by path", () => {
    let n = updateEdge(base(), "edges[1]", { port: "success", maxTraversals: undefined });
    expect(n.edges![1]).toEqual({ from: "b", to: "a" });
    n = updateEdge(n, "edges[0]", { maxTraversals: 4 });
    expect(n.edges![0]).toEqual({ from: "a", to: "b", maxTraversals: 4 });
    n = removeEdge(n, "nodes[2].body.edges[0]");
    expect((n.nodes[2] as { body: { edges?: unknown[] } }).body.edges ?? []).toEqual([]);
  });
  it("updateNode merges, deletes undefined keys and swaps kinds minimally", () => {
    let n = updateNode(base(), "nodes[0]", { name: "Run", timeout: "1m" });
    expect(nodeAt(n, "nodes[0]")).toMatchObject({ id: "a", name: "Run", timeout: "1m", run: ["x"] });
    n = updateNode(n, "nodes[0]", { timeout: undefined });
    expect("timeout" in nodeAt(n, "nodes[0]")!).toBe(false);
    n = updateNode(n, "nodes[0]", { kind: "approval" } as never);
    expect(nodeAt(n, "nodes[0]")).toEqual({ id: "a", kind: "approval", name: "Run" });
  });
  it("renameNode rewrites edges and positions", () => {
    const n = renameNode(base(), "nodes[0]", "start");
    expect(n.edges).toEqual([{ from: "start", to: "b" }, { from: "b", to: "start", port: "reject", maxTraversals: 2 }]);
    expect((n.ui as { positions: Record<string, unknown> }).positions).toEqual({ start: { x: 1, y: 2 } });
  });
  it("renameNode refuses an id used anywhere in the flow", () => {
    const d = base();
    expect(renameNode(d, "nodes[0]", "b")).toBe(d);
    // Ids inside an inline body count too, both ways.
    expect(renameNode(d, "nodes[0]", "i1")).toBe(d);
    expect(renameNode(d, "nodes[2].body.nodes[0]", "a")).toBe(d);
  });
  it("renames a node inside an inline body within its scope only", () => {
    const n = renameNode(base(), "nodes[2].body.nodes[0]", "first");
    const loop = n.nodes[2] as { body: { nodes: { id: string }[]; edges: unknown[] } };
    expect(loop.body.nodes.map((x) => x.id)).toEqual(["first", "i2"]);
    expect(loop.body.edges).toEqual([{ from: "first", to: "i2" }]);
    expect(n.edges).toEqual(base().edges);
    expect((n.ui as { positions: Record<string, unknown> }).positions).toEqual({ a: { x: 1, y: 2 } });
  });
  it("addEdge treats an omitted port and success as the same edge", () => {
    const d: FlowDef = { ...base(), edges: [{ from: "a", to: "b", port: "success" }] };
    expect(addEdge(d, "", { from: "a", to: "b" }).edges).toHaveLength(1);
    expect(addEdge(base(), "", { from: "a", to: "b", port: "success" }).edges).toHaveLength(2);
  });
  it("finds edges by path and paths by edge", () => {
    const d = base();
    expect(scopeOf("nodes[2].body.nodes[1]")).toBe("nodes[2]");
    expect(scopeOf("nodes[0]")).toBe("");
    expect(edgePathOf(d, "", { from: "b", to: "a", port: "reject" })).toBe("edges[1]");
    expect(edgePathOf(d, "nodes[2]", { from: "i1", to: "i2", port: "success" })).toBe("nodes[2].body.edges[0]");
    expect(edgePathOf(d, "", { from: "b", to: "a" })).toBeNull();
    expect(edgeAt(d, "nodes[2].body.edges[0]")).toEqual({ edge: { from: "i1", to: "i2" }, scope: (d.nodes[2] as { body: { nodes: unknown[] } }).body.nodes });
    expect(edgeAt(d, "edges[1]")?.edge).toEqual({ from: "b", to: "a", port: "reject", maxTraversals: 2 });
    expect(edgeAt(d, "edges[9]")).toBeNull();
    expect(EDGE_PATH.exec("nodes[2].body.edges[3]")?.slice(1)).toEqual(["nodes[2]", "3"]);
  });
  it("updateFlowAttrs and emptyFlow", () => {
    const n = updateFlowAttrs(base(), { params: { x: { type: "string", required: true } }, limits: { budgetUsd: 3 } });
    expect(n.params).toEqual({ x: { type: "string", required: true } });
    expect(n.limits).toEqual({ budgetUsd: 3 });
    expect(emptyFlow("new-flow", "New flow")).toEqual({ schemaVersion: 1, id: "new-flow", name: "New flow", nodes: [] });
  });
});

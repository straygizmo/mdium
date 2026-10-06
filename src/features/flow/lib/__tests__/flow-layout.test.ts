import { describe, expect, it } from "vitest";
import { buildFlowGraph } from "../flow-graph";
import { GROUP_HEADER, NODE_HEIGHT, NODE_WIDTH, layoutFlowGraph, savedPositions, toElkGraph } from "../flow-layout";
import { docDigest } from "./doc-digest";

describe("layoutFlowGraph (elkjs)", () => {
  it("places every node, children inside their group, left to right", async () => {
    const graph = buildFlowGraph(docDigest(), new Set());
    const layout = await layoutFlowGraph(graph);
    for (const node of graph.nodes) expect(layout[node.id], node.id).toBeDefined();
    const group = layout["nodes[1]"];
    for (const node of graph.nodes.filter((n) => n.parentId === "nodes[1]")) {
      const box = layout[node.id];
      // Child positions are relative to the group and fit inside it, below its header.
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(GROUP_HEADER);
      expect(box.x + box.width).toBeLessThanOrEqual(group.width);
      expect(box.y + box.height).toBeLessThanOrEqual(group.height);
      expect(box.width).toBe(NODE_WIDTH);
      expect(box.height).toBe(NODE_HEIGHT);
    }
    // collect -> docs -> compile -> review -> publish flows rightwards.
    const xs = ["nodes[0]", "nodes[1]", "nodes[2]", "nodes[3]", "nodes[4]"].map((id) => layout[id].x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("keeps saved top-level positions", async () => {
    const graph = buildFlowGraph(docDigest(), new Set(["nodes[1]"]));
    const layout = await layoutFlowGraph(graph, { collect: { x: -500, y: 42 } });
    expect(layout["nodes[0]"]).toMatchObject({ x: -500, y: 42 });
  });

  it("puts body edges in their group", () => {
    const elk = toElkGraph(buildFlowGraph(docDigest(), new Set()));
    const group = elk.children!.find((c) => c.id === "nodes[1]")!;
    expect(group.children).toHaveLength(3);
    expect(group.edges!.map((e) => e.id)).toEqual([
      "nodes[1].body.edges[0]",
      "nodes[1].body.edges[1]",
      "nodes[1].body.edges[2]",
    ]);
    expect(elk.edges).toHaveLength(5);
  });

  it("reads ui.positions defensively", () => {
    expect(savedPositions(undefined)).toEqual({});
    expect(savedPositions({ positions: { a: { x: 1, y: 2 }, b: { x: "1" }, c: null } })).toEqual({
      a: { x: 1, y: 2 },
    });
  });
});

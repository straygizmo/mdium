import { describe, expect, it } from "vitest";
import type { FlowDef, FlowIssue } from "@/shared/types/flow";
import { buildFlowGraph, issueNodePath, issuesForNode, nodeAtPath } from "../flow-graph";
import { docDigest } from "./doc-digest";

const issue = (path: string, code = "FLOW_INVALID_VALUE"): FlowIssue => ({
  code: code as FlowIssue["code"],
  path,
  params: {},
});

describe("buildFlowGraph", () => {
  it("draws the doc-digest loop as a group with its body inside", () => {
    const graph = buildFlowGraph(docDigest(), new Set());
    const ids = graph.nodes.map((n) => [n.id, n.nodeId, n.parentId ?? null]);
    expect(ids).toEqual([
      ["nodes[0]", "collect", null],
      ["nodes[1]", "docs", null],
      ["nodes[1].body.nodes[0]", "summarize", "nodes[1]"],
      ["nodes[1].body.nodes[1]", "check", "nodes[1]"],
      ["nodes[1].body.nodes[2]", "quality_gate", "nodes[1]"],
      ["nodes[2]", "compile", null],
      ["nodes[3]", "review", null],
      ["nodes[4]", "publish", null],
      ["nodes[5]", "notify_failure", null],
    ]);
    const loop = graph.nodes[1];
    expect(loop.isGroup).toBe(true);
    expect(loop.collapsible).toBe(true);
    expect(loop.details).toEqual([
      { key: "foreach", value: "${{ nodes.collect.outputs.docs }}" },
      { key: "iterations", value: "≤200 ×2" },
    ]);
    const back = graph.edges.find((e) => e.isBack)!;
    expect(back).toMatchObject({
      source: "nodes[1].body.nodes[2]",
      target: "nodes[1].body.nodes[0]",
      port: "low",
      maxTraversals: 2,
    });
    const failure = graph.edges.find((e) => e.isFailure)!;
    expect(failure).toMatchObject({ source: "nodes[1]", target: "nodes[5]", port: "failure" });
    expect(graph.edges).toHaveLength(8);
  });

  it("summarizes each node kind", () => {
    const graph = buildFlowGraph(docDigest(), new Set());
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.nodeId, n]));
    expect(byId.summarize.details[0]).toEqual({ key: "provider", value: "claude" });
    expect(byId.summarize.estimateUsd).toBe(0.05);
    expect(byId.collect.details).toEqual([{ key: "program", value: "docsflow" }]);
    expect(byId.quality_gate.details).toEqual([{ key: "cases", value: "low / (ok)" }]);
    expect(byId.review.details[1]).toEqual({ key: "options", value: "publish / reject" });
  });

  it("hides a collapsed body and counts its nodes", () => {
    const graph = buildFlowGraph(docDigest(), new Set(["nodes[1]"]));
    expect(graph.nodes.some((n) => n.parentId)).toBe(false);
    const loop = graph.nodes.find((n) => n.id === "nodes[1]")!;
    expect(loop).toMatchObject({ isGroup: false, collapsible: true, hiddenChildren: 3 });
    expect(graph.edges.every((e) => !e.id.includes(".body."))).toBe(true);
  });

  it("counts issues on the deepest visible node", () => {
    const issues = {
      errors: [issue("nodes[1].body.nodes[1].run[2]"), issue("nodes[0].timeout")],
      warnings: [issue("edges[0]")],
    };
    const expanded = buildFlowGraph(docDigest(), new Set(), issues);
    const count = (g: typeof expanded, id: string) => g.nodes.find((n) => n.id === id)!.errorCount;
    expect(count(expanded, "nodes[1].body.nodes[1]")).toBe(1);
    expect(count(expanded, "nodes[1]")).toBe(0);
    expect(count(expanded, "nodes[0]")).toBe(1);
    const collapsed = buildFlowGraph(docDigest(), new Set(["nodes[1]"]), issues);
    expect(count(collapsed, "nodes[1]")).toBe(1);
  });

  it("skips edges whose endpoints are unknown and tolerates duplicate ids", () => {
    const def: FlowDef = {
      schemaVersion: 1,
      id: "t",
      name: "T",
      nodes: [
        { id: "a", kind: "command", run: ["x"], shell: false, protocol: "mdium-v1" },
        { id: "a", kind: "command", run: ["y"], shell: false, protocol: "mdium-v1" },
      ],
      edges: [{ from: "a", to: "ghost" }],
    };
    const graph = buildFlowGraph(def, new Set());
    expect(graph.nodes.map((n) => n.id)).toEqual(["nodes[0]", "nodes[1]"]);
    expect(graph.edges).toEqual([]);
  });
});

describe("issue paths", () => {
  it("finds the node an issue points into", () => {
    expect(issueNodePath("nodes[3].retry.max")).toBe("nodes[3]");
    expect(issueNodePath("nodes[1].body.nodes[0].run[2]")).toBe("nodes[1].body.nodes[0]");
    expect(issueNodePath("nodes[1].body.edges[0].to")).toBe("nodes[1]");
    expect(issueNodePath("edges[0].port")).toBeNull();
    expect(issueNodePath("")).toBeNull();
  });

  it("selects the issues of a node and its body", () => {
    const list = [issue("nodes[1]"), issue("nodes[1].body.nodes[0].x"), issue("nodes[10].y"), issue("edges[0]")];
    expect(issuesForNode(list, "nodes[1]")).toEqual([list[0], list[1]]);
    expect(issuesForNode(list, "nodes[1].body.nodes[0]")).toEqual([list[1]]);
  });

  it("finds the definition at a node path", () => {
    const def = docDigest();
    expect(nodeAtPath(def, "nodes[1].body.nodes[2]")?.id).toBe("quality_gate");
    expect(nodeAtPath(def, "nodes[0]")?.id).toBe("collect");
    expect(nodeAtPath(def, "nodes[9]")).toBeUndefined();
    expect(nodeAtPath(def, "nodes[0].body.nodes[0]")).toBeUndefined();
  });
});

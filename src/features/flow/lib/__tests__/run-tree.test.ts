import { describe, expect, it } from "vitest";
import type { FlowDef } from "@/shared/types/flow";
import type { NodeState, RunState } from "@/shared/types/flow-run";
import { buildRunTree, defaultExpandedKeys, flattenVisible } from "../run-tree";

const n = (status: NodeState["status"], extra: Partial<NodeState> = {}): NodeState =>
  ({ status, attempt: 1, cost: { actual: 0, estimated: 0 }, costReported: false, ...extra }) as NodeState;
const flow = { schemaVersion: 1, id: "f", name: "F", nodes: [{ id: "docs", kind: "loop", name: "Docs" }, { id: "sub", kind: "subflow", name: "Sub" }, { id: "fin", kind: "command", name: "Finish" }], edges: [] } as unknown as FlowDef;

function state(extra: Partial<RunState> = {}): RunState {
  return {
    seq: 1, status: "running", cost: { actual: 0, estimated: 0 },
    nodes: {
      docs: n("running"),
      "docs[0]/summarize": n("succeeded", { cost: { actual: 0.5, estimated: 0 } }),
      "docs[1]/summarize": n("running", { progress: { text: "half" } }),
      sub: n("succeeded"),
      "sub/inner": n("failed"),
      fin: n("pending"),
    },
    scopes: { "": { status: "running" }, "docs[0]/": { status: "completed", owner: "docs", index: 0 }, "docs[1]/": { status: "running", owner: "docs", index: 1 }, "sub/": { status: "failed", owner: "sub" } },
    ...extra,
  } as RunState;
}

describe("buildRunTree", () => {
  it("nests iterations under their loop and sub-flow nodes under their caller", () => {
    const rows = buildRunTree(state(), flow);
    expect(rows.map((r) => r.label)).toEqual(["Docs", "Sub", "Finish"]);
    const docs = rows[0];
    expect(docs.children.map((c) => [c.kind, c.iterationIndex])).toEqual([["iteration", 0], ["iteration", 1]]);
    expect(docs.children[1].children[0].key).toBe("docs[1]/summarize");
    expect(docs.children[1].children[0].label).toBe("summarize");
    expect(docs.children[1].children[0].depth).toBe(2);
    expect(rows[1].children[0].key).toBe("sub/inner");
  });
  it("aggregates counts, cost and the latest progress bottom-up", () => {
    const [docs, sub] = buildRunTree(state(), flow);
    expect(docs.agg).toEqual({ running: 2, failed: 0, awaiting: 0, costUsd: 0.5, progress: "half" });
    expect(sub.agg.failed).toBe(1);
  });
  it("labels later passes and keeps unknown owners at the root", () => {
    const rows = buildRunTree(state({ nodes: { "fin@2": n("ready"), "ghost/x": n("ready") }, scopes: { "": { status: "running" } }, passes: { fin: 2 } }), flow);
    expect(rows.map((r) => r.label)).toEqual(["fin@2", "x"]);
  });
  it("builds a flat tree when scopes are absent", () => {
    const rows = buildRunTree({ seq: 1, status: "completed", cost: { actual: 0, estimated: 0 }, nodes: { fin: n("succeeded") } } as RunState, flow);
    expect(rows).toHaveLength(1);
    expect(rows[0].children).toEqual([]);
  });
});

describe("defaultExpandedKeys / flattenVisible", () => {
  it("expands only ancestors of running, failed or awaiting nodes", () => {
    const rows = buildRunTree(state(), flow);
    const expanded = defaultExpandedKeys(rows);
    expect([...expanded].sort()).toEqual(["docs", "docs[1]/", "sub"]);
    const visible = flattenVisible(rows, expanded).map((r) => r.key);
    expect(visible).toEqual(["docs", "docs[0]/", "docs[1]/", "docs[1]/summarize", "sub", "sub/inner", "fin"]);
  });
});

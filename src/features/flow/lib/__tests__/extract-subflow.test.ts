import { describe, expect, it } from "vitest";
import type {
  FlowAgentNode, FlowApprovalNode, FlowCommandNode, FlowDef, FlowLoopNode, FlowNode, FlowSubflowNode,
} from "@/shared/types/flow";
import { collectReferences, extractSubflow } from "../extract-subflow";

const MAIN = ".mdium/flows/main.flow.yaml";

const cmd = (id: string, run: string, extra: Partial<FlowCommandNode> = {}): FlowCommandNode => ({
  id, kind: "command", run, shell: true, protocol: "none", ...extra,
});

const byId = (nodes: FlowNode[], id: string): FlowNode | undefined => nodes.find((n) => n.id === id);

function ok(result: ReturnType<typeof extractSubflow>) {
  if (!result.ok) throw new Error(`extraction refused: ${result.reason}`);
  return result;
}

const basic = (): FlowDef => ({
  schemaVersion: 1, id: "main", name: "Main",
  params: { src: { type: "path", required: true } },
  nodes: [
    cmd("prep", "ls"),
    cmd("a", "copy ${{ params.src }} ${{ nodes.prep.outputs.list }}"),
    cmd("b", "check ${{ nodes.a.outputs.copied }}"),
    cmd("after", "echo ${{ nodes.b.outputs.result }}"),
  ],
  edges: [{ from: "prep", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "after" }],
  ui: { positions: { prep: { x: 0, y: 0 }, a: { x: 100, y: 50 }, b: { x: 300, y: 80 } } },
});

describe("extractSubflow", () => {
  it("basic extraction builds the signature and rewrites references", () => {
    const def = basic();
    const before = structuredClone(def);
    const r = ok(extractSubflow(def, ["nodes[1]", "nodes[2]"], "my-part", MAIN));

    expect(def).toEqual(before);
    expect(r.signature).toEqual({ params: ["src", "list"], outputs: ["result"] });

    expect(r.part.id).toBe("my-part");
    expect(r.part.params).toEqual({ src: { type: "path" }, list: { type: "string" } });
    expect(r.part.outputs).toEqual({ result: "${{ nodes.b.outputs.result }}" });
    expect(r.part.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect((byId(r.part.nodes, "a") as FlowCommandNode).run).toBe("copy ${{ params.src }} ${{ params.list }}");
    expect((byId(r.part.nodes, "b") as FlowCommandNode).run).toBe("check ${{ nodes.a.outputs.copied }}");
    expect(r.part.edges).toEqual([{ from: "a", to: "b" }]);
    expect(r.part.ui).toEqual({ positions: { a: { x: 0, y: 0 }, b: { x: 200, y: 30 } } });

    expect(r.updated.nodes.map((n) => n.id)).toEqual(["prep", "my_part", "after"]);
    const call = byId(r.updated.nodes, "my_part") as FlowSubflowNode;
    expect(call).toEqual({
      id: "my_part", kind: "subflow", flow: "lib/my-part.flow.yaml",
      params: { src: "${{ params.src }}", list: "${{ nodes.prep.outputs.list }}" },
    });
    expect((byId(r.updated.nodes, "after") as FlowCommandNode).run).toBe("echo ${{ nodes.my_part.outputs.result }}");
    expect(r.updated.edges).toEqual([{ from: "prep", to: "my_part" }, { from: "my_part", to: "after" }]);
    expect(r.updated.ui).toEqual({ positions: { prep: { x: 0, y: 0 }, my_part: { x: 100, y: 50 } } });
    expect(r.newNodePath).toBe("nodes[1]");
  });

  it("loop variables become params", () => {
    const loop: FlowLoopNode = {
      id: "l", kind: "loop", mode: "foreach", items: "${{ params.items }}", maxIterations: 5,
      body: {
        nodes: [cmd("p", "work ${{ item }}"), cmd("q", "use ${{ nodes.p.outputs.o }}")],
        edges: [{ from: "p", to: "q" }],
        outputs: { o: "${{ nodes.q.outputs.o }}" },
      },
    };
    const def: FlowDef = { schemaVersion: 1, id: "main", name: "Main", nodes: [loop] };
    const r = ok(extractSubflow(def, ["nodes[0].body.nodes[0]", "nodes[0].body.nodes[1]"], "inner", MAIN));

    expect(r.signature).toEqual({ params: ["item"], outputs: ["o"] });
    expect(r.part.params).toEqual({ item: { type: "string" } });
    expect((byId(r.part.nodes, "p") as FlowCommandNode).run).toBe("work ${{ params.item }}");
    expect(r.part.outputs).toEqual({ o: "${{ nodes.q.outputs.o }}" });

    expect(r.updated.nodes.map((n) => n.id)).toEqual(["l"]);
    const body = (r.updated.nodes[0] as FlowLoopNode).body;
    if (typeof body === "string") throw new Error("body must stay inline");
    expect(body.nodes).toEqual([
      { id: "inner", kind: "subflow", flow: "lib/inner.flow.yaml", params: { item: "${{ item }}" } },
    ]);
    expect(body.edges).toEqual([]);
    expect(body.outputs).toEqual({ o: "${{ nodes.inner.outputs.o }}" });
    expect(r.newNodePath).toBe("nodes[0].body.nodes[0]");
  });

  it("refuses multiple entry points", () => {
    const def: FlowDef = {
      schemaVersion: 1, id: "main", name: "Main",
      nodes: [cmd("s", "s"), cmd("a", "a"), cmd("b", "b"), cmd("c", "c")],
      edges: [{ from: "s", to: "a" }, { from: "s", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "c" }],
    };
    const r = extractSubflow(def, ["nodes[1]", "nodes[2]"], "two", MAIN);
    expect(r).toMatchObject({ ok: false, reason: "multiple-entries" });
  });

  it("refuses multiple exits", () => {
    const def: FlowDef = {
      schemaVersion: 1, id: "main", name: "Main",
      nodes: [cmd("s", "s"), cmd("a", "a"), cmd("b", "b"), cmd("x", "x"), cmd("y", "y")],
      edges: [
        { from: "s", to: "a" }, { from: "a", to: "b" },
        { from: "a", to: "x", port: "failure" }, { from: "b", to: "y" },
      ],
    };
    const r = extractSubflow(def, ["nodes[1]", "nodes[2]"], "two", MAIN);
    expect(r).toMatchObject({ ok: false, reason: "multiple-exits" });
  });

  it("refuses mixed scopes and empty selections", () => {
    const def: FlowDef = {
      schemaVersion: 1, id: "main", name: "Main",
      nodes: [
        cmd("a", "a"),
        { id: "l", kind: "loop", mode: "foreach", items: "${{ params.items }}", maxIterations: 2, body: { nodes: [cmd("i", "i")] } },
      ],
    };
    expect(extractSubflow(def, ["nodes[0]", "nodes[1].body.nodes[0]"], "mixed", MAIN)).toMatchObject({ ok: false, reason: "mixed-scopes" });
    expect(extractSubflow(def, [], "none", MAIN)).toMatchObject({ ok: false, reason: "empty" });
    // A name outside the flow-id rule is refused as well.
    expect(extractSubflow(def, ["nodes[0]"], "Bad_Name", MAIN)).toMatchObject({ ok: false, reason: "invalid-name" });
  });

  it("keeps back edges inside the selection", () => {
    const def: FlowDef = {
      schemaVersion: 1, id: "main", name: "Main",
      nodes: [cmd("s", "s"), cmd("a", "a"), { id: "b", kind: "approval" }, cmd("c", "c"), cmd("t", "t")],
      edges: [
        { from: "s", to: "a" }, { from: "a", to: "b" },
        { from: "b", to: "a", port: "reject", maxTraversals: 3 },
        { from: "b", to: "c", port: "approve" },
        { from: "c", to: "t" },
      ],
    };
    const r = ok(extractSubflow(def, ["nodes[1]", "nodes[2]", "nodes[3]"], "review", MAIN));
    expect(r.part.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "a", port: "reject", maxTraversals: 3 },
      { from: "b", to: "c", port: "approve" },
    ]);
    expect(r.updated.edges).toEqual([{ from: "s", to: "review" }, { from: "review", to: "t" }]);
  });

  it("rewrites outside references to the new node", () => {
    const def: FlowDef = {
      schemaVersion: 1, id: "main", name: "Main",
      nodes: [cmd("a", "a"), cmd("b", "b"), cmd("c", "use ${{ nodes.b.outputs.x }}")],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
      outputs: { y: "${{ nodes.b.outputs.y }}" },
    };
    const r = ok(extractSubflow(def, ["nodes[1]"], "mid", MAIN));
    expect(r.signature.outputs).toEqual(["x", "y"]);
    expect(r.part.outputs).toEqual({ x: "${{ nodes.b.outputs.x }}", y: "${{ nodes.b.outputs.y }}" });
    expect((byId(r.updated.nodes, "c") as FlowCommandNode).run).toBe("use ${{ nodes.mid.outputs.x }}");
    expect(r.updated.outputs).toEqual({ y: "${{ nodes.mid.outputs.y }}" });
  });

  it("name collision gets a suffix", () => {
    const def: FlowDef = {
      schemaVersion: 1, id: "main", name: "Main",
      params: { k: { type: "number" } },
      nodes: [cmd("x", "x"), cmd("a", "run ${{ params.k }} ${{ nodes.x.outputs.k }}")],
      edges: [{ from: "x", to: "a" }],
    };
    const r = ok(extractSubflow(def, ["nodes[1]"], "x", MAIN));
    expect(r.signature.params).toEqual(["k", "k_2"]);
    expect(r.part.params).toEqual({ k: { type: "number" }, k_2: { type: "string" } });
    expect((r.part.nodes[0] as FlowCommandNode).run).toBe("run ${{ params.k }} ${{ params.k_2 }}");
    // The node id `x` is taken by an outside node, so the call node gets a suffix too.
    const call = r.updated.nodes[1] as FlowSubflowNode;
    expect(call.id).toBe("x_2");
    expect(call.params).toEqual({ k: "${{ params.k }}", k_2: "${{ nodes.x.outputs.k }}" });
  });

  it("treats condition refs as references", () => {
    const def = basic();
    def.nodes[1] = { ...def.nodes[1], when: { all: [{ ref: "nodes.prep.outputs.list", op: "exists" }] } };
    def.nodes[3] = { ...def.nodes[3], when: { ref: "nodes.b.outputs.result", op: "==", value: "ok" } };
    const r = ok(extractSubflow(def, ["nodes[1]", "nodes[2]"], "my-part", MAIN));
    expect(byId(r.part.nodes, "a")?.when).toEqual({ all: [{ ref: "params.list", op: "exists" }] });
    expect(byId(r.updated.nodes, "after")?.when).toEqual({ ref: "nodes.my_part.outputs.result", op: "==", value: "ok" });
    expect(collectReferences({ when: { not: { ref: "params.a", op: "exists" } }, run: "${{ index }}" })).toEqual(["params.a", "index"]);
  });

  it("refuses a non-success exit port", () => {
    const def: FlowDef = {
      schemaVersion: 1, id: "main", name: "Main",
      nodes: [cmd("s", "s"), { id: "ok", kind: "approval" }, cmd("t", "t")],
      edges: [{ from: "s", to: "ok" }, { from: "ok", to: "t", port: "approve" }],
    };
    expect(extractSubflow(def, ["nodes[1]"], "gate", MAIN)).toEqual({ ok: false, reason: "unsupported-exit", detail: "approve" });
  });

  it("keeps a single failure exit", () => {
    const def: FlowDef = {
      schemaVersion: 1, id: "main", name: "Main",
      nodes: [cmd("s", "s"), cmd("a", "a"), cmd("x", "x")],
      edges: [{ from: "s", to: "a" }, { from: "a", to: "x", port: "failure" }],
    };
    const r = ok(extractSubflow(def, ["nodes[1]"], "risky", MAIN));
    expect(r.updated.edges).toEqual([{ from: "s", to: "risky" }, { from: "risky", to: "x", port: "failure" }]);
  });

  it("refuses an outside back edge into a non-entry node", () => {
    const def: FlowDef = {
      schemaVersion: 1, id: "main", name: "Main",
      nodes: [cmd("s", "s"), cmd("a", "a"), cmd("b", "b"), cmd("z", "z")],
      edges: [
        { from: "s", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "z" },
        { from: "z", to: "b", port: "failure", maxTraversals: 2 },
      ],
    };
    expect(extractSubflow(def, ["nodes[1]", "nodes[2]"], "pair", MAIN)).toEqual({ ok: false, reason: "multiple-entries", detail: "a,b" });
    // A back edge into the entry node is fine and is re-targeted to the new node.
    def.edges![3] = { from: "z", to: "a", port: "failure", maxTraversals: 2 };
    const r = ok(extractSubflow(def, ["nodes[1]", "nodes[2]"], "pair", MAIN));
    expect(r.updated.edges).toContainEqual({ from: "z", to: "pair", port: "failure", maxTraversals: 2 });
  });

  it("rewrites approval show references", () => {
    const def = basic();
    def.nodes[2] = { id: "b", kind: "approval", show: ["nodes.prep.outputs.list", " nodes.a.outputs.copied "] };
    def.nodes[3] = { id: "after", kind: "approval", show: ["nodes.b.outputs.comment", "params.src"] };
    def.edges = [{ from: "prep", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "after", port: "failure" }];
    const r = ok(extractSubflow(def, ["nodes[1]", "nodes[2]"], "my-part", MAIN));
    expect((byId(r.part.nodes, "b") as FlowApprovalNode).show).toEqual(["params.list", " nodes.a.outputs.copied "]);
    expect(r.signature.params).toEqual(["src", "list"]);
    expect(r.part.outputs).toEqual({ comment: "${{ nodes.b.outputs.comment }}" });
    expect((byId(r.updated.nodes, "after") as FlowApprovalNode).show).toEqual(["nodes.my_part.outputs.comment", "params.src"]);
    expect(collectReferences({ kind: "approval", show: ["nodes.x.outputs.y"] })).toEqual(["nodes.x.outputs.y"]);
  });

  it("copies defaults, env and envPassthrough into the part", () => {
    const def: FlowDef = {
      ...basic(),
      defaults: { timeout: "5m", workingDir: "work" },
      env: { MODE: "fast" },
      envPassthrough: ["HOME"],
    };
    const r = ok(extractSubflow(def, ["nodes[1]"], "copy", MAIN));
    expect(r.part.defaults).toEqual({ timeout: "5m", workingDir: "work" });
    expect(r.part.env).toEqual({ MODE: "fast" });
    expect(r.part.envPassthrough).toEqual(["HOME"]);
    // Absent context stays absent.
    const plain = ok(extractSubflow(basic(), ["nodes[1]"], "copy", MAIN));
    expect("defaults" in plain.part || "env" in plain.part || "envPassthrough" in plain.part).toBe(false);
  });

  it("rebases relative file references into lib/", () => {
    const agent = (id: string, promptRef: string): FlowAgentNode => ({
      id, kind: "agent", provider: "claude", promptRef, permission: "read-only", outputContract: "free",
    });
    const def: FlowDef = {
      schemaVersion: 1, id: "main", name: "Main",
      nodes: [
        { id: "sub", kind: "subflow", flow: "lib/helper.flow.yaml" },
        { id: "fl", kind: "loop", mode: "foreach", items: "${{ params.items }}", maxIterations: 2, body: "../shared/item.flow.yaml" },
        agent("p1", "prompts/review.md"),
        agent("p2", "builtin:review"),
        agent("p3", "mdium:review"),
        agent("p4", "/abs/review.md"),
        { id: "pm", kind: "subflow", flow: "project:main" },
        { id: "dw", kind: "subflow", flow: "mdium:dev-workflow" },
        {
          id: "il", kind: "loop", mode: "foreach", items: "${{ params.items }}", maxIterations: 2,
          body: { nodes: [{ id: "deep", kind: "subflow", flow: "other.flow.yaml" }] },
        },
      ],
      edges: [
        { from: "sub", to: "fl" }, { from: "fl", to: "p1" }, { from: "p1", to: "p2" },
        { from: "p2", to: "p3" }, { from: "p3", to: "p4" }, { from: "p4", to: "pm" }, { from: "pm", to: "dw" }, { from: "dw", to: "il" },
      ],
    };
    const r = ok(extractSubflow(def, def.nodes.map((_, i) => `nodes[${i}]`), "all", MAIN));
    expect((byId(r.part.nodes, "sub") as FlowSubflowNode).flow).toBe("helper.flow.yaml");
    expect((byId(r.part.nodes, "fl") as FlowLoopNode).body).toBe("../../shared/item.flow.yaml");
    expect((byId(r.part.nodes, "p1") as FlowAgentNode).promptRef).toBe("../prompts/review.md");
    expect((byId(r.part.nodes, "p2") as FlowAgentNode).promptRef).toBe("builtin:review");
    expect((byId(r.part.nodes, "p3") as FlowAgentNode).promptRef).toBe("mdium:review");
    expect((byId(r.part.nodes, "p4") as FlowAgentNode).promptRef).toBe("/abs/review.md");
    expect((byId(r.part.nodes, "pm") as FlowSubflowNode).flow).toBe("project:main");
    expect((byId(r.part.nodes, "dw") as FlowSubflowNode).flow).toBe("mdium:dev-workflow");
    const inner = (byId(r.part.nodes, "il") as FlowLoopNode).body;
    if (typeof inner === "string") throw new Error("body must stay inline");
    expect((inner.nodes[0] as FlowSubflowNode).flow).toBe("../other.flow.yaml");
  });
});

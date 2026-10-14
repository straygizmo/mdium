import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FlowDef, FlowNode } from "@/shared/types/flow";
import { mergeFlowIntoText, parseFlowText, stringifyFlow, stringifyFlowAs } from "../flow-yaml";

const def: FlowDef = {
  schemaVersion: 1, id: "demo", name: "Demo",
  edges: [{ from: "a", to: "b" }, { from: "b", to: "a", port: "revise", maxTraversals: 2 }],
  nodes: [
    { id: "a", kind: "command", run: ["echo", "1"], shell: false, protocol: "mdium-v1", timeout: "30s", name: "Echo" },
    { id: "b", kind: "approval", options: ["accept", { name: "revise", commentRequired: true }], show: ["nodes.a.outputs.x"] },
    { id: "c", kind: "python", runtime: "demo", entry: "demo.add", with: { a: "${{ params.a }}", b: 1 } },
  ],
  params: { a: { type: "number", default: 2, required: false } },
  outputs: { sum: "${{ nodes.c.outputs.sum }}" },
  ui: { positions: { a: { x: 10, y: 20 } } },
};

describe("stringifyFlow", () => {
  it("writes keys in canonical order and omits absent optionals", () => {
    const text = stringifyFlow(def);
    const lines = text.split("\n");
    expect(lines[0]).toBe("schemaVersion: 1");
    expect(lines[1]).toBe("id: demo");
    expect(lines[2]).toBe("name: Demo");
    expect(text.indexOf("params:")).toBeLessThan(text.indexOf("nodes:"));
    expect(text.indexOf("nodes:")).toBeLessThan(text.indexOf("edges:"));
    expect(text.indexOf("edges:")).toBeLessThan(text.indexOf("outputs:"));
    expect(text.indexOf("outputs:")).toBeLessThan(text.indexOf("ui:"));
    expect(text).not.toContain("description");
    expect(text).not.toContain("null");
    // node a: id, kind, name, then command keys, then timeout
    const a = text.slice(text.indexOf("- id: a"), text.indexOf("- id: b"));
    expect(a.indexOf("kind: command")).toBeLessThan(a.indexOf("name: Echo"));
    expect(a.indexOf("run:")).toBeGreaterThan(a.indexOf("name: Echo"));
    expect(a.indexOf("timeout: 30s")).toBeGreaterThan(a.indexOf("protocol: mdium-v1"));
  });
  it("round-trips through parse", () => {
    const text = stringifyFlow(def);
    const parsed = parseFlowText(text);
    expect("value" in parsed && parsed.value).toEqual(def);
  });
  it("quotes templates and keeps long templates on one line", () => {
    const text = stringifyFlow({ ...def, outputs: { long: "${{ nodes.c.outputs.sum }} and a very long trailing text that would otherwise be folded by the default line width of eighty characters" } });
    expect(text).toMatch(/long: "\$\{\{ nodes\.c\.outputs\.sum \}\} and a very long[^\n]*"\n/);
  });
  it("uses flow style for small maps and edges", () => {
    const text = stringifyFlow(def);
    expect(text).toContain("- { from: a, to: b }");
    expect(text).toContain("with: { a: \"${{ params.a }}\", b: 1 }");
  });
  it("keeps a multi-line template string as a block scalar", () => {
    const prompt = "Summarize ${{ params.doc }}.\nAnswer in ${{ params.lang }}.";
    const agent: FlowDef = {
      schemaVersion: 1, id: "a", name: "A",
      nodes: [{ id: "g", kind: "agent", provider: "claude", permission: "read-only", outputContract: "outcome", prompt }],
    };
    const text = stringifyFlow(agent);
    expect(text).toMatch(/prompt: \|-?\n {6}Summarize \$\{\{ params\.doc \}\}\.\n {6}Answer in/);
    const parsed = parseFlowText(text);
    expect("value" in parsed && (parsed.value as FlowDef).nodes[0]).toMatchObject({ prompt });
  });
  it("canonicalises inline loop bodies (key order, empty lists dropped, flow-style edges)", () => {
    const loop: FlowDef = {
      schemaVersion: 1, id: "l", name: "L",
      nodes: [
        {
          maxIterations: 2, mode: "foreach", items: [1], kind: "loop", id: "loop",
          body: {
            outputs: {},
            edges: [{ to: "y", from: "x" }],
            nodes: [{ kind: "approval", id: "x" }, { name: "Y", kind: "approval", id: "y" }],
          },
        } as unknown as FlowDef["nodes"][number],
      ],
    };
    const text = stringifyFlow(loop);
    const body = text.slice(text.indexOf("body:"));
    expect(body.indexOf("nodes:")).toBeLessThan(body.indexOf("edges:"));
    expect(body).not.toContain("outputs");
    expect(body).toContain("- id: x\n          kind: approval");
    expect(body).toContain("- id: y\n          kind: approval\n          name: Y");
    expect(body).toContain("- { from: x, to: y }");
    const head = text.slice(text.indexOf("- id: loop"));
    expect(head.indexOf("kind: loop")).toBeLessThan(head.indexOf("maxIterations"));
  });
  it("quotes strings that would otherwise read as other types", () => {
    const ambiguous: FlowDef = { ...def, outputs: { t: "true", n: "1", e: "", z: "007", s: "plain" } };
    const text = stringifyFlow(ambiguous);
    const parsed = parseFlowText(text);
    expect("value" in parsed && (parsed.value as FlowDef).outputs).toEqual({ t: "true", n: "1", e: "", z: "007", s: "plain" });
    expect(text).toMatch(/t: "true"|t: 'true'/);
    expect(text).toMatch(/n: "1"|n: '1'/);
    expect(text).toMatch(/e: ""|e: ''/);
  });
});

describe("stringifyFlowAs", () => {
  it("writes canonical JSON for json files and YAML otherwise", () => {
    const json = stringifyFlowAs(def, "json");
    expect(json.startsWith("{\n  \"schemaVersion\": 1,\n  \"id\": \"demo\"")).toBe(true);
    expect(json.endsWith("}\n")).toBe(true);
    expect(JSON.parse(json)).toEqual(def);
    expect(Object.keys(JSON.parse(json) as object)).toEqual(["schemaVersion", "id", "name", "params", "nodes", "edges", "outputs", "ui"]);
    expect(stringifyFlowAs(def, "yaml")).toBe(stringifyFlow(def));
  });
});

describe("parseFlowText", () => {
  it("reports the position of a syntax error", () => {
    const r = parseFlowText("nodes:\n  - id: a\n   kind: [\n");
    expect("error" in r && r.error.line).toBeGreaterThan(0);
  });
  it("rejects duplicate keys like the Rust parser", () => {
    expect("error" in parseFlowText("id: a\nid: b\n")).toBe(true);
  });
});

const SOURCE = `# Production flow
schemaVersion: 1
id: demo
name: Demo   # the display name
params:
  n: { type: number, default: 1 }
nodes:
  # First step
  - id: a
    kind: command
    run: [echo, a]
    timeout: 5m
  - id: b
    kind: command
    run: [echo, b]
edges:
  - { from: a, to: b }
`;

function defOf(text: string) {
  const r = parseFlowText(text);
  if ("error" in r) throw new Error(r.error.message);
  return r.value as FlowDef;
}

describe("mergeFlowIntoText", () => {
  it("merge keeps comments and key order and drops removed nodes", () => {
    const d = defOf(SOURCE);
    d.nodes[0] = { ...d.nodes[0], timeout: "10m" } as FlowNode;
    d.nodes = [d.nodes[0]];
    d.edges = [];
    const out = mergeFlowIntoText(SOURCE, d);
    expect(out).toContain("# Production flow");
    expect(out).toContain("name: Demo   # the display name");
    expect(out).toContain("  # First step\n  - id: a");
    expect(out).toContain("timeout: 10m");
    expect(out).not.toContain("id: b");
    expect(out).not.toContain("edges:");
    expect(out.indexOf("schemaVersion")).toBeLessThan(out.indexOf("id: demo"));
    expect(defOf(out)).toEqual(defOf(stringifyFlow(d)));
  });

  it("appends new nodes and keys in flow style with templates double-quoted", () => {
    const d = defOf(SOURCE);
    d.nodes.push({ id: "c", kind: "command", run: ["echo", "c"], with: { x: "${{ params.n }}", y: 2 } } as unknown as FlowNode);
    d.outputs = { done: "${{ nodes.c.outputs.ok }}" };
    const out = mergeFlowIntoText(SOURCE, d);
    expect(out).toContain('with: { x: "${{ params.n }}", y: 2 }');
    expect(out).toContain('done: "${{ nodes.c.outputs.ok }}"');
    expect(out.indexOf("id: b")).toBeLessThan(out.indexOf("id: c"));
    expect(defOf(out)).toEqual(defOf(stringifyFlow(d)));
  });

  it("reorders nodes by the definition and keeps each node's comment", () => {
    const d = defOf(SOURCE);
    d.nodes = [d.nodes[1], d.nodes[0]];
    const out = mergeFlowIntoText(SOURCE, d);
    expect(out.indexOf("id: b")).toBeLessThan(out.indexOf("id: a"));
    expect(out).toContain("  # First step\n  - id: a");
    expect(defOf(out)).toEqual(defOf(stringifyFlow(d)));
  });

  it("falls back to a full rewrite when the text does not parse", () => {
    const d = defOf(SOURCE);
    expect(mergeFlowIntoText("nodes: [", d)).toEqual(stringifyFlow(d));
  });

  it("writes items added to an empty list in block style", () => {
    const text = "# c\nschemaVersion: 1\nid: f\nname: F\nnodes: []\nedges: []\n";
    const d = { ...defOf(SOURCE), id: "f", name: "F", params: undefined };
    const out = mergeFlowIntoText(text, d);
    expect(out).toContain("# c\n");
    expect(out).toContain("nodes:\n  - id: a\n");
    expect(out).toContain("edges:\n  - { from: a, to: b }\n");
    expect(defOf(out)).toEqual(defOf(stringifyFlow(d)));
  });

  const EDGES = `schemaVersion: 1
id: demo
name: Demo
nodes:
  - id: a
    kind: command
    run: [echo, a]
  - id: b
    kind: command
    run: [echo, b]
edges:
  - { from: a, to: b }   # main path
  # loop
  - { from: b, to: a, port: revise }
`;

  it("adds an edge and keeps the comments on the existing edges", () => {
    const d = defOf(EDGES);
    d.edges = [...(d.edges ?? []), { from: "a", to: "a" }];
    const out = mergeFlowIntoText(EDGES, d);
    expect(out).toContain("  - { from: a, to: b }   # main path\n");
    expect(out).toContain("  # loop\n  - { from: b, to: a, port: revise }\n  - { from: a, to: a }\n");
    expect(defOf(out)).toEqual(defOf(stringifyFlow(d)));
  });

  it("leaves non-canonical edge key order alone when only the name changes", () => {
    const text = EDGES.replace("{ from: a, to: b }", "{ to: b, from: a }");
    const d = { ...defOf(text), name: "Renamed" };
    const out = mergeFlowIntoText(text, d);
    expect(out).toContain("name: Renamed\n");
    expect(out).toContain("  - { to: b, from: a }   # main path\n");
    expect(out).toContain("  # loop\n");
    expect(defOf(out)).toEqual(defOf(stringifyFlow(d)));
  });

  it("does not revert an edit to a quoted value that looks like a spaced comment", () => {
    const text = 'schemaVersion: 1\nid: demo\nname: "a   #b"\nnodes: []\n';
    const d = { ...defOf(text), name: "a #b" };
    const out = mergeFlowIntoText(text, d);
    expect(out).toContain('name: "a #b"\n');
    expect(defOf(out).name).toBe("a #b");
  });
});

describe("mergeFlowIntoText with a def decoded by Rust", () => {
  // The fixtures are `serde_json::to_string_pretty(&FlowDef)` of the template files: they carry
  // the serde defaults (`required: false`, `shell` / `protocol`, `outputContract`) and drop empty
  // collections. Regenerate them when the template files change.
  const root = resolve(__dirname, "../../../../..");
  const cases = [
    ["improve-verify", "resources/flow-templates/improve-app/flows/lib/improve-app/improve-verify.flow.yaml"],
    ["dev-workflow", "resources/flow-templates/dev-workflow/flows/dev-workflow.flow.yaml"],
  ] as const;
  for (const [name, file] of cases) {
    it(`leaves ${name} byte-equal for the unchanged def`, () => {
      const text = readFileSync(resolve(root, file), "utf8").replace(/\r\n/g, "\n");
      const decoded = JSON.parse(readFileSync(resolve(__dirname, `fixtures/${name}.decoded.json`), "utf8")) as FlowDef;
      expect(mergeFlowIntoText(text, decoded)).toBe(text);
    });
  }

  it("keeps an explicit default and an empty collection, and adds no absent default", () => {
    const text = [
      "schemaVersion: 1", "id: d", "name: D", "params:",
      "  a: { type: string, required: false }", "  b: { type: string }", "nodes:",
      "  - { id: c, kind: command, run: [x], with: {} }",
      "  - id: s", "    kind: subflow", "    flow: f.flow.yaml", "    # Edit here.", "    params: {}", "",
    ].join("\n");
    const d = {
      schemaVersion: 1, id: "d", name: "D",
      params: { a: { type: "string", required: false }, b: { type: "string", required: false } },
      nodes: [
        { id: "c", kind: "command", run: ["x"], shell: false, protocol: "mdium-v1" },
        { id: "s", kind: "subflow", flow: "f.flow.yaml" },
      ],
    } as unknown as FlowDef;
    expect(mergeFlowIntoText(text, d)).toBe(text);
  });

  it("writes a non-default value for a key the text lacks", () => {
    const text = "schemaVersion: 1\nid: d\nname: D\nnodes:\n  - { id: c, kind: command, run: [x] }\n";
    const d = {
      schemaVersion: 1, id: "d", name: "D",
      nodes: [{ id: "c", kind: "command", run: ["x"], shell: true, protocol: "mdium-v1" }],
    } as unknown as FlowDef;
    const out = mergeFlowIntoText(text, d);
    expect(out).toContain("shell: true");
    expect(out).not.toContain("protocol");
  });
});

import { describe, expect, it } from "vitest";
import type { FlowDef } from "@/shared/types/flow";
import { hasComments, parseFlowText, stringifyFlow, stringifyFlowAs } from "../flow-yaml";

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

describe("hasComments", () => {
  it("detects comments anywhere in the document", () => {
    expect(hasComments("# top\nid: a\n")).toBe(true);
    expect(hasComments("id: a\nnodes:\n  - id: x # trailing\n    kind: command\n")).toBe(true);
    expect(hasComments("id: a\nname: 'not # a comment'\n")).toBe(false);
    expect(hasComments("")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { FlowDef } from "@/shared/types/flow";
import { hasComments, parseFlowText, stringifyFlow } from "../flow-yaml";

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

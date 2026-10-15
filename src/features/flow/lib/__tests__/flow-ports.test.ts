import { describe, expect, it } from "vitest";
import type { FlowDef } from "@/shared/types/flow";
import { collectIds, isIdent, isNodeId, nextNodeId, portsOf } from "../flow-ports";

describe("portsOf", () => {
  it("mirrors the engine's node_ports", () => {
    expect(portsOf({ id: "c", kind: "command", run: ["x"], shell: false, protocol: "none" })).toEqual(["success", "failure"]);
    expect(portsOf({ id: "a", kind: "approval" })).toEqual(["approve", "reject", "failure"]);
    expect(portsOf({ id: "a", kind: "approval", options: ["ok", { name: "fix", commentRequired: true }] })).toEqual(["ok", "fix", "failure"]);
    expect(portsOf({ id: "b", kind: "branch", cases: [{ when: { ref: "params.x", op: "exists" }, port: "yes" }], default: "no" })).toEqual(["yes", "no", "failure"]);
    expect(portsOf({ id: "g", kind: "agent", provider: "claude", permission: "read-only", outputContract: "outcome" })).toEqual(["success", "attention", "failure"]);
    expect(portsOf({ id: "g", kind: "agent", provider: "claude", permission: "read-only", outputContract: "free" })).toEqual(["success", "failure"]);
  });
  it("gives an approval with an empty options list only failure (like effective_options)", () => {
    expect(portsOf({ id: "a", kind: "approval", options: [] })).toEqual(["failure"]);
  });
});

describe("collectIds", () => {
  it("collects ids from inline bodies too", () => {
    const ids = new Set<string>();
    collectIds(
      [
        { id: "a", kind: "approval" },
        { id: "l", kind: "loop", mode: "foreach", items: [], maxIterations: 1, body: { nodes: [{ id: "inner", kind: "approval" }] } },
      ] as unknown as FlowDef["nodes"],
      ids,
    );
    expect([...ids]).toEqual(["a", "l", "inner"]);
  });
});

describe("nextNodeId", () => {
  const def = { schemaVersion: 1, id: "f", name: "F", nodes: [
    { id: "command", kind: "command", run: ["x"], shell: false, protocol: "none" },
    { id: "loop", kind: "loop", mode: "foreach", items: [], maxIterations: 1, body: { nodes: [{ id: "command_2", kind: "approval" }] } },
  ] } as unknown as FlowDef;
  it("skips ids used anywhere, including inline bodies", () => {
    expect(nextNodeId(def, "command")).toBe("command_3");
    expect(nextNodeId(def, "approval")).toBe("approval");
    expect(nextNodeId(def, "python", "demo.add")).toBe("demo_add");
  });
  it("validates ids and identifiers", () => {
    expect(isNodeId("a_1")).toBe(true); expect(isNodeId("A")).toBe(false); expect(isNodeId("a-b")).toBe(false);
    expect(isIdent("out-1")).toBe(true); expect(isIdent("1x")).toBe(false);
  });
});

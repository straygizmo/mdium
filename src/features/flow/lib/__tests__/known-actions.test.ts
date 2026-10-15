import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_INPUTS, KNOWN_ACTIONS } from "../known-actions";

/** `ACTION_SPECS` of flow-core, read from its source: `uses` and `inputs` of every entry, in order. */
function rustActionSpecs(): { uses: string; inputs: { name: string; required: boolean }[] }[] {
  const source = readFileSync(resolve(__dirname, "../../../../../src-tauri/crates/flow-core/src/run/actions/mod.rs"), "utf8");
  const list = /ACTION_SPECS: \[ActionSpec; \d+\] = \[([\s\S]*?)\n\];/.exec(source);
  if (!list) throw new Error("ACTION_SPECS not found");
  const specs: { uses: string; inputs: { name: string; required: boolean }[] }[] = [];
  const entry = /uses: "([^"]+)",\s*inputs: &\[([\s\S]*?)\],\s*outputs:/g;
  for (let m = entry.exec(list[1]); m; m = entry.exec(list[1])) {
    const inputs: { name: string; required: boolean }[] = [];
    const input = /\("([^"]+)", (true|false)\)/g;
    for (let i = input.exec(m[2]); i; i = input.exec(m[2])) inputs.push({ name: i[1], required: i[2] === "true" });
    specs.push({ uses: m[1], inputs });
  }
  return specs;
}

describe("known-actions mirror", () => {
  const specs = rustActionSpecs();

  it("lists the same actions as flow-core, in the same order", () => {
    expect(specs.length).toBeGreaterThan(0);
    expect(KNOWN_ACTIONS).toEqual(specs.map((s) => s.uses));
  });

  it("declares the same inputs as flow-core", () => {
    for (const spec of specs) {
      expect(ACTION_INPUTS[spec.uses], spec.uses).toEqual(spec.inputs);
    }
    expect(Object.keys(ACTION_INPUTS).sort()).toEqual(specs.map((s) => s.uses).sort());
  });
});

import { describe, it, expect } from "vitest";
import {
  BUILTIN_PLUGINS,
  isBuiltinPlugin,
  addPluginSpec,
  removePluginSpec,
} from "../builtin-plugins";

describe("BUILTIN_PLUGINS catalog", () => {
  it("contains superpowers and oh-my-opencode entries with spec/descriptionKey/docsUrl", () => {
    expect(Object.keys(BUILTIN_PLUGINS)).toEqual(
      expect.arrayContaining(["superpowers", "oh-my-opencode"]),
    );
    for (const entry of Object.values(BUILTIN_PLUGINS)) {
      expect(entry.spec).toBeTruthy();
      expect(entry.descriptionKey).toBeTruthy();
      expect(entry.docsUrl).toMatch(/^https?:\/\//);
    }
  });

  it("pins the superpowers spec to a git tag", () => {
    expect(BUILTIN_PLUGINS.superpowers.spec).toMatch(/git\+https:\/\/github\.com\/obra\/superpowers\.git#v/);
  });
});

describe("isBuiltinPlugin", () => {
  it("returns true for a built-in spec", () => {
    expect(isBuiltinPlugin(BUILTIN_PLUGINS.superpowers.spec)).toBe(true);
  });

  it("returns false for an unknown spec", () => {
    expect(isBuiltinPlugin("some-random-plugin")).toBe(false);
  });
});

describe("addPluginSpec", () => {
  it("appends a new spec", () => {
    expect(addPluginSpec(["a"], "b")).toEqual(["a", "b"]);
  });

  it("does not duplicate an existing spec", () => {
    expect(addPluginSpec(["a", "b"], "b")).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = ["a"];
    addPluginSpec(input, "b");
    expect(input).toEqual(["a"]);
  });
});

describe("removePluginSpec", () => {
  it("removes the given spec", () => {
    expect(removePluginSpec(["a", "b"], "a")).toEqual(["b"]);
  });

  it("is a no-op when spec absent", () => {
    expect(removePluginSpec(["a", "b"], "c")).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b"];
    removePluginSpec(input, "a");
    expect(input).toEqual(["a", "b"]);
  });
});

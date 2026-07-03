import { describe, it, expect } from "vitest";
import {
  BUILTIN_PLUGINS,
  basePluginSpec,
  isBuiltinPlugin,
  getMissingBuiltinPlugins,
  getBuiltinPluginIdBySpec,
  addPluginSpec,
  removePluginSpec,
} from "../builtin-plugins";

const OLD_SUPERPOWERS_SPEC = "superpowers@git+https://github.com/obra/superpowers.git#v5.1.0";

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

describe("basePluginSpec", () => {
  it("strips the #<ref> pin", () => {
    expect(basePluginSpec(OLD_SUPERPOWERS_SPEC)).toBe(
      "superpowers@git+https://github.com/obra/superpowers.git",
    );
  });

  it("returns the spec unchanged when there is no pin", () => {
    expect(basePluginSpec("oh-my-openagent")).toBe("oh-my-openagent");
  });
});

describe("isBuiltinPlugin", () => {
  it("returns true for a built-in spec", () => {
    expect(isBuiltinPlugin(BUILTIN_PLUGINS.superpowers.spec)).toBe(true);
  });

  it("returns true for a built-in spec pinned to another version", () => {
    expect(isBuiltinPlugin(OLD_SUPERPOWERS_SPEC)).toBe(true);
  });

  it("returns false for an unknown spec", () => {
    expect(isBuiltinPlugin("some-random-plugin")).toBe(false);
  });
});

describe("getMissingBuiltinPlugins", () => {
  it("returns all built-in ids when none are present", () => {
    expect(getMissingBuiltinPlugins([])).toEqual(
      expect.arrayContaining(["superpowers", "oh-my-opencode"]),
    );
  });

  it("omits a built-in whose spec is already present", () => {
    const missing = getMissingBuiltinPlugins([BUILTIN_PLUGINS.superpowers.spec]);
    expect(missing).not.toContain("superpowers");
    expect(missing).toContain("oh-my-opencode");
  });

  it("omits a built-in already present at a different pinned version", () => {
    const missing = getMissingBuiltinPlugins([OLD_SUPERPOWERS_SPEC]);
    expect(missing).not.toContain("superpowers");
    expect(missing).toContain("oh-my-opencode");
  });

  it("ignores unrelated custom specs", () => {
    const missing = getMissingBuiltinPlugins(["my-custom-plugin"]);
    expect(missing).toEqual(
      expect.arrayContaining(["superpowers", "oh-my-opencode"]),
    );
  });
});

describe("getBuiltinPluginIdBySpec", () => {
  it("returns the id for a built-in spec", () => {
    expect(getBuiltinPluginIdBySpec(BUILTIN_PLUGINS.superpowers.spec)).toBe("superpowers");
  });

  it("returns the id for a built-in spec pinned to another version", () => {
    expect(getBuiltinPluginIdBySpec(OLD_SUPERPOWERS_SPEC)).toBe("superpowers");
  });

  it("returns undefined for an unknown spec", () => {
    expect(getBuiltinPluginIdBySpec("my-custom-plugin")).toBeUndefined();
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

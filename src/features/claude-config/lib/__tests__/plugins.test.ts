import { describe, it, expect } from "vitest";
import {
  parsePluginKey,
  isPluginEnabled,
  mergePluginList,
  toggleEnabledPlugins,
  extractInstalledPlugins,
  extractEnabledPlugins,
  type InstalledPluginRecord,
} from "../plugins";

const rec = (over: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord => ({
  scope: "user",
  installPath: "/p",
  version: "1.0.0",
  installedAt: "",
  lastUpdated: "",
  gitCommitSha: "",
  ...over,
});

describe("parsePluginKey", () => {
  it("splits name and marketplace on the last @", () => {
    expect(parsePluginKey("superpowers@claude-plugins-official")).toEqual({
      name: "superpowers",
      marketplace: "claude-plugins-official",
    });
  });
  it("handles a key without @", () => {
    expect(parsePluginKey("foo")).toEqual({ name: "foo", marketplace: "" });
  });
});

describe("isPluginEnabled", () => {
  it("treats a missing key as enabled", () => {
    expect(isPluginEnabled({}, "a@m")).toBe(true);
  });
  it("treats explicit false as disabled", () => {
    expect(isPluginEnabled({ "a@m": false }, "a@m")).toBe(false);
  });
  it("treats explicit true as enabled", () => {
    expect(isPluginEnabled({ "a@m": true }, "a@m")).toBe(true);
  });
});

describe("mergePluginList", () => {
  it("lists installed plugins with enabled state, sorted by name", () => {
    const installed = {
      "superpowers@claude-plugins-official": [rec({ version: "6.1.1" })],
      "aaa@m": [rec({ version: "2.0.0" })],
    };
    const enabled = { "superpowers@claude-plugins-official": false };
    expect(mergePluginList(installed, enabled)).toEqual([
      { key: "aaa@m", name: "aaa", marketplace: "m", version: "2.0.0", enabled: true },
      {
        key: "superpowers@claude-plugins-official",
        name: "superpowers",
        marketplace: "claude-plugins-official",
        version: "6.1.1",
        enabled: false,
      },
    ]);
  });
  it("prefers the user-scope record for version", () => {
    const installed = {
      "a@m": [rec({ scope: "project", version: "9.9.9" }), rec({ scope: "user", version: "1.2.3" })],
    };
    expect(mergePluginList(installed, {})[0].version).toBe("1.2.3");
  });
});

describe("toggleEnabledPlugins", () => {
  it("sets only the target key and keeps others, without mutating input", () => {
    const input = { "other@m": true };
    const out = toggleEnabledPlugins(input, "a@m", false);
    expect(out).toEqual({ "other@m": true, "a@m": false });
    expect(input).toEqual({ "other@m": true });
  });
});

describe("extractInstalledPlugins / extractEnabledPlugins", () => {
  it("extracts the plugins map", () => {
    const raw = JSON.stringify({ version: 2, plugins: { "a@m": [rec()] } });
    expect(Object.keys(extractInstalledPlugins(raw))).toEqual(["a@m"]);
  });
  it("extracts the enabledPlugins map", () => {
    expect(extractEnabledPlugins(JSON.stringify({ enabledPlugins: { "a@m": false } }))).toEqual({
      "a@m": false,
    });
  });
  it("returns empty objects for empty/invalid json", () => {
    expect(extractInstalledPlugins("{}")).toEqual({});
    expect(extractEnabledPlugins("not json")).toEqual({});
  });
});

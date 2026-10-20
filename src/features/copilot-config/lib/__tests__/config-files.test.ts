import { describe, expect, it } from "vitest";
import { parseMcpServers, readSettingsList, removeMcpServer, setSettingsListEntry, upsertMcpServer } from "../config-files";

const CONFIG = JSON.stringify({
  mcpServers: {
    t1: { tools: ["*"], timeout: 5000, type: "local", command: "npx", args: ["-y", "some-mcp"], env: { TOKEN: "abc" }, custom: 1 },
    r1: { tools: ["*"], type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
    legacy: { command: "node", args: ["s.js"] },
  },
  other: true,
});

describe("Copilot MCP config", () => {
  it("parses local, remote and untyped (stdio) servers and applies the disabled list", () => {
    const servers = parseMcpServers(CONFIG, ["t1"]);
    expect(servers).toEqual([
      { name: "t1", type: "local", command: "npx", args: ["-y", "some-mcp"], env: { TOKEN: "abc" }, headers: {}, tools: ["*"], timeout: 5000, enabled: false },
      { name: "r1", type: "http", args: [], env: {}, url: "https://example.com/mcp", headers: { Authorization: "Bearer x" }, tools: ["*"], enabled: true },
      { name: "legacy", type: "local", command: "node", args: ["s.js"], env: {}, headers: {}, enabled: true },
    ]);
    expect(parseMcpServers("not json")).toEqual([]);
    expect(parseMcpServers("{}")).toEqual([]);
  });

  it("upserts a server while keeping unknown keys and other content", () => {
    const out = upsertMcpServer(CONFIG, { name: "t1", type: "local", command: "uvx", args: [], env: {}, headers: {}, enabled: true });
    const json = JSON.parse(out);
    expect(json.other).toBe(true);
    expect(json.mcpServers.t1).toEqual({ tools: ["*"], type: "local", command: "uvx", custom: 1 });
    expect(json.mcpServers.r1.url).toBe("https://example.com/mcp");
  });

  it("switching a server to remote drops the local keys, and new servers get the tools filter", () => {
    const out = upsertMcpServer(CONFIG, { name: "t1", type: "sse", args: [], env: {}, url: "https://x/sse", headers: { A: "b" }, timeout: 10, enabled: true });
    expect(JSON.parse(out).mcpServers.t1).toEqual({ tools: ["*"], timeout: 10, type: "sse", url: "https://x/sse", headers: { A: "b" }, custom: 1 });
    const fresh = upsertMcpServer("", { name: "n", type: "local", command: "npx", args: ["-y", "x"], env: { K: "v" }, headers: {}, enabled: true });
    expect(JSON.parse(fresh)).toEqual({ mcpServers: { n: { tools: ["*"], type: "local", command: "npx", args: ["-y", "x"], env: { K: "v" } } } });
  });

  it("removes servers", () => {
    const json = JSON.parse(removeMcpServer(CONFIG, "r1"));
    expect(Object.keys(json.mcpServers)).toEqual(["t1", "legacy"]);
    expect(JSON.parse(removeMcpServer("{}", "x"))).toEqual({});
  });
});

describe("Copilot settings lists", () => {
  it("reads and toggles disabled entries without touching other settings", () => {
    const raw = JSON.stringify({ model: "m", disabledSkills: ["a"] });
    expect(readSettingsList(raw, "disabledSkills")).toEqual(["a"]);
    expect(readSettingsList(raw, "disabledMcpServers")).toEqual([]);
    const disabled = setSettingsListEntry(raw, "disabledMcpServers", "t1", true);
    expect(JSON.parse(disabled)).toEqual({ model: "m", disabledSkills: ["a"], disabledMcpServers: ["t1"] });
    const again = setSettingsListEntry(disabled, "disabledMcpServers", "t1", true);
    expect(JSON.parse(again).disabledMcpServers).toEqual(["t1"]);
    const enabled = setSettingsListEntry(again, "disabledMcpServers", "t1", false);
    expect(JSON.parse(enabled)).toEqual({ model: "m", disabledSkills: ["a"] });
  });
});

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings-store";
import {
  MDIUM_RAG_SERVER_NAME,
  buildMdiumRagServer,
  mdiumRagPermissionFor,
  mdiumRagPermissionForClaude,
  mdiumRagServerFor,
} from "../mdium-rag-mcp";

const ALL_ON = { claude: true, codex: true, copilot: true };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useSettingsStore.setState({ mdiumRagTools: { ...ALL_ON } });
});

describe("permission mappings", () => {
  it("maps AgentPermission", () => {
    expect(mdiumRagPermissionFor("read-only")).toBe("read-only");
    expect(mdiumRagPermissionFor("cli-default")).toBe("ask");
    expect(mdiumRagPermissionFor("full-access")).toBe("auto");
  });

  it("maps ClaudePermissionMode", () => {
    expect(mdiumRagPermissionForClaude("plan")).toBe("read-only");
    expect(mdiumRagPermissionForClaude("bypassPermissions")).toBe("auto");
    expect(mdiumRagPermissionForClaude("default")).toBe("ask");
    expect(mdiumRagPermissionForClaude("acceptEdits")).toBe("ask");
  });
});

describe("buildMdiumRagServer", () => {
  it("uses a backslash separator for Windows paths", () => {
    expect(buildMdiumRagServer("C:\\app\\mcp-servers", "ask")).toEqual({
      command: "node",
      args: ["C:\\app\\mcp-servers\\mdium-rag\\dist\\index.js"],
      env: { MDIUM_RAG_PERMISSION: "ask" },
    });
  });

  it("uses a forward slash for POSIX paths", () => {
    expect(buildMdiumRagServer("/opt/mcp-servers", "auto").args).toEqual([
      "/opt/mcp-servers/mdium-rag/dist/index.js",
    ]);
  });
});

describe("mdiumRagServerFor", () => {
  it("returns the server keyed by name when enabled", async () => {
    vi.mocked(invoke).mockResolvedValue("C:\\app\\mcp-servers");
    const res = await mdiumRagServerFor("claude", "read-only");
    expect(invoke).toHaveBeenCalledWith("resolve_mcp_servers_path");
    expect(res).toEqual({
      [MDIUM_RAG_SERVER_NAME]: buildMdiumRagServer("C:\\app\\mcp-servers", "read-only"),
    });
  });

  it("returns undefined without resolving when the toggle is off", async () => {
    useSettingsStore.setState({ mdiumRagTools: { ...ALL_ON, codex: false } });
    expect(await mdiumRagServerFor("codex", "ask")).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("warns once and returns undefined when resolve fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("nope"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await mdiumRagServerFor("copilot", "ask")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

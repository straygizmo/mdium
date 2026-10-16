import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { removeLegacyVbaMcpServer } from "../legacy-cleanup";

function configWith(mcp: Record<string, unknown>) {
  return JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp });
}

describe("removeLegacyVbaMcpServer", () => {
  let written: string | null;
  beforeEach(() => {
    written = null;
    invoke.mockReset();
  });

  function mockConfig(text: string) {
    invoke.mockImplementation(async (cmd: string, args: { content?: string }) => {
      if (cmd === "get_home_dir") return "C:/Users/u";
      if (cmd === "read_text_file") return text;
      if (cmd === "write_text_file_with_dirs") {
        written = args.content ?? null;
        return null;
      }
      return null;
    });
  }

  it("removes the mdium-vba entry and keeps the others", async () => {
    mockConfig(configWith({
      "mdium-vba": { type: "local", command: ["node", "x"], enabled: true },
      "mdium-docs": { type: "local", command: ["node", "y"], enabled: true },
    }));
    expect(await removeLegacyVbaMcpServer()).toBe(true);
    const saved = JSON.parse(written!);
    expect(saved.mcp["mdium-vba"]).toBeUndefined();
    expect(saved.mcp["mdium-docs"]).toEqual({ type: "local", command: ["node", "y"], enabled: true });
    expect(saved.$schema).toBe("https://opencode.ai/config.json");
  });

  it("does not rewrite the config when there is no mdium-vba entry", async () => {
    mockConfig(configWith({ "mdium-docs": { type: "local", command: ["node", "y"], enabled: true } }));
    expect(await removeLegacyVbaMcpServer()).toBe(false);
    expect(written).toBeNull();
  });
});

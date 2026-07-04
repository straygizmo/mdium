import { describe, it, expect } from "vitest";
import { resolveClaudeExecutable, type ResolveDeps } from "../resolve-claude";

function deps(overrides: Partial<ResolveDeps>): ResolveDeps {
  return {
    platform: "win32",
    whichClaude: async () => [],
    exists: () => false,
    homeDir: "C:\\Users\\me",
    ...overrides,
  };
}

describe("resolveClaudeExecutable", () => {
  it("returns a native exe from PATH as-is", async () => {
    const r = await resolveClaudeExecutable(deps({
      whichClaude: async () => ["C:\\Users\\me\\.local\\bin\\claude.exe"],
    }));
    expect(r).toEqual({ executablePath: "C:\\Users\\me\\.local\\bin\\claude.exe" });
  });

  it("derives cli.js from an npm .cmd shim and sets executable=node", async () => {
    const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd";
    const cliJs =
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const r = await resolveClaudeExecutable(deps({
      whichClaude: async () => [shim],
      exists: (p) => p === cliJs,
    }));
    expect(r).toEqual({ executablePath: cliJs, executable: "node" });
  });

  it("falls back to ~/.local/bin/claude.exe when PATH lookup fails", async () => {
    const fallback = "C:\\Users\\me\\.local\\bin\\claude.exe";
    const r = await resolveClaudeExecutable(deps({
      whichClaude: async () => { throw new Error("not found"); },
      exists: (p) => p === fallback,
    }));
    expect(r).toEqual({ executablePath: fallback });
  });

  it("returns null when nothing is found", async () => {
    const r = await resolveClaudeExecutable(deps({}));
    expect(r).toBeNull();
  });
});

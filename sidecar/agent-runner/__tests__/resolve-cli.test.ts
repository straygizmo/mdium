import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { resolveCodexPath, resolveCopilotPath, type ResolveCliDeps } from "../resolve-cli";

const npm = "C:\\Users\\me\\AppData\\Roaming\\npm";

function deps(overrides: Partial<ResolveCliDeps>): ResolveCliDeps {
  return {
    platform: "win32",
    arch: "x64",
    env: {},
    which: async () => [],
    exists: () => false,
    ...overrides,
  };
}

describe("resolveCodexPath", () => {
  it("prefers MDIUM_CODEX_PATH", async () => {
    expect(await resolveCodexPath(deps({ env: { MDIUM_CODEX_PATH: "D:\\codex.exe" } }))).toBe("D:\\codex.exe");
  });

  it("returns a native codex.exe found on PATH", async () => {
    const exe = "C:\\tools\\codex.exe";
    expect(await resolveCodexPath(deps({ which: async () => [exe] }))).toBe(exe);
  });

  it("derives the nested platform binary from an npm shim", async () => {
    const nested = path.join(npm, "node_modules", "@openai", "codex", "node_modules", "@openai",
      "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    const result = await resolveCodexPath(deps({
      which: async () => [path.join(npm, "codex"), path.join(npm, "codex.cmd")],
      exists: (p) => p === nested,
    }));
    expect(result).toBe(nested);
  });

  it("derives a hoisted legacy-layout arm64 binary", async () => {
    const hoisted = path.join(npm, "node_modules", "@openai", "codex-win32-arm64", "vendor",
      "aarch64-pc-windows-msvc", "codex", "codex.exe");
    const result = await resolveCodexPath(deps({
      arch: "arm64",
      which: async () => [path.join(npm, "codex.cmd")],
      exists: (p) => p === hoisted,
    }));
    expect(result).toBe(hoisted);
  });

  it("returns the PATH entry as-is on non-Windows", async () => {
    expect(await resolveCodexPath(deps({ platform: "darwin", which: async () => ["/usr/local/bin/codex"] })))
      .toBe("/usr/local/bin/codex");
  });

  it("returns null when nothing usable is found", async () => {
    expect(await resolveCodexPath(deps({ which: async () => { throw new Error("none"); } }))).toBeNull();
  });
});

describe("resolveCopilotPath", () => {
  it("prefers COPILOT_CLI_PATH", async () => {
    expect(await resolveCopilotPath(deps({ env: { COPILOT_CLI_PATH: "D:\\copilot\\index.js" } }))).toBe("D:\\copilot\\index.js");
  });

  it("derives npm-loader.js from an npm shim", async () => {
    const loader = path.join(npm, "node_modules", "@github", "copilot", "npm-loader.js");
    const result = await resolveCopilotPath(deps({
      which: async () => [path.join(npm, "copilot.cmd")],
      exists: (p) => p === loader,
    }));
    expect(result).toBe(loader);
  });

  it("returns a native copilot.exe as-is", async () => {
    const exe = "C:\\tools\\copilot.exe";
    expect(await resolveCopilotPath(deps({ which: async () => [exe] }))).toBe(exe);
  });

  it("skips shims it cannot map and returns null", async () => {
    expect(await resolveCopilotPath(deps({ which: async () => ["C:\\x\\copilot.bat"] }))).toBeNull();
  });
});

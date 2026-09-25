import { describe, expect, it } from "vitest";
import { codexSandbox, copilotDecision, toolRequestFromCopilot } from "../permissions";

describe("codexSandbox", () => {
  it("maps modes to Codex sandbox values", () => {
    expect(codexSandbox("cli-default")).toBeUndefined();
    expect(codexSandbox("read-only")).toBe("read-only");
    expect(codexSandbox("full-access")).toBe("danger-full-access");
  });
});

describe("toolRequestFromCopilot", () => {
  it("normalizes known request kinds", () => {
    expect(toolRequestFromCopilot({ kind: "shell", fullCommandText: "npm test" })).toEqual({ kind: "shell", summary: "npm test", rawKind: "shell" });
    expect(toolRequestFromCopilot({ kind: "write", fileName: "src/a.ts" })).toEqual({ kind: "write", summary: "src/a.ts", rawKind: "write" });
    expect(toolRequestFromCopilot({ kind: "read", path: "README.md" })).toEqual({ kind: "read", summary: "README.md", rawKind: "read" });
    expect(toolRequestFromCopilot({ kind: "url", url: "https://x.test" })).toEqual({ kind: "network", summary: "https://x.test", rawKind: "url" });
    expect(toolRequestFromCopilot({ kind: "mcp", serverName: "fs", toolName: "list" })).toEqual({ kind: "other", summary: "fs/list", rawKind: "mcp" });
    expect(toolRequestFromCopilot({ kind: "mcp", serverName: "fs" })).toEqual({ kind: "other", summary: "fs", rawKind: "mcp" });
    expect(toolRequestFromCopilot({ kind: "memory" })).toEqual({ kind: "other", summary: "memory", rawKind: "memory" });
  });
});

describe("copilotDecision", () => {
  const read = { kind: "read" as const, summary: "a" };
  const shell = { kind: "shell" as const, summary: "rm -rf x" };
  it("read-only approves reads and rejects everything else", () => {
    expect(copilotDecision("read-only", read)).toBe("approve");
    expect(copilotDecision("read-only", shell)).toBe("reject");
  });
  it("full-access approves everything", () => {
    expect(copilotDecision("full-access", shell)).toBe("approve");
    expect(copilotDecision("full-access", toolRequestFromCopilot({ kind: "shell", fullCommandText: "ls" }))).toBe("approve");
  });
  it("full-access rejects extension, factory, custom-tool, and hook requests", () => {
    for (const kind of ["extension-management", "extension-permission-access", "extension-env-access", "factory", "custom-tool", "hook"]) {
      expect(copilotDecision("full-access", toolRequestFromCopilot({ kind }))).toBe("reject");
    }
  });
  it("keeps the Copilot request kind as rawKind", () => {
    expect(toolRequestFromCopilot({ kind: "hook" }).rawKind).toBe("hook");
  });
  it("cli-default asks the user for everything, including reads", () => {
    expect(copilotDecision("cli-default", read)).toBe("ask");
    expect(copilotDecision("cli-default", shell)).toBe("ask");
  });
});

import { describe, expect, it } from "vitest";
import { claudeDecision, codexSandbox, copilotDecision, toolRequestFromClaude, toolRequestFromCopilot } from "../permissions";

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

describe("toolRequestFromClaude", () => {
  it.each([
    ["Bash", { command: "npm test" }, { kind: "shell", summary: "npm test" }],
    ["Write", { file_path: "a.ts" }, { kind: "write", summary: "a.ts" }],
    ["Edit", { file_path: "b.ts" }, { kind: "write", summary: "b.ts" }],
    ["NotebookEdit", { notebook_path: "n.ipynb" }, { kind: "write", summary: "n.ipynb" }],
    ["Read", { file_path: "README.md" }, { kind: "read", summary: "README.md" }],
    ["Grep", { pattern: "foo", path: "src" }, { kind: "read", summary: "src" }],
    ["Grep", { pattern: "foo" }, { kind: "read", summary: "foo" }],
    ["Glob", { pattern: "**/*.ts" }, { kind: "read", summary: "**/*.ts" }],
    ["Glob", {}, { kind: "read", summary: "Glob" }],
    ["WebFetch", { url: "https://x.test" }, { kind: "network", summary: "https://x.test" }],
    ["WebSearch", { query: "vitest" }, { kind: "network", summary: "vitest" }],
    ["TodoWrite", { todos: [] }, { kind: "read", summary: "TodoWrite" }],
    ["Agent", { prompt: "x" }, { kind: "other", summary: "Agent" }],
    ["mcp__fs__list", {}, { kind: "other", summary: "mcp__fs__list" }],
  ] as const)("maps %s", (toolName, input, expected) => {
    expect(toolRequestFromClaude(toolName, input as Record<string, unknown>)).toEqual({ ...expected, rawKind: toolName });
  });
});

describe("claudeDecision", () => {
  const req = (toolName: string, input: Record<string, unknown> = {}) => toolRequestFromClaude(toolName, input);
  it("read-only allows reads and WebSearch and denies everything else", () => {
    expect(claudeDecision("read-only", req("Read", { file_path: "a" }))).toBe("allow");
    expect(claudeDecision("read-only", req("TodoWrite"))).toBe("allow");
    expect(claudeDecision("read-only", req("WebSearch", { query: "q" }))).toBe("allow");
    expect(claudeDecision("read-only", req("WebFetch", { url: "https://x.test" }))).toBe("deny");
    expect(claudeDecision("read-only", req("Bash", { command: "ls" }))).toBe("deny");
    expect(claudeDecision("read-only", req("Write", { file_path: "a" }))).toBe("deny");
    expect(claudeDecision("read-only", req("Agent"))).toBe("deny");
  });
  it("full-access allows everything", () => {
    for (const tool of ["Read", "Bash", "Write", "WebFetch", "Agent"]) {
      expect(claudeDecision("full-access", req(tool))).toBe("allow");
    }
  });
  it("cli-default allows reads and asks for everything else", () => {
    expect(claudeDecision("cli-default", req("Read", { file_path: "a" }))).toBe("allow");
    for (const tool of ["Bash", "Write", "WebFetch", "WebSearch", "Agent"]) {
      expect(claudeDecision("cli-default", req(tool))).toBe("ask");
    }
  });
});

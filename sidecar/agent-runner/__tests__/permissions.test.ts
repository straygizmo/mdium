import { describe, expect, it } from "vitest";
import { claudeDecision, claudeDisallowedTools, claudeHookDecision, codexSandbox, copilotDecision, toolRequestFromClaude, toolRequestFromCopilot } from "../permissions";

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
    ["Read", {}, { kind: "read", summary: "Read" }],
    ["Grep", { pattern: "foo", path: "src" }, { kind: "read", summary: "src" }],
    // The search pattern is never treated as a path (e.g. a ".env" pattern).
    ["Grep", { pattern: ".env" }, { kind: "read", summary: "." }],
    ["Glob", { pattern: "**/.env*" }, { kind: "read", summary: "." }],
    ["Glob", { pattern: "*.ts", path: "C:/x" }, { kind: "read", summary: "C:/x" }],
    ["PowerShell", { command: "Get-ChildItem" }, { kind: "shell", summary: "Get-ChildItem" }],
    ["Monitor", { command: "npm run dev" }, { kind: "shell", summary: "npm run dev" }],
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

describe("claudeHookDecision", () => {
  const req = (toolName: string, input: Record<string, unknown> = {}) => toolRequestFromClaude(toolName, input);
  const opaque = ["REPL", "RemoteTrigger", "CronCreate", "CronDelete", "Workflow", "mcp__fs__write", "mcp__x__y"];
  it.each(opaque)("denies the non-inspectable tool %s in guarded or read-only sessions", (tool) => {
    expect(claudeHookDecision("full-access", true, req(tool))).toBe("deny");
    expect(claudeHookDecision("cli-default", true, req(tool))).toBe("deny");
    expect(claudeHookDecision("read-only", false, req(tool))).toBe("deny");
  });
  it.each(opaque)("leaves %s to canUseTool in unguarded sessions", (tool) => {
    expect(claudeHookDecision("full-access", false, req(tool))).toBe("none");
    expect(claudeHookDecision("cli-default", false, req(tool))).toBe("none");
  });
  it("denies what read-only denies and has no opinion otherwise", () => {
    expect(claudeHookDecision("read-only", false, req("Write", { file_path: "a" }))).toBe("deny");
    expect(claudeHookDecision("read-only", false, req("Bash", { command: "ls" }))).toBe("deny");
    expect(claudeHookDecision("read-only", false, req("Read", { file_path: "a" }))).toBe("none");
    expect(claudeHookDecision("full-access", true, req("Bash", { command: "ls" }))).toBe("none");
    expect(claudeHookDecision("cli-default", true, req("Write", { file_path: "a" }))).toBe("none");
  });
});

describe("claudeDisallowedTools", () => {
  it("lists the non-inspectable built-in tools for guarded or read-only sessions only", () => {
    const tools = ["REPL", "RemoteTrigger", "CronCreate", "CronDelete", "Workflow"];
    expect(claudeDisallowedTools("full-access", true)).toEqual(tools);
    expect(claudeDisallowedTools("read-only", false)).toEqual(tools);
    expect(claudeDisallowedTools("cli-default", false)).toEqual([]);
    expect(claudeDisallowedTools("full-access", false)).toEqual([]);
  });
});

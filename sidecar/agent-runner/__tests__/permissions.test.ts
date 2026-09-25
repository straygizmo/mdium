import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkToolRequest } from "../guard";
import {
  claudeDecision,
  claudeDisallowedTools,
  claudeHookDecision,
  codexSandbox,
  copilotDecision,
  opencodeDecision,
  opencodeServerConfig,
  toolRequestFromClaude,
  toolRequestFromCopilot,
  toolRequestFromOpencode,
  toolRequestsFromOpencode,
} from "../permissions";

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
    expect(toolRequestFromCopilot({ kind: "mcp", serverName: "fs", toolName: "list" })).toEqual({ kind: "other", summary: "fs/list", rawKind: "mcp", opaque: true });
    expect(toolRequestFromCopilot({ kind: "mcp", serverName: "fs" })).toEqual({ kind: "other", summary: "fs", rawKind: "mcp", opaque: true });
    expect(toolRequestFromCopilot({ kind: "memory" })).toEqual({ kind: "other", summary: "memory", rawKind: "memory", opaque: true });
  });
  it("marks every other-kind request (MCP, memory, extensions, unknown kinds) opaque", () => {
    for (const kind of ["mcp", "memory", "extension-management", "extension-permission-access", "extension-env-access", "factory", "custom-tool", "hook", "future-kind"]) {
      expect(toolRequestFromCopilot({ kind }).opaque, kind).toBe(true);
    }
    for (const kind of ["shell", "write", "read", "url"]) {
      expect(toolRequestFromCopilot({ kind, fullCommandText: "ls", fileName: "a", path: "a", url: "https://x.test" }).opaque, kind).toBeUndefined();
    }
  });
});

describe("shell requests without command text", () => {
  const ctx = { workspaceRoot: "C:\\w", homeDir: "C:\\Users\\me", platform: "win32" as const };
  it("marks a Copilot shell request without fullCommandText opaque, so the guard blocks it", () => {
    const request = toolRequestFromCopilot({ kind: "shell", intention: "List files" });
    expect(request).toEqual({ kind: "shell", summary: "List files", rawKind: "shell", opaque: true });
    expect(checkToolRequest(request, ctx)).toEqual({ ok: false, rule: "opaque-tool" });
    // Unguarded sessions still ask with the summary that exists.
    expect(copilotDecision("cli-default", request)).toBe("ask");
    expect(checkToolRequest(toolRequestFromCopilot({ kind: "shell", fullCommandText: "npm test" }), ctx)).toEqual({ ok: true });
  });
  it("marks an opencode bash request without metadata.command opaque, so the guard blocks it", () => {
    const request = toolRequestFromOpencode({ type: "bash", pattern: ["npm test *"] });
    expect(checkToolRequest(request, ctx)).toEqual({ ok: false, rule: "opaque-tool" });
    expect(opencodeDecision("cli-default", request)).toBe("ask");
    expect(checkToolRequest(toolRequestFromOpencode({ type: "bash", metadata: { command: "npm test" } }), ctx)).toEqual({ ok: true });
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
    ["Bash", { command: "npm test" }, { kind: "shell", summary: "npm test", shell: "posix" }],
    ["Write", { file_path: "a.ts" }, { kind: "write", summary: "a.ts" }],
    ["Edit", { file_path: "b.ts" }, { kind: "write", summary: "b.ts" }],
    ["NotebookEdit", { notebook_path: "n.ipynb" }, { kind: "write", summary: "n.ipynb" }],
    ["Read", { file_path: "README.md" }, { kind: "read", summary: "README.md" }],
    ["Read", {}, { kind: "read", summary: "Read" }],
    ["Grep", { pattern: "foo", path: "src" }, { kind: "read", summary: "src" }],
    // A glob filter names the files Grep reads, so it joins the summary.
    ["Grep", { pattern: "x", path: ".", glob: ".env*" }, { kind: "read", summary: "./.env*" }],
    ["Grep", { pattern: "x", glob: "*.ts" }, { kind: "read", summary: "./*.ts" }],
    // The search pattern is never treated as a path (e.g. a ".env" pattern).
    ["Grep", { pattern: ".env" }, { kind: "read", summary: "." }],
    ["Glob", { pattern: "**/.env*" }, { kind: "read", summary: "." }],
    ["Glob", { pattern: "*.ts", path: "C:/x" }, { kind: "read", summary: "C:/x" }],
    ["PowerShell", { command: "Get-ChildItem" }, { kind: "shell", summary: "Get-ChildItem", shell: "powershell" }],
    ["Monitor", { command: "npm run dev" }, { kind: "shell", summary: "npm run dev" }],
    ["WebFetch", { url: "https://x.test" }, { kind: "network", summary: "https://x.test" }],
    ["WebSearch", { query: "vitest" }, { kind: "network", summary: "vitest" }],
    ["TodoWrite", { todos: [] }, { kind: "read", summary: "TodoWrite" }],
    ["Agent", { prompt: "x" }, { kind: "other", summary: "Agent" }],
    ["mcp__fs__list", {}, { kind: "other", summary: "mcp__fs__list", opaque: true }],
    ["REPL", { code: "1" }, { kind: "other", summary: "REPL", opaque: true }],
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
  const opaque = [
    "REPL", "RemoteTrigger", "CronCreate", "CronDelete", "Workflow", "mcp__fs__write", "mcp__x__y",
    "Artifact", "PushNotification", "ScheduleWakeup", "ClaudeDesign", "Projects", "EnterWorktree", "ExitWorktree", "SomeFutureTool",
  ];
  it.each(opaque)("denies the non-inspectable tool %s in guarded or read-only sessions", (tool) => {
    expect(claudeHookDecision("full-access", true, req(tool))).toBe("deny");
    expect(claudeHookDecision("cli-default", true, req(tool))).toBe("deny");
    expect(claudeHookDecision("read-only", false, req(tool))).toBe("deny");
  });
  it.each(opaque)("leaves %s to canUseTool in unguarded sessions", (tool) => {
    expect(claudeHookDecision("full-access", false, req(tool))).toBe("none");
    expect(claudeHookDecision("cli-default", false, req(tool))).toBe("none");
  });
  it.each(["Agent", "Task", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop", "AskUserQuestion", "ExitPlanMode", "TaskOutput"])(
    "allows the allowlisted tool %s in guarded sessions",
    (tool) => {
      expect(claudeHookDecision("full-access", true, req(tool))).toBe("none");
      expect(claudeHookDecision("cli-default", true, req(tool))).toBe("none");
    },
  );
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

describe("toolRequestFromOpencode", () => {
  it.each([
    [{ type: "bash", pattern: ["git push *"], metadata: { command: "git push origin main" } }, { kind: "shell", summary: "git push origin main", shell: "posix" }],
    [{ type: "bash", pattern: ["git status *", "npm test *"] }, { kind: "shell", summary: "git status *\nnpm test *", shell: "posix", opaque: true }],
    [{ type: "bash", pattern: "ls", metadata: {} }, { kind: "shell", summary: "ls", shell: "posix", opaque: true }],
    [{ type: "bash", title: "Run ls" }, { kind: "shell", summary: "Run ls", shell: "posix", opaque: true }],
    [{ type: "edit", pattern: ["src/a.ts"], metadata: { filePath: "C:/w/src/a.ts" } }, { kind: "write", summary: "C:/w/src/a.ts" }],
    [{ type: "edit", pattern: ["src/a.ts"], metadata: { filepath: "C:/w/src/a.ts" } }, { kind: "write", summary: "C:/w/src/a.ts" }],
    [{ type: "write", pattern: "src/b.ts" }, { kind: "write", summary: "src/b.ts" }],
    [{ type: "webfetch", pattern: ["https://a.test"], metadata: { url: "https://b.test" } }, { kind: "network", summary: "https://b.test" }],
    [{ type: "webfetch", pattern: ["https://a.test"] }, { kind: "network", summary: "https://a.test" }],
    [{ type: "websearch", pattern: ["q"], metadata: { query: "vitest docs" } }, { kind: "network", summary: "vitest docs" }],
    // Treated as a write so the guard's outside-workspace rule applies.
    [{ type: "external_directory", pattern: ["C:/x/**"], metadata: { filepath: "C:/x/a.txt", parentDir: "C:/x" } }, { kind: "write", summary: "C:/x/a.txt" }],
    [{ type: "external_directory", metadata: { path: "C:/y" } }, { kind: "write", summary: "C:/y" }],
    [{ type: "external_directory", pattern: ["D:/z/*"], metadata: { command: "ls D:/z" } }, { kind: "write", summary: "D:/z/*" }],
    [{ type: "read", pattern: ["src/a.ts"], metadata: {} }, { kind: "read", summary: "src/a.ts" }],
    // Glob and grep patterns are not paths; the searched directory is.
    [{ type: "glob", pattern: ["**/*.ts"], metadata: { pattern: "**/*.ts", path: "src" } }, { kind: "read", summary: "src" }],
    [{ type: "glob", pattern: ["**/*.ts"], metadata: { pattern: "**/*.ts" } }, { kind: "read", summary: "." }],
    [{ type: "grep", pattern: ["foo"], metadata: { pattern: "foo", path: "src/", include: "*.env" } }, { kind: "read", summary: "src/*.env" }],
    [{ type: "list", pattern: ["docs"] }, { kind: "read", summary: "docs" }],
    [{ type: "todowrite", pattern: ["*"] }, { kind: "read", summary: "todowrite" }],
    [{ type: "skill", pattern: ["review"], title: "Load skill" }, { kind: "other", summary: "Load skill" }],
    [{ type: "doom_loop", pattern: ["bash"] }, { kind: "other", summary: "doom_loop" }],
  ])("normalizes %j", (permission, expected) => {
    expect(toolRequestFromOpencode(permission)).toEqual({ ...expected, rawKind: permission.type });
  });
});

describe("toolRequestsFromOpencode", () => {
  it("splits multi-path writes so the guard sees every path", () => {
    expect(toolRequestsFromOpencode({ type: "edit", pattern: ["a.ts", "b.ts"], metadata: { filepath: "a.ts, b.ts" } })).toEqual([
      { kind: "write", summary: "a.ts", rawKind: "edit" },
      { kind: "write", summary: "b.ts", rawKind: "edit" },
    ]);
    expect(toolRequestsFromOpencode({ type: "external_directory", pattern: ["C:/x/*", "D:/y/*"], metadata: { command: "cp C:/x/a D:/y/" } })).toEqual([
      { kind: "write", summary: "C:/x/*", rawKind: "external_directory" },
      { kind: "write", summary: "D:/y/*", rawKind: "external_directory" },
    ]);
  });
  it("returns the single normalized request otherwise", () => {
    const bash = { type: "bash", pattern: ["git status *", "npm test *"], metadata: { command: "git status && npm test" } };
    expect(toolRequestsFromOpencode(bash)).toEqual([toolRequestFromOpencode(bash)]);
    const edit = { type: "edit", pattern: ["a.ts"], metadata: { filepath: "C:/w/a.ts" } };
    expect(toolRequestsFromOpencode(edit)).toEqual([toolRequestFromOpencode(edit)]);
  });
});

describe("opencodeDecision", () => {
  const read = toolRequestFromOpencode({ type: "read", pattern: ["src/a.ts"] });
  const envRead = toolRequestFromOpencode({ type: "read", pattern: ["config/.env.local"] });
  const edit = toolRequestFromOpencode({ type: "edit", pattern: ["a.ts"] });
  const bash = toolRequestFromOpencode({ type: "bash", metadata: { command: "ls" } });
  const fetch = toolRequestFromOpencode({ type: "webfetch", metadata: { url: "https://a.test" } });
  const skill = toolRequestFromOpencode({ type: "skill", pattern: ["x"] });
  it("read-only approves reads once and rejects everything else", () => {
    expect(opencodeDecision("read-only", read)).toBe("once");
    for (const request of [edit, bash, fetch, skill]) expect(opencodeDecision("read-only", request)).toBe("reject");
  });
  it("full-access approves everything once", () => {
    for (const request of [read, envRead, edit, bash, fetch, skill]) expect(opencodeDecision("full-access", request)).toBe("once");
  });
  it("cli-default approves ordinary reads and asks for env files and everything else", () => {
    expect(opencodeDecision("cli-default", read)).toBe("once");
    expect(opencodeDecision("cli-default", toolRequestFromOpencode({ type: "read", pattern: [".env.example"] }))).toBe("once");
    for (const request of [envRead, edit, bash, fetch, skill]) expect(opencodeDecision("cli-default", request)).toBe("ask");
  });
});

describe("opencode worktree-relative paths", () => {
  const paths = { directory: "C:/repo/docs", worktree: "C:/repo" };
  const win = (...parts: string[]) => path.win32.resolve(...parts);
  const guardCtx = { workspaceRoot: "C:/repo/docs", homeDir: "C:/Users/u", platform: "win32" as const };

  it("resolves read and edit paths against the worktree and search paths against the directory", () => {
    expect(toolRequestFromOpencode({ type: "read", pattern: ["src/a.ts"], metadata: {} }, paths).summary).toBe(win("C:/repo", "src/a.ts"));
    expect(toolRequestFromOpencode({ type: "edit", pattern: ["src/a.ts"], metadata: { filepath: "src/a.ts" } }, paths).summary).toBe(win("C:/repo", "src/a.ts"));
    expect(toolRequestFromOpencode({ type: "glob", metadata: { pattern: "*", path: "sub" } }, paths).summary).toBe(win("C:/repo/docs", "sub"));
    expect(toolRequestFromOpencode({ type: "grep", metadata: { pattern: "x" } }, paths).summary).toBe(win("C:/repo/docs"));
  });

  it("keeps absolute paths", () => {
    expect(toolRequestFromOpencode({ type: "edit", pattern: ["docs/a.md"], metadata: { filepath: "C:\\repo\\docs\\a.md" } }, paths).summary).toBe("C:\\repo\\docs\\a.md");
    expect(toolRequestFromOpencode({ type: "external_directory", pattern: ["D:/x/**"], metadata: { filepath: "D:/x/a" } }, paths).summary).toBe("D:/x/a");
  });

  it("makes every path of a multi-file patch absolute", () => {
    const patch = { type: "edit", pattern: ["src/a.ts", "docs/b.md"], metadata: { filepath: "src/a.ts, docs/b.md" } };
    expect(toolRequestsFromOpencode(patch, paths).map((r) => r.summary)).toEqual([win("C:/repo", "src/a.ts"), win("C:/repo", "docs/b.md")]);
    expect(toolRequestFromOpencode(patch, paths).summary).toBe(win("C:/repo", "src/a.ts"));
  });

  it("lets the guard block a patch outside a workspace that is a repo subfolder", () => {
    const patch = { type: "edit", pattern: ["src/a.ts"], metadata: { filepath: "src/a.ts" } };
    const [request] = toolRequestsFromOpencode(patch, paths);
    expect(checkToolRequest(request, guardCtx)).toEqual({ ok: false, rule: "outside-workspace" });
    const inside = toolRequestsFromOpencode({ type: "edit", pattern: ["docs/b.md"], metadata: { filepath: "docs/b.md" } }, paths);
    expect(checkToolRequest(inside[0], guardCtx)).toEqual({ ok: true });
  });
});

describe("opencode Windows separators", () => {
  it("recognizes env files behind backslashes", () => {
    expect(opencodeDecision("cli-default", toolRequestFromOpencode({ type: "read", pattern: ["config\\.env.local"] }))).toBe("ask");
    expect(opencodeDecision("cli-default", toolRequestFromOpencode({ type: "read", pattern: ["config\\.env.example"] }))).toBe("once");
    expect(opencodeDecision("cli-default", toolRequestFromOpencode({ type: "read", pattern: ["config\\settings.ts"] }))).toBe("once");
  });
  it("trims a trailing backslash before joining a grep include", () => {
    expect(toolRequestFromOpencode({ type: "grep", metadata: { pattern: "x", path: "src\\", include: "*.ts" } }).summary).toBe("src/*.ts");
  });
});

describe("opencodeServerConfig", () => {
  const config = opencodeServerConfig({ readOnly: "mdium-read-only-x", guarded: "mdium-guarded-x", open: "mdium-open-x" });
  it("turns off formatters and language servers server-wide", () => {
    expect(config.formatter).toBe(false);
    expect(config.lsp).toBe(false);
  });
});

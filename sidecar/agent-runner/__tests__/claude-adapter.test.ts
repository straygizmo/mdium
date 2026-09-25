import { describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, type ClaudeQueryOptions, type QueryFn } from "../claude-adapter";
import type { AgentEvent, ToolRequest } from "../../../src/shared/types/agent-runner";
import type { SessionCallbacks, SessionOptions } from "../adapter";
import { checkToolRequest } from "../guard";

type Script = unknown[] | ((options: ClaudeQueryOptions) => AsyncIterable<unknown>);

/** Fake SDK `query`: each call plays the next script and records its params. */
function fakeQuery(...scripts: Script[]) {
  const calls: Array<{ prompt: string; options: ClaudeQueryOptions }> = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const script = scripts[calls.length - 1] ?? [];
    if (typeof script === "function") return script(params.options);
    return (async function* () {
      yield* script;
    })();
  };
  return { query, calls };
}

function adapter(query: QueryFn) {
  return new ClaudeAdapter({ query, resolve: async () => ({ executablePath: "C:/claude/cli.js", executable: "node" }) });
}

const baseOptions: SessionOptions = { workingDirectory: "C:/work", permission: "cli-default", guarded: false };

function callbacks(events: AgentEvent[], overrides: Partial<SessionCallbacks> = {}): SessionCallbacks {
  return {
    onEvent: (e) => events.push(e),
    requestPermission: async () => false,
    checkTool: () => true,
    ...overrides,
  };
}

const success = (result: string, session_id = "s-1") => ({ type: "result", subtype: "success", is_error: false, result, session_id });

const turnScript = [
  { type: "system", subtype: "init", session_id: "s-1" },
  {
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: "s-1",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "He" } },
  },
  {
    type: "assistant",
    parent_tool_use_id: null,
    session_id: "s-1",
    message: {
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
  },
  {
    type: "user",
    parent_tool_use_id: null,
    session_id: "s-1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }] },
  },
  success("Hello"),
];

describe("ClaudeAdapter", () => {
  it("runs a turn, normalizes events, and records the session id", async () => {
    const fake = fakeQuery(turnScript);
    const events: AgentEvent[] = [];
    const session = await adapter(fake.query).startSession({ ...baseOptions, model: "sonnet" }, callbacks(events));
    const final = await session.runTurn("hi", new AbortController().signal);

    expect(final).toBe("Hello");
    expect(events).toEqual([
      { type: "assistant_delta", text: "He" },
      { type: "assistant_message", text: "Hello" },
      { type: "tool_started", toolId: "t1", title: "Bash" },
      { type: "tool_finished", toolId: "t1", ok: true },
    ]);
    expect(session.nativeSessionId()).toBe("s-1");

    const { prompt, options } = fake.calls[0];
    expect(prompt).toBe("hi");
    expect(options).toMatchObject({
      cwd: "C:/work",
      permissionMode: "default",
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      pathToClaudeCodeExecutable: "C:/claude/cli.js",
      executable: "node",
      model: "sonnet",
    });
    expect(options.resume).toBeUndefined();
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(typeof options.canUseTool).toBe("function");
    expect(JSON.stringify(options)).not.toContain("bypassPermissions");
  });

  it("resumes the recorded session on the next turn", async () => {
    const fake = fakeQuery(turnScript, [success("again")]);
    const session = await adapter(fake.query).startSession(baseOptions, callbacks([]));
    await session.runTurn("one", new AbortController().signal);
    await expect(session.runTurn("two", new AbortController().signal)).resolves.toBe("again");
    expect(fake.calls[1].options.resume).toBe("s-1");
  });

  it("resumes the native session given at start", async () => {
    const fake = fakeQuery([success("x", "s-9")]);
    const session = await adapter(fake.query).startSession({ ...baseOptions, resumeNativeId: "s-9" }, callbacks([]));
    expect(session.nativeSessionId()).toBe("s-9");
    await session.runTurn("x", new AbortController().signal);
    expect(fake.calls[0].options.resume).toBe("s-9");
  });

  it("merges env over process.env when env is given", async () => {
    const fake = fakeQuery([success("x")]);
    const session = await adapter(fake.query).startSession({ ...baseOptions, env: { GH_TOKEN: "x" } }, callbacks([]));
    await session.runTurn("x", new AbortController().signal);
    const env = fake.calls[0].options.env ?? {};
    expect(env.GH_TOKEN).toBe("x");
    const inherited = Object.entries(process.env).find(([key, value]) => key !== "GH_TOKEN" && value !== undefined);
    if (!inherited) throw new Error("process.env is empty");
    expect(env[inherited[0]]).toBe(inherited[1]);
  });

  async function canUseToolFor(options: SessionOptions, cb: SessionCallbacks) {
    const fake = fakeQuery([success("x")]);
    const session = await adapter(fake.query).startSession(options, cb);
    await session.runTurn("x", new AbortController().signal);
    const canUseTool = fake.calls[0].options.canUseTool;
    if (!canUseTool) throw new Error("canUseTool missing");
    return canUseTool;
  }

  it("denies and interrupts a tool call the guard blocks", async () => {
    const checkTool = vi.fn((_r: ToolRequest) => false);
    const requestPermission = vi.fn(async () => true);
    const canUseTool = await canUseToolFor({ ...baseOptions, permission: "full-access", guarded: true }, callbacks([], { checkTool, requestPermission }));
    await expect(canUseTool("Bash", { command: "git push" })).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(checkTool).toHaveBeenCalledWith({ kind: "shell", summary: "git push", rawKind: "Bash", shell: "posix" });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("applies read-only decisions without asking the user", async () => {
    const requestPermission = vi.fn(async () => true);
    const canUseTool = await canUseToolFor({ ...baseOptions, permission: "read-only" }, callbacks([], { requestPermission }));
    await expect(canUseTool("Write", { file_path: "a" })).resolves.toMatchObject({ behavior: "deny" });
    await expect(canUseTool("Read", { file_path: "a" })).resolves.toEqual({ behavior: "allow", updatedInput: { file_path: "a" } });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("asks the user under cli-default", async () => {
    const requestPermission = vi.fn(async (r: ToolRequest) => r.summary === "npm test");
    const canUseTool = await canUseToolFor(baseOptions, callbacks([], { requestPermission }));
    await expect(canUseTool("Bash", { command: "npm test" })).resolves.toMatchObject({ behavior: "allow" });
    await expect(canUseTool("Bash", { command: "rm x" })).resolves.toMatchObject({ behavior: "deny" });
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });

  async function hookFor(options: SessionOptions, cb: SessionCallbacks) {
    const fake = fakeQuery([success("x")]);
    const session = await adapter(fake.query).startSession(options, cb);
    await session.runTurn("x", new AbortController().signal);
    const hook = fake.calls[0].options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error("PreToolUse hook missing");
    return {
      options: fake.calls[0].options,
      run: (tool_name: string, tool_input: Record<string, unknown>) =>
        hook(
          { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "u1", session_id: "s-1", transcript_path: "t", cwd: "C:/work" },
          "u1",
          { signal: new AbortController().signal },
        ),
    };
  }

  it("denies and stops the turn in the PreToolUse hook when the guard blocks", async () => {
    const checkTool = vi.fn((r: ToolRequest) => r.summary !== "git push");
    const { run } = await hookFor({ ...baseOptions, permission: "full-access", guarded: true }, callbacks([], { checkTool }));
    await expect(run("Bash", { command: "git push" })).resolves.toEqual({
      continue: false,
      stopReason: "Blocked by MDium safety guard",
      reason: "Blocked by MDium safety guard",
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Blocked by MDium safety guard" },
    });
    expect(checkTool).toHaveBeenCalledWith({ kind: "shell", summary: "git push", rawKind: "Bash", shell: "posix" });
    await expect(run("Bash", { command: "npm test" })).resolves.toEqual({});
  });

  it("denies read-only violations in the PreToolUse hook and has no opinion on allowed tools", async () => {
    const { run } = await hookFor({ ...baseOptions, permission: "read-only" }, callbacks([]));
    await expect(run("Write", { file_path: "a" })).resolves.toEqual({
      reason: "Not permitted in this stage",
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Not permitted in this stage" },
    });
    await expect(run("Read", { file_path: "a" })).resolves.toEqual({});
  });

  it("denies non-inspectable tools in guarded sessions and disallows them", async () => {
    const { run, options } = await hookFor({ ...baseOptions, permission: "full-access", guarded: true }, callbacks([]));
    await expect(run("mcp__fs__write", {})).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(run("REPL", { code: "1" })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(options.disallowedTools).toEqual(["REPL", "RemoteTrigger", "CronCreate", "CronDelete", "Workflow"]);
  });

  it("reports non-inspectable tools of a guarded session to the guard, which blocks them as opaque-tool", async () => {
    const ctx = { workspaceRoot: "C:/work", homeDir: "C:/Users/u", platform: "win32" as const };
    const rules: string[] = [];
    const checkTool = vi.fn((r: ToolRequest) => {
      const verdict = checkToolRequest(r, ctx);
      if (!verdict.ok) rules.push(verdict.rule);
      return verdict.ok;
    });
    const { run } = await hookFor({ ...baseOptions, permission: "full-access", guarded: true }, callbacks([], { checkTool }));
    await expect(run("mcp__fs__write", {})).resolves.toMatchObject({ continue: false, hookSpecificOutput: { permissionDecision: "deny" } });
    expect(checkTool).toHaveBeenCalledWith({ kind: "other", summary: "mcp__fs__write", rawKind: "mcp__fs__write", opaque: true });
    await expect(run("Agent", { prompt: "x" })).resolves.toEqual({});
    expect(rules).toEqual(["opaque-tool"]);
    const canUseTool = await canUseToolFor({ ...baseOptions, permission: "full-access", guarded: true }, callbacks([], { checkTool }));
    await expect(canUseTool("mcp__x", {})).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(rules).toEqual(["opaque-tool", "opaque-tool"]);
  });

  it("does not restrict tools in unguarded cli-default sessions", async () => {
    const { run, options } = await hookFor(baseOptions, callbacks([]));
    await expect(run("mcp__fs__write", {})).resolves.toEqual({});
    expect(options.disallowedTools).toBeUndefined();
    expect(options.managedSettings).toBeUndefined();
  });

  it.each([
    [{ permission: "full-access", guarded: true }],
    [{ permission: "cli-default", guarded: true }],
    [{ permission: "read-only", guarded: false }],
  ] as const)("ignores settings hooks and permission rules in %o sessions", async (mode) => {
    const { options } = await hookFor({ ...baseOptions, ...mode }, callbacks([]));
    expect(options.managedSettings).toEqual({ allowManagedHooksOnly: true, allowManagedPermissionRulesOnly: true });
  });

  it.each([
    [{ permission: "full-access", guarded: true }],
    [{ permission: "cli-default", guarded: true }],
    [{ permission: "read-only", guarded: false }],
  ] as const)("loads no MCP servers in %o sessions", async (mode) => {
    const { options } = await hookFor({ ...baseOptions, ...mode }, callbacks([]));
    expect(options.strictMcpConfig).toBe(true);
    expect((options as Record<string, unknown>).mcpServers).toBeUndefined();
  });

  it("keeps the user's MCP configuration in unrestricted sessions", async () => {
    const { options } = await hookFor({ ...baseOptions, permission: "full-access" }, callbacks([]));
    expect(options.strictMcpConfig).toBeUndefined();
  });

  it("guards the files a Grep glob reads", async () => {
    const ctx = { workspaceRoot: "C:/work", homeDir: "C:/Users/u", platform: "win32" as const };
    const checkTool = (r: ToolRequest) => checkToolRequest(r, ctx).ok;
    const { run } = await hookFor({ ...baseOptions, permission: "full-access", guarded: true }, callbacks([], { checkTool }));
    await expect(run("Grep", { pattern: "KEY", path: ".", glob: ".env*" })).resolves.toMatchObject({ continue: false });
    await expect(run("Grep", { pattern: "KEY", path: ".", glob: "*.ts" })).resolves.toEqual({});
  });

  it("denies an MCP tool in the canUseTool fallback of a guarded session", async () => {
    const canUseTool = await canUseToolFor({ ...baseOptions, permission: "full-access", guarded: true }, callbacks([]));
    await expect(canUseTool("mcp__x", {})).resolves.toMatchObject({ behavior: "deny" });
  });

  it("rejects with the result subtype when the turn fails", async () => {
    const fake = fakeQuery([{ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s-1" }]);
    const session = await adapter(fake.query).startSession(baseOptions, callbacks([]));
    await expect(session.runTurn("x", new AbortController().signal)).rejects.toThrow(/^CLAUDE_FAILED: error_max_turns$/);
  });

  it("rejects when a success result is flagged as an error", async () => {
    const fake = fakeQuery([{ type: "result", subtype: "success", is_error: true, result: "Invalid API key", session_id: "s-1" }]);
    const session = await adapter(fake.query).startSession(baseOptions, callbacks([]));
    await expect(session.runTurn("x", new AbortController().signal)).rejects.toThrow(/^CLAUDE_FAILED: Invalid API key$/);
  });

  it("includes the reported errors of a failed result", async () => {
    const fake = fakeQuery([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], session_id: "s-1" }]);
    const session = await adapter(fake.query).startSession(baseOptions, callbacks([]));
    await expect(session.runTurn("x", new AbortController().signal)).rejects.toThrow(/^CLAUDE_FAILED: error_during_execution: boom$/);
  });

  it("rejects when the stream ends without a result", async () => {
    const fake = fakeQuery([{ type: "system", subtype: "init", session_id: "s-1" }]);
    const session = await adapter(fake.query).startSession(baseOptions, callbacks([]));
    await expect(session.runTurn("x", new AbortController().signal)).rejects.toThrow("CLAUDE_NO_RESULT");
  });

  it("rejects with AbortError and aborts the query when the signal is aborted", async () => {
    // A stream that never ends on its own.
    const fake = fakeQuery(() =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s-1" };
        await new Promise(() => undefined);
      })(),
    );
    const controller = new AbortController();
    const session = await adapter(fake.query).startSession(baseOptions, callbacks([], { onEvent: () => undefined }));
    const turn = session.runTurn("x", controller.signal);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.calls[0].options.abortController?.signal.aborted).toBe(true);
  });

  it("does not emit sub-agent output", async () => {
    const fake = fakeQuery([
      {
        type: "stream_event",
        parent_tool_use_id: "task-1",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub" } },
      },
      {
        type: "assistant",
        parent_tool_use_id: "task-1",
        message: { content: [{ type: "text", text: "sub text" }, { type: "tool_use", id: "t9", name: "Read", input: {} }] },
      },
      {
        type: "user",
        parent_tool_use_id: "task-1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", is_error: false }] },
      },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "main" }] } },
      success("main"),
    ]);
    const events: AgentEvent[] = [];
    const session = await adapter(fake.query).startSession(baseOptions, callbacks(events));
    await session.runTurn("x", new AbortController().signal);
    expect(events).toEqual([{ type: "assistant_message", text: "main" }]);
  });

  it("reports a failed tool result", async () => {
    const fake = fakeQuery([
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } },
      success(""),
    ]);
    const events: AgentEvent[] = [];
    const session = await adapter(fake.query).startSession(baseOptions, callbacks(events));
    await session.runTurn("x", new AbortController().signal);
    expect(events).toContainEqual({ type: "tool_finished", toolId: "t1", ok: false });
  });

  it("refuses to start when Claude cannot be resolved", async () => {
    const a = new ClaudeAdapter({ query: fakeQuery().query, resolve: async () => null });
    await expect(a.startSession(baseOptions, callbacks([]))).rejects.toThrow("CLAUDE_NOT_FOUND");
  });

  describe("probe", () => {
    it("reports missing when Claude cannot be resolved", async () => {
      const run = vi.fn();
      const a = new ClaudeAdapter({ query: fakeQuery().query, resolve: async () => null, run });
      await expect(a.probe()).resolves.toEqual({ kind: "missing", detail: "claude" });
      expect(run).not.toHaveBeenCalled();
    });

    it("runs a JS entry with node and parses the version", async () => {
      const run = vi.fn(async () => ({ status: 0, stdout: "2.3.4 (Claude Code)\n", stderr: "" }));
      const a = new ClaudeAdapter({ query: fakeQuery().query, resolve: async () => ({ executablePath: "C:/c/cli.js", executable: "node" }), run });
      await expect(a.probe()).resolves.toEqual({ kind: "available", version: "2.3.4" });
      expect(run).toHaveBeenCalledWith("node", ["C:/c/cli.js", "--version"]);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("reports node missing when a JS entry cannot be run by name", async () => {
      const run = vi.fn(async (command: string) =>
        command === "node"
          ? { status: null, stdout: "", stderr: "", error: Object.assign(new Error("x"), { code: "ENOENT" }) }
          : { status: 0, stdout: "2.3.4", stderr: "" },
      );
      const a = new ClaudeAdapter({ query: fakeQuery().query, resolve: async () => ({ executablePath: "C:/c/cli.js", executable: "node" }), run });
      await expect(a.probe()).resolves.toEqual({ kind: "missing", detail: "node" });
    });

    it("runs a native binary directly", async () => {
      const run = vi.fn(async () => ({ status: 0, stdout: "2.3.4 (Claude Code)", stderr: "" }));
      const a = new ClaudeAdapter({ query: fakeQuery().query, resolve: async () => ({ executablePath: "C:/c/claude.exe" }), run });
      await expect(a.probe()).resolves.toEqual({ kind: "available", version: "2.3.4" });
      expect(run).toHaveBeenCalledWith("C:/c/claude.exe", ["--version"]);
    });

    it("reports spawn and version errors", async () => {
      const spawnFail = vi.fn(async () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("x"), { code: "EACCES" }) }));
      const a = new ClaudeAdapter({ query: fakeQuery().query, resolve: async () => ({ executablePath: "C:/c/claude.exe" }), run: spawnFail });
      await expect(a.probe()).resolves.toEqual({ kind: "error", detail: "spawn" });
      const garbage = vi.fn(async () => ({ status: 0, stdout: "nope", stderr: "" }));
      const b = new ClaudeAdapter({ query: fakeQuery().query, resolve: async () => ({ executablePath: "C:/c/claude.exe" }), run: garbage });
      await expect(b.probe()).resolves.toEqual({ kind: "error", detail: "version" });
    });
  });
});

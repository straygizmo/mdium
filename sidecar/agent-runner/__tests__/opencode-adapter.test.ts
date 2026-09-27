import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { OpencodeAdapter, startDedicatedServer, type OpencodeClientLike, type OpencodeClientOptions } from "../opencode-adapter";
import { opencodeServerConfig } from "../permissions";
import { checkToolRequest } from "../guard";
import type { AgentEvent, ToolRequest } from "../../../src/shared/types/agent-runner";
import type { SessionCallbacks, SessionOptions } from "../adapter";

type RawEvent = { type: string; properties: Record<string, unknown> };

/** Async event queue backing a fake SSE stream; each subscription starts with server.connected. */
class EventQueue {
  private readonly items: RawEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(...events: RawEvent[]): void {
    this.items.push(...events);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *stream(signal: AbortSignal): AsyncGenerator<RawEvent> {
    this.items.unshift({ type: "server.connected", properties: {} });
    const onAbort = () => this.wake?.();
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        if (signal.aborted) return;
        const next = this.items.shift();
        if (next) {
          yield next;
          continue;
        }
        if (this.ended) return;
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = undefined;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function fakeClient(paths = { directory: "C:/work", worktree: "C:/work" }) {
  const queue = new EventQueue();
  const subscribeSignals: AbortSignal[] = [];
  const client = {
    path: { get: vi.fn(async (_options: unknown) => ({ data: { ...paths, home: "C:/Users/u", state: "s", config: "c" } })) },
    session: {
      create: vi.fn(async (_options: unknown) => ({ data: { id: "ses_1" } })),
      promptAsync: vi.fn(async (_options: unknown) => ({ data: undefined })),
      abort: vi.fn(async (_options: unknown) => ({ data: true })),
    },
    event: {
      subscribe: vi.fn(async (options: { signal: AbortSignal }) => {
        subscribeSignals.push(options.signal);
        return { stream: queue.stream(options.signal) };
      }),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async (_options: unknown) => ({ data: true })),
  };
  return { client, queue, subscribeSignals };
}

function setup(clientFactory = fakeClient) {
  const fake = clientFactory();
  const server = { url: "http://127.0.0.1:1", password: "pw", close: vi.fn() };
  const startServer = vi.fn(async () => server);
  const createClient = vi.fn((_options: OpencodeClientOptions) => fake.client as unknown as OpencodeClientLike);
  const run = vi.fn(async () => ({ status: 0, stdout: "1.18.32\n", stderr: "" }));
  // Unhealthy by default, so a lost connection closes the server.
  const checkHealth = vi.fn(async (_url: string, _password: string) => false);
  const adapter = new OpencodeAdapter({ startServer, createClient, run, checkHealth });
  return { adapter, fake, server, startServer, createClient, run, checkHealth };
}

const baseOptions: SessionOptions = { workingDirectory: "C:/work", permission: "full-access", guarded: false };

function callbacks(events: AgentEvent[], overrides: Partial<SessionCallbacks> = {}): SessionCallbacks {
  return {
    onEvent: (e) => events.push(e),
    requestPermission: async () => false,
    checkTool: () => true,
    ...overrides,
  };
}

const ev = (type: string, properties: Record<string, unknown>): RawEvent => ({ type, properties });
const message = (id: string, role: "user" | "assistant", sessionID = "ses_1") =>
  ev("message.updated", { info: { id, role, sessionID } });
const textPart = (id: string, messageID: string, text: string, sessionID = "ses_1") =>
  ev("message.part.updated", { part: { id, messageID, sessionID, type: "text", text } });
const toolPart = (callID: string, status: string, sessionID = "ses_1") =>
  ev("message.part.updated", { part: { id: `prt_${callID}`, messageID: "msg_a", sessionID, type: "tool", callID, tool: "bash", state: { status, input: {} } } });
const idle = (sessionID = "ses_1") => ev("session.idle", { sessionID });

/** Wait until the adapter sent the prompt (it does so after the event stream connected). */
async function prompted(fake: ReturnType<typeof fakeClient>) {
  await vi.waitFor(() => expect(fake.client.session.promptAsync).toHaveBeenCalled());
}

type PromptBody = { agent: string; model?: { providerID: string; modelID: string }; parts: Array<{ type: string; text?: string }> };
const promptBody = (fake: ReturnType<typeof fakeClient>, call = 0) =>
  (fake.client.session.promptAsync.mock.calls[call][0] as { body: PromptBody }).body;

describe("OpencodeAdapter", () => {
  it("streams text and tool events and resolves with the assistant text on idle", async () => {
    const { adapter, fake, createClient } = setup();
    const events: AgentEvent[] = [];
    const session = await adapter.startSession({ ...baseOptions, model: "anthropic/claude-x" }, callbacks(events));
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "http://127.0.0.1:1", directory: "C:/work" }));
    expect(fake.client.session.create).toHaveBeenCalledWith(expect.objectContaining({ body: { title: "MDium workflow" } }));
    expect(session.nativeSessionId()).toBe("ses_1");

    const turn = session.runTurn("hi", new AbortController().signal);
    await prompted(fake);
    const body = promptBody(fake);
    expect(body.agent).toMatch(/^mdium-open-[0-9a-f]+$/);
    expect(body.model).toEqual({ providerID: "anthropic", modelID: "claude-x" });
    expect(body.parts).toEqual([{ type: "text", text: "hi" }]);

    fake.queue.push(
      ev("session.status", { sessionID: "ses_1", status: { type: "busy" } }),
      message("msg_u", "user"),
      textPart("prt_u", "msg_u", "hi"),
      message("msg_a", "assistant"),
      textPart("prt_1", "msg_a", ""),
      ev("message.part.delta", { sessionID: "ses_1", messageID: "msg_a", partID: "prt_1", field: "text", delta: "Hel" }),
      ev("message.part.delta", { sessionID: "ses_1", messageID: "msg_a", partID: "prt_1", field: "text", delta: "lo" }),
      toolPart("call_1", "pending"),
      toolPart("call_1", "running"),
      toolPart("call_1", "running"),
      toolPart("call_1", "completed"),
      message("msg_b", "assistant"),
      // v1 servers carry the delta on message.part.updated.
      { type: "message.part.updated", properties: { part: { id: "prt_2", messageID: "msg_b", sessionID: "ses_1", type: "text", text: "Done" }, delta: "Done" } },
      textPart("prt_3", "msg_b", " here"),
      idle(),
    );

    await expect(turn).resolves.toBe("Done here");
    expect(events).toEqual([
      { type: "assistant_delta", text: "Hel" },
      { type: "assistant_delta", text: "lo" },
      { type: "tool_started", toolId: "call_1", title: "bash" },
      { type: "tool_finished", toolId: "call_1", ok: true },
      { type: "assistant_delta", text: "Done" },
      { type: "assistant_message", text: "Done here" },
    ]);
    // The event subscription is released once the turn settles.
    expect(fake.subscribeSignals[0].aborted).toBe(true);
  });

  it("uses the read-only agent for read-only sessions and the guarded agent for guarded sessions", async () => {
    const { adapter, fake } = setup();
    const readOnly = await adapter.startSession({ ...baseOptions, permission: "read-only" }, callbacks([]));
    const t1 = readOnly.runTurn("a", new AbortController().signal);
    await prompted(fake);
    fake.queue.push(message("msg_a", "assistant"), idle());
    await expect(t1).resolves.toBe("");
    expect(promptBody(fake, 0).agent).toMatch(/^mdium-read-only-[0-9a-f]+$/);
    expect(promptBody(fake, 0).model).toBeUndefined();

    const guarded = await adapter.startSession({ ...baseOptions, guarded: true }, callbacks([]));
    const t2 = guarded.runTurn("b", new AbortController().signal);
    await vi.waitFor(() => expect(fake.client.session.promptAsync).toHaveBeenCalledTimes(2));
    fake.queue.push(message("msg_a", "assistant"), idle());
    await t2;
    expect(promptBody(fake, 1).agent).toMatch(/^mdium-guarded-[0-9a-f]+$/);
  });

  it("ignores an idle that arrives before the turn shows any activity", async () => {
    const { adapter, fake } = setup();
    const session = await adapter.startSession(baseOptions, callbacks([]));
    const turn = session.runTurn("hi", new AbortController().signal);
    await prompted(fake);
    let settled = false;
    void turn.then(() => (settled = true));
    fake.queue.push(idle());
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    fake.queue.push(message("msg_a", "assistant"), textPart("prt_1", "msg_a", "ok"), idle());
    await expect(turn).resolves.toBe("ok");
  });

  it("rejects a model that is not provider/model", async () => {
    const { adapter, fake } = setup();
    const session = await adapter.startSession({ ...baseOptions, model: "claude-x" }, callbacks([]));
    await expect(session.runTurn("hi", new AbortController().signal)).rejects.toThrow("OPENCODE_BAD_MODEL");
    expect(fake.client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("rejects a guard-blocked permission without asking", async () => {
    const { adapter, fake } = setup();
    const requestPermission = vi.fn(async () => true);
    const checked: ToolRequest[] = [];
    const session = await adapter.startSession(
      { ...baseOptions, guarded: true },
      callbacks([], { requestPermission, checkTool: (r) => (checked.push(r), !r.summary.startsWith("git push")) }),
    );
    const turn = session.runTurn("push it", new AbortController().signal);
    await prompted(fake);
    fake.queue.push(
      ev("permission.asked", {
        id: "per_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["git push *"],
        metadata: { command: "git push origin main" },
        always: ["git push *"],
        tool: { messageID: "msg_a", callID: "call_1" },
      }),
    );
    await vi.waitFor(() => expect(fake.client.postSessionIdPermissionsPermissionId).toHaveBeenCalled());
    expect(fake.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "ses_1", permissionID: "per_1" }, body: { response: "reject" } }),
    );
    expect(checked).toEqual([{ kind: "shell", summary: "git push origin main", rawKind: "bash", shell: "posix" }]);
    expect(requestPermission).not.toHaveBeenCalled();
    fake.queue.push(message("msg_a", "assistant"), idle());
    await turn;
  });

  it("checks every path of a multi-file edit with the guard", async () => {
    const { adapter, fake } = setup();
    const checked: string[] = [];
    const session = await adapter.startSession(
      { ...baseOptions, guarded: true },
      callbacks([], { checkTool: (r) => (checked.push(r.summary), r.summary !== path.win32.resolve("C:/work", "../outside.ts")) }),
    );
    const turn = session.runTurn("patch", new AbortController().signal);
    await prompted(fake);
    fake.queue.push(ev("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "edit", patterns: ["a.ts", "../outside.ts"], metadata: { filepath: "a.ts, ../outside.ts" }, always: ["*"] }));
    await vi.waitFor(() => expect(fake.client.postSessionIdPermissionsPermissionId).toHaveBeenCalled());
    expect(checked).toEqual([path.win32.resolve("C:/work", "a.ts"), path.win32.resolve("C:/work", "../outside.ts")]);
    expect((fake.client.postSessionIdPermissionsPermissionId.mock.calls[0][0] as { body: unknown }).body).toEqual({ response: "reject" });
    fake.queue.push(message("msg_a", "assistant"), idle());
    await turn;
  });

  it("rejects writes in read-only sessions without asking", async () => {
    const { adapter, fake } = setup();
    const requestPermission = vi.fn(async () => true);
    const session = await adapter.startSession({ ...baseOptions, permission: "read-only" }, callbacks([], { requestPermission }));
    const turn = session.runTurn("edit", new AbortController().signal);
    await prompted(fake);
    // v1 permission.updated shape.
    fake.queue.push(ev("permission.updated", { id: "per_1", sessionID: "ses_1", type: "edit", pattern: ["a.ts"], title: "Edit a.ts", metadata: { filePath: "C:/work/a.ts" } }));
    await vi.waitFor(() => expect(fake.client.postSessionIdPermissionsPermissionId).toHaveBeenCalled());
    expect((fake.client.postSessionIdPermissionsPermissionId.mock.calls[0][0] as { body: unknown }).body).toEqual({ response: "reject" });
    expect(requestPermission).not.toHaveBeenCalled();
    fake.queue.push(message("msg_a", "assistant"), idle());
    await turn;
  });

  it("asks the user under cli-default and approves once when allowed", async () => {
    const { adapter, fake } = setup();
    const requestPermission = vi.fn(async () => true);
    const session = await adapter.startSession({ ...baseOptions, permission: "cli-default" }, callbacks([], { requestPermission }));
    const turn = session.runTurn("test", new AbortController().signal);
    await prompted(fake);
    fake.queue.push(ev("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" }, always: [] }));
    await vi.waitFor(() => expect(fake.client.postSessionIdPermissionsPermissionId).toHaveBeenCalled());
    expect(requestPermission).toHaveBeenCalledWith({ kind: "shell", summary: "npm test", rawKind: "bash", shell: "posix" });
    expect((fake.client.postSessionIdPermissionsPermissionId.mock.calls[0][0] as { body: unknown }).body).toEqual({ response: "once" });
    fake.queue.push(message("msg_a", "assistant"), idle());
    await turn;
  });

  it("answers permissions of sub-agent sessions and ignores their output", async () => {
    const { adapter, fake } = setup();
    const events: AgentEvent[] = [];
    const session = await adapter.startSession(baseOptions, callbacks(events));
    const turn = session.runTurn("delegate", new AbortController().signal);
    await prompted(fake);
    fake.queue.push(
      message("msg_a", "assistant"),
      ev("session.created", { info: { id: "ses_child", parentID: "ses_1" } }),
      message("msg_c", "assistant", "ses_child"),
      textPart("prt_c", "msg_c", "child text", "ses_child"),
      toolPart("call_c", "running", "ses_child"),
      ev("permission.asked", { id: "per_c", sessionID: "ses_child", permission: "bash", patterns: ["ls"], metadata: { command: "ls" }, always: [] }),
    );
    await vi.waitFor(() => expect(fake.client.postSessionIdPermissionsPermissionId).toHaveBeenCalled());
    expect(fake.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "ses_child", permissionID: "per_c" }, body: { response: "once" } }),
    );
    fake.queue.push(ev("session.idle", { sessionID: "ses_child" }), textPart("prt_1", "msg_a", "parent"), idle());
    await expect(turn).resolves.toBe("parent");
    expect(events).toEqual([{ type: "assistant_message", text: "parent" }]);
  });

  it("ignores events of unrelated sessions", async () => {
    const { adapter, fake } = setup();
    const events: AgentEvent[] = [];
    const session = await adapter.startSession(baseOptions, callbacks(events));
    const turn = session.runTurn("hi", new AbortController().signal);
    await prompted(fake);
    fake.queue.push(
      message("msg_x", "assistant", "ses_other"),
      textPart("prt_x", "msg_x", "other", "ses_other"),
      ev("message.part.delta", { sessionID: "ses_other", messageID: "msg_x", partID: "prt_x", field: "text", delta: "other" }),
      ev("permission.asked", { id: "per_x", sessionID: "ses_other", permission: "bash", patterns: ["ls"], metadata: {}, always: [] }),
      ev("session.error", { sessionID: "ses_other", error: { name: "UnknownError", data: { message: "boom" } } }),
      idle("ses_other"),
      message("msg_a", "assistant"),
      textPart("prt_1", "msg_a", "mine"),
      idle(),
    );
    await expect(turn).resolves.toBe("mine");
    expect(events).toEqual([{ type: "assistant_message", text: "mine" }]);
    expect(fake.client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
  });

  it("rejects on session.error with the error name and message", async () => {
    const { adapter, fake } = setup();
    const session = await adapter.startSession(baseOptions, callbacks([]));
    const turn = session.runTurn("hi", new AbortController().signal);
    await prompted(fake);
    fake.queue.push(ev("session.error", { sessionID: "ses_1", error: { name: "ProviderAuthError", data: { providerID: "x", message: "bad key" } } }));
    await expect(turn).rejects.toThrow("OPENCODE_FAILED: ProviderAuthError: bad key");
  });

  it("rejects when the event stream ends before the turn completes", async () => {
    const { adapter, fake } = setup();
    const session = await adapter.startSession(baseOptions, callbacks([]));
    const turn = session.runTurn("hi", new AbortController().signal);
    await prompted(fake);
    fake.queue.end();
    await expect(turn).rejects.toThrow("OPENCODE_DISCONNECTED");
  });

  it("aborts the session and rejects with AbortError", async () => {
    const { adapter, fake } = setup();
    const session = await adapter.startSession(baseOptions, callbacks([]));
    const controller = new AbortController();
    const turn = session.runTurn("hi", controller.signal);
    await prompted(fake);
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "ses_1" } }));
    expect(fake.subscribeSignals[0].aborted).toBe(true);
  });

  it("close() aborts the running turn", async () => {
    const { adapter, fake } = setup();
    const session = await adapter.startSession(baseOptions, callbacks([]));
    const turn = session.runTurn("hi", new AbortController().signal);
    await prompted(fake);
    await session.close();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.client.session.abort).toHaveBeenCalled();
  });

  it("passes the server password to the client factory as a Basic Authorization header", async () => {
    const { adapter, createClient } = setup();
    await adapter.startSession(baseOptions, callbacks([]));
    const expected = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:1",
      directory: "C:/work",
      headers: { Authorization: expected },
    });
  });

  it("resumes an existing session without creating one", async () => {
    const { adapter, fake } = setup();
    const session = await adapter.startSession({ ...baseOptions, resumeNativeId: "ses_old" }, callbacks([]));
    expect(session.nativeSessionId()).toBe("ses_old");
    expect(fake.client.session.create).not.toHaveBeenCalled();
  });

  it("starts the server once across sessions and closes it on dispose", async () => {
    const { adapter, server, startServer } = setup();
    await adapter.startSession(baseOptions, callbacks([]));
    await adapter.startSession({ ...baseOptions, workingDirectory: "C:/other" }, callbacks([]));
    expect(startServer).toHaveBeenCalledTimes(1);
    await adapter.dispose();
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it("probe runs the version command and never starts the server", async () => {
    const { adapter, run, startServer } = setup();
    await expect(adapter.probe()).resolves.toEqual({ kind: "available", version: "1.18.32" });
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args] = run.mock.calls[0] as unknown as [string, string[]];
    if (process.platform === "win32") {
      expect(args).toEqual(["/d", "/s", "/c", "opencode --version"]);
    } else {
      expect([command, args]).toEqual(["opencode", ["--version"]]);
    }
    expect(startServer).not.toHaveBeenCalled();
  });

  it("probe reports a missing CLI", async () => {
    const missing = new OpencodeAdapter({
      startServer: vi.fn(),
      run: async () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn"), { code: "ENOENT" }) }),
    });
    await expect(missing.probe()).resolves.toEqual({ kind: "missing", detail: "opencode" });
    // cmd.exe reports an unknown command with exit code 9009, a posix shell with 127.
    const notFound = new OpencodeAdapter({ startServer: vi.fn(), run: async () => ({ status: 9009, stdout: "", stderr: "not recognized" }) });
    await expect(notFound.probe()).resolves.toEqual({ kind: "missing", detail: "opencode" });
    const broken = new OpencodeAdapter({ startServer: vi.fn(), run: async () => ({ status: 1, stdout: "", stderr: "crash" }) });
    await expect(broken.probe()).resolves.toEqual({ kind: "error", detail: "version" });
  });
});

describe("opencodeServerConfig", () => {
  const config = opencodeServerConfig({ readOnly: "mdium-read-only-x", guarded: "mdium-guarded-x", open: "mdium-open-x" });
  const permissionOf = (name: string) => (config.agent as Record<string, { permission: Record<string, string> }>)[name].permission;

  it("asks for edits, shell, fetches, and outside directories server-wide", () => {
    expect(config.permission).toEqual({ edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" });
  });

  it("restricted agents deny every tool outside the inspectable built-ins", () => {
    for (const name of ["mdium-read-only-x", "mdium-guarded-x"]) {
      const permission = permissionOf(name);
      // "*" must come first: opencode applies the last matching rule.
      expect(Object.keys(permission)[0]).toBe("*");
      expect(permission["*"]).toBe("deny");
      for (const tool of ["read", "glob", "grep", "list"]) expect(permission[tool]).toBe("ask");
      expect(permission.task).toBeUndefined();
    }
  });

  it("read-only denies edits, shell, network, and outside directories", () => {
    const permission = permissionOf("mdium-read-only-x");
    for (const tool of ["edit", "bash", "webfetch", "websearch", "external_directory"]) expect(permission[tool]).toBe("deny");
  });

  it("the guarded agent asks for everything the guard inspects", () => {
    const permission = permissionOf("mdium-guarded-x");
    for (const tool of ["edit", "bash", "webfetch", "websearch", "external_directory"]) expect(permission[tool]).toBe("ask");
  });

  it("disables session sharing", () => {
    expect(config.share).toBe("disabled");
  });
});

describe("OpencodeAdapter hardening", () => {
  it("resolves worktree-relative paths so the guard blocks writes outside a subfolder workspace", async () => {
    const { adapter, fake } = setup(() => fakeClient({ directory: "C:/repo/docs", worktree: "C:/repo" }));
    const ctx = { workspaceRoot: "C:/repo/docs", homeDir: "C:/Users/u", platform: "win32" as const };
    const checked: ToolRequest[] = [];
    const session = await adapter.startSession(
      { ...baseOptions, workingDirectory: "C:/repo/docs", guarded: true },
      callbacks([], { checkTool: (r) => (checked.push(r), checkToolRequest(r, ctx).ok) }),
    );
    expect(fake.client.path.get).toHaveBeenCalledWith(expect.objectContaining({ query: { directory: "C:/repo/docs" } }));
    const turn = session.runTurn("patch", new AbortController().signal);
    await prompted(fake);
    fake.queue.push(ev("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: "src/a.ts" }, always: ["*"] }));
    await vi.waitFor(() => expect(fake.client.postSessionIdPermissionsPermissionId).toHaveBeenCalled());
    expect(checked.map((r) => r.summary)).toEqual([path.win32.resolve("C:/repo", "src/a.ts")]);
    expect((fake.client.postSessionIdPermissionsPermissionId.mock.calls[0][0] as { body: unknown }).body).toEqual({ response: "reject" });
    fake.queue.push(message("msg_a", "assistant"), idle());
    await turn;
  });

  it("uses the session directory when opencode reports no worktree (non-git folders)", async () => {
    const { adapter, fake } = setup(() => fakeClient({ directory: "C:/plain", worktree: "/" }));
    const checked: string[] = [];
    const session = await adapter.startSession({ ...baseOptions, workingDirectory: "C:/plain" }, callbacks([], { checkTool: (r) => (checked.push(r.summary), true) }));
    const turn = session.runTurn("read", new AbortController().signal);
    await prompted(fake);
    fake.queue.push(ev("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "read", patterns: ["a.txt"], metadata: {}, always: ["*"] }));
    await vi.waitFor(() => expect(checked).toEqual([path.win32.resolve("C:/plain", "a.txt")]));
    fake.queue.push(message("msg_a", "assistant"), idle());
    await turn;
  });

  it("ignores stale messages and statuses from before this turn's prompt", async () => {
    const { adapter, fake } = setup();
    const events: AgentEvent[] = [];
    const session = await adapter.startSession(baseOptions, callbacks(events));
    const turn = session.runTurn("hi", new AbortController().signal);
    await prompted(fake);
    let settled = false;
    void turn.then(() => (settled = true));
    const old = Date.now() - 60_000;
    fake.queue.push(
      ev("session.status", { sessionID: "ses_1", status: { type: "busy" } }),
      ev("message.updated", { info: { id: "msg_old", role: "assistant", sessionID: "ses_1", time: { created: old } } }),
      textPart("prt_old", "msg_old", "stale"),
      ev("message.part.delta", { sessionID: "ses_1", messageID: "msg_old", partID: "prt_old", field: "text", delta: "stale" }),
      toolPart("call_old", "completed"),
      idle(),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(events).toEqual([]);
    fake.queue.push(
      ev("message.updated", { info: { id: "msg_new", role: "assistant", sessionID: "ses_1", time: { created: Date.now() + 1 } } }),
      textPart("prt_new", "msg_new", "fresh"),
      idle(),
    );
    await expect(turn).resolves.toBe("fresh");
  });

  it("wraps a failed session.create, drops the server, and restarts it for the next session", async () => {
    const { adapter, fake, server, startServer } = setup();
    fake.client.session.create.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(adapter.startSession(baseOptions, callbacks([]))).rejects.toThrow("OPENCODE_FAILED: fetch failed");
    await vi.waitFor(() => expect(server.close).toHaveBeenCalledTimes(1));
    await adapter.startSession(baseOptions, callbacks([]));
    expect(startServer).toHaveBeenCalledTimes(2);
  });

  it("sends the Authorization header with the default health check", async () => {
    const fake = fakeClient();
    const server = { url: "http://127.0.0.1:1", password: "pw", close: vi.fn() };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const adapter = new OpencodeAdapter({
        startServer: async () => server,
        createClient: () => fake.client as unknown as OpencodeClientLike,
      });
      fake.client.session.create.mockRejectedValueOnce(new TypeError("fetch failed"));
      await expect(adapter.startSession(baseOptions, callbacks([]))).rejects.toThrow("OPENCODE_FAILED");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:1/path");
      expect(init?.headers).toEqual({ Authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` });
      // A healthy (200) server is kept.
      expect(server.close).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a healthy shared server when one session's request fails", async () => {
    const { adapter, fake, server, startServer, checkHealth } = setup();
    checkHealth.mockResolvedValue(true);
    fake.client.session.create.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(adapter.startSession(baseOptions, callbacks([]))).rejects.toThrow("OPENCODE_FAILED: fetch failed");
    await vi.waitFor(() => expect(checkHealth).toHaveBeenCalledWith("http://127.0.0.1:1", "pw"));
    await adapter.startSession(baseOptions, callbacks([]));
    expect(server.close).not.toHaveBeenCalled();
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("keeps the server when session.create returns an HTTP error", async () => {
    const { adapter, fake, server, startServer } = setup();
    fake.client.session.create.mockResolvedValueOnce({ error: { name: "BadRequest", data: { message: "nope" } } } as never);
    await expect(adapter.startSession(baseOptions, callbacks([]))).rejects.toThrow("OPENCODE_FAILED: BadRequest: nope");
    expect(server.close).not.toHaveBeenCalled();
    await adapter.startSession(baseOptions, callbacks([]));
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("drops the server when the event stream disconnects", async () => {
    const { adapter, fake, server, startServer } = setup();
    const session = await adapter.startSession(baseOptions, callbacks([]));
    const turn = session.runTurn("hi", new AbortController().signal);
    await prompted(fake);
    fake.queue.end();
    await expect(turn).rejects.toThrow("OPENCODE_DISCONNECTED");
    await vi.waitFor(() => expect(server.close).toHaveBeenCalledTimes(1));
    await adapter.startSession(baseOptions, callbacks([]));
    expect(startServer).toHaveBeenCalledTimes(2);
  });

  it("keeps a healthy shared server when one session's event stream disconnects", async () => {
    const { adapter, fake, server, startServer, checkHealth } = setup();
    checkHealth.mockResolvedValue(true);
    const session = await adapter.startSession(baseOptions, callbacks([]));
    const turn = session.runTurn("hi", new AbortController().signal);
    await prompted(fake);
    fake.queue.end();
    await expect(turn).rejects.toThrow("OPENCODE_DISCONNECTED");
    await vi.waitFor(() => expect(checkHealth).toHaveBeenCalled());
    await adapter.startSession(baseOptions, callbacks([]));
    expect(server.close).not.toHaveBeenCalled();
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("shares one server start between concurrent first sessions", async () => {
    const { adapter, startServer } = setup();
    await Promise.all([adapter.startSession(baseOptions, callbacks([])), adapter.startSession(baseOptions, callbacks([]))]);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("retries a failed server start on the next session", async () => {
    const { adapter, startServer } = setup();
    startServer.mockRejectedValueOnce(new Error("Server exited with code 1"));
    await expect(adapter.startSession(baseOptions, callbacks([]))).rejects.toThrow("Server exited with code 1");
    await expect(adapter.startSession(baseOptions, callbacks([]))).resolves.toBeDefined();
    expect(startServer).toHaveBeenCalledTimes(2);
  });
});

describe("startDedicatedServer", () => {
  const config = opencodeServerConfig({ readOnly: "r", guarded: "g", open: "o" });

  it("passes the server config to the start function", async () => {
    const handle = { url: "http://127.0.0.1:3", password: "p", close: vi.fn() };
    const start = vi.fn().mockResolvedValue(handle);
    await expect(startDedicatedServer(config, start)).resolves.toBe(handle);
    expect(start).toHaveBeenCalledWith({ config });
  });

  it("retries once when the server exits during start", async () => {
    const handle = { url: "http://127.0.0.1:3", password: "p", close: vi.fn() };
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error("Server exited with code 1\nServer output: Failed to start server"))
      .mockResolvedValueOnce(handle);
    await expect(startDedicatedServer(config, start)).resolves.toBe(handle);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("retries at most once", async () => {
    const start = vi.fn().mockRejectedValue(new Error("Server exited with code 1"));
    await expect(startDedicatedServer(config, start)).rejects.toThrow("Server exited with code 1");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not retry other start failures", async () => {
    const start = vi.fn().mockRejectedValue(new Error("Timeout waiting for server to start after 20000ms"));
    await expect(startDedicatedServer(config, start)).rejects.toThrow("Timeout");
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("OpencodeAdapter images", () => {
  it("adds a file part per image after the text part", async () => {
    const { adapter, fake } = setup();
    const session = await adapter.startSession(baseOptions, callbacks([]));
    const image = path.resolve("C:/work/drafts/shot.jpg");
    const turn = session.runTurn("look", new AbortController().signal, [image]);
    await prompted(fake);
    expect(promptBody(fake).parts).toEqual([
      { type: "text", text: "look" },
      { type: "file", mime: "image/jpeg", filename: "shot.jpg", url: pathToFileURL(image).href },
    ]);
    fake.queue.push(message("msg_a", "assistant"), textPart("prt_1", "msg_a", "Seen"), idle());
    await expect(turn).resolves.toBe("Seen");
  });
});

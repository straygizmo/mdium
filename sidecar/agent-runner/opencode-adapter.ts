import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { createOpencodeServer } from "@opencode-ai/sdk/server";
import type { AgentEvent, AgentPermission, Availability } from "../../src/shared/types/agent-runner";
import type { AdapterSession, ProviderAdapter, SessionCallbacks, SessionOptions } from "./adapter";
import { runCommand, type CommandRunner } from "./availability";
import { opencodeDecision, toolRequestFromOpencode, toolRequestsFromOpencode, type OpencodePermissionLike } from "./permissions";

/*
 * Configuration hardening of the dedicated opencode server.
 *
 * Verified against opencode 1.18.32 (the bundled config loader and `opencode debug agent`):
 * - Config layers merge in this order, later wins: remote well-known, global
 *   (~/.config/opencode), OPENCODE_CONFIG, project opencode.json(c) files, `.opencode`
 *   directories (project, home, OPENCODE_CONFIG_DIR: their opencode.json(c), agents,
 *   commands, plugins), OPENCODE_CONFIG_CONTENT (what createOpencodeServer injects),
 *   account/org config, the system managed config, then OPENCODE_PERMISSION (top level only).
 * - OPENCODE_DISABLE_PROJECT_CONFIG=1 skips project opencode.json(c) files and project
 *   `.opencode` directories (and with them project plugins, MCP servers, formatters,
 *   agents, and the project AGENTS.md / CLAUDE.md instructions).
 * - An agent's rules are the defaults, then the top-level `permission`, then the agent's own
 *   `permission`; opencode applies the LAST matching rule. Keys merged from an earlier layer
 *   into the same agent keep their earlier position, so a known agent name (`build`, `plan`)
 *   could be widened by a user or project config. The adapter therefore uses agent names
 *   with a random per-adapter suffix that no config file can target.
 * - A tool whose last matching rule is `"*": deny` is removed from the model's tool list, so
 *   `"*": "deny"` first removes MCP, plugin, and custom tools (which never ask) and
 *   `task`/`question`; the built-ins that follow all ask before running (read, glob, grep,
 *   list, edit/write/apply_patch, bash, webfetch, websearch, external_directory, lsp).
 * - The server emits `permission.asked` (1.18) rather than the SDK v1 `permission.updated`;
 *   both are handled. The v1 reply route POST /session/{id}/permissions/{permissionID} is
 *   still served (deprecated). Text deltas arrive as `message.part.delta`.
 *
 * Remaining gaps (not closable from here): the user's global config and the system managed
 * config still load (their plugins and MCP servers run inside the server process, and their
 * `experimental.policies` are not inspected); session-level `env` is not applied because one
 * server serves every session (the runner's own environment is inherited).
 */

type OpencodeResult<T = unknown> = { data?: T; error?: unknown };
type DirectoryQuery = { query?: { directory?: string } };

/** Structural subset of the SDK v1 client used by the adapter. */
export interface OpencodeClientLike {
  session: {
    create(options: { body: { title: string } } & DirectoryQuery): Promise<OpencodeResult<{ id: string }>>;
    promptAsync(
      options: {
        path: { id: string };
        body: { agent: string; model?: { providerID: string; modelID: string }; parts: Array<{ type: "text"; text: string }> };
      } & DirectoryQuery,
    ): Promise<OpencodeResult>;
    abort(options: { path: { id: string } } & DirectoryQuery): Promise<OpencodeResult>;
  };
  event: {
    subscribe(options: { signal: AbortSignal; sseMaxRetryAttempts?: number } & DirectoryQuery): Promise<{ stream: AsyncIterable<unknown> }>;
  };
  postSessionIdPermissionsPermissionId(
    options: { path: { id: string; permissionID: string }; body: { response: "once" | "always" | "reject" } } & DirectoryQuery,
  ): Promise<OpencodeResult>;
}

export interface OpencodeServerHandle {
  url: string;
  close(): void;
}

export interface OpencodeAdapterDeps {
  startServer?: () => Promise<OpencodeServerHandle>;
  createClient?: (baseUrl: string, directory: string) => OpencodeClientLike;
  run?: CommandRunner;
}

export interface OpencodeAgentNames {
  readOnly: string;
  guarded: string;
  open: string;
}

type PermissionRules = Record<string, string>;

/** Built-ins that ask before running, so the guard sees them first. `"*"` must stay first. */
function restrictedRules(readOnly: boolean): PermissionRules {
  const write = readOnly ? "deny" : "ask";
  return {
    "*": "deny",
    invalid: "allow",
    todowrite: "allow",
    skill: "allow",
    read: "ask",
    glob: "ask",
    grep: "ask",
    list: "ask",
    lsp: "ask",
    doom_loop: "ask",
    edit: write,
    bash: write,
    webfetch: write,
    websearch: write,
    external_directory: write,
  };
}

/** The OPENCODE_CONFIG_CONTENT of the dedicated server. */
export function opencodeServerConfig(agents: OpencodeAgentNames) {
  return {
    // Workflow sessions are never uploaded, whatever the user's share setting is.
    share: "disabled",
    permission: { edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" },
    agent: {
      [agents.readOnly]: { mode: "primary", description: "MDium read-only workflow stage", permission: restrictedRules(true) },
      [agents.guarded]: { mode: "primary", description: "MDium guarded workflow stage", permission: restrictedRules(false) },
      // Unguarded stages: every tool that asks is routed to the adapter; sub-agents are allowed.
      [agents.open]: {
        mode: "primary",
        description: "MDium workflow stage",
        permission: { "*": "ask", invalid: "allow", todowrite: "allow", question: "deny", plan_enter: "deny", plan_exit: "deny" },
      },
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("OPENCODE_NO_PORT"))));
    });
  });
}

/** Start `opencode serve` with project configuration disabled (see the note at the top). */
async function startDedicatedServer(config: ReturnType<typeof opencodeServerConfig>): Promise<OpencodeServerHandle> {
  const port = await freePort();
  // createOpencodeServer copies process.env synchronously when it spawns (before its first
  // await) and has no env option, so the flag is set only around that synchronous call.
  const previous = process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  try {
    return await createOpencodeServer({
      hostname: "127.0.0.1",
      port,
      timeout: 20_000,
      config: config as unknown as NonNullable<Parameters<typeof createOpencodeServer>[0]>["config"],
    });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
    else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previous;
  }
}

function abortError(): Error {
  return Object.assign(new Error("Turn cancelled"), { name: "AbortError" });
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const e = error as { name?: string; message?: string; data?: { message?: string } };
    const detail = e.data?.message ?? e.message;
    if (e.name && detail) return `${e.name}: ${detail}`;
    if (e.name || detail) return (e.name ?? detail)!;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function parseVersion(text: string): string | undefined {
  return text.match(/\bv?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1];
}

type RawEvent = { type?: string; properties?: Record<string, unknown> };
type RawPart = {
  id?: string;
  messageID?: string;
  sessionID?: string;
  type?: string;
  text?: string;
  synthetic?: boolean;
  callID?: string;
  tool?: string;
  state?: { status?: string; title?: string };
};
type RawPermission = {
  id?: string;
  sessionID?: string;
  // v1 permission.updated
  type?: string;
  pattern?: string | string[];
  title?: string;
  // 1.18 permission.asked
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
};

const CONNECT_TIMEOUT_MS = 15_000;

/** Per-turn event state: text per part, message roles, and announced tool calls. */
class TurnState {
  /** Set once the root session showed activity for this turn, so a stale idle is ignored. */
  active = false;
  private readonly roles = new Map<string, string>();
  private readonly partTypes = new Map<string, string>();
  /** Text parts per assistant message, in order of appearance. */
  private readonly texts = new Map<string, Map<string, string>>();
  readonly startedTools = new Set<string>();
  readonly finishedTools = new Set<string>();

  setRole(messageID: string, role: string): void {
    this.roles.set(messageID, role);
  }

  /** Record a text part; returns false for parts that are not assistant output. */
  setText(part: RawPart): boolean {
    if (!part.id || !part.messageID) return false;
    this.partTypes.set(part.id, "text");
    if (this.roles.get(part.messageID) === "user" || part.synthetic) return false;
    this.textsOf(part.messageID).set(part.id, part.text ?? "");
    return true;
  }

  setPartType(part: RawPart): void {
    if (part.id && part.type) this.partTypes.set(part.id, part.type);
  }

  /** Append a streamed text delta; returns false when the part is not assistant text. */
  appendText(messageID: string, partID: string, delta: string): boolean {
    if (this.partTypes.get(partID) !== "text" || this.roles.get(messageID) === "user") return false;
    const parts = this.texts.get(messageID);
    if (!parts?.has(partID)) return false;
    parts.set(partID, parts.get(partID)! + delta);
    return true;
  }

  /** The text of the last assistant message that produced any. */
  finalText(): string {
    let final = "";
    for (const parts of this.texts.values()) {
      const text = [...parts.values()].join("");
      if (text) final = text;
    }
    return final;
  }

  private textsOf(messageID: string): Map<string, string> {
    let parts = this.texts.get(messageID);
    if (!parts) {
      parts = new Map();
      this.texts.set(messageID, parts);
    }
    return parts;
  }
}

class OpencodeSession implements AdapterSession {
  private cancelTurn: (() => void) | undefined;

  constructor(
    private readonly client: OpencodeClientLike,
    private readonly id: string,
    private readonly agent: string,
    private readonly options: SessionOptions,
    private readonly callbacks: SessionCallbacks,
  ) {}

  nativeSessionId(): string | undefined {
    return this.id;
  }

  private get query() {
    return { directory: this.options.workingDirectory };
  }

  runTurn(text: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const model = this.options.model ? parseModel(this.options.model) : undefined;
      if (this.options.model && !model) return reject(new Error("OPENCODE_BAD_MODEL"));

      const subscription = new AbortController();
      const state = new TurnState();
      // The root session and its sub-agent sessions; only root output belongs to the turn.
      const sessions = new Set([this.id]);
      let settled = false;
      let prompted = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        subscription.abort();
        signal.removeEventListener("abort", onAbort);
        if (this.cancelTurn === onAbort) this.cancelTurn = undefined;
        fn();
      };
      const fail = (error: Error) => finish(() => reject(error));
      const onAbort = () => {
        if (settled) return;
        void this.client.session.abort({ path: { id: this.id }, query: this.query }).catch(() => undefined);
        fail(abortError());
      };
      this.cancelTurn = onAbort;
      signal.addEventListener("abort", onAbort);
      const connectTimer = setTimeout(() => {
        if (!prompted) fail(new Error("OPENCODE_DISCONNECTED"));
      }, CONNECT_TIMEOUT_MS);

      const emit = (event: AgentEvent) => {
        if (!settled) this.callbacks.onEvent(event);
      };
      const sendPrompt = () => {
        prompted = true;
        this.client.session
          .promptAsync({
            path: { id: this.id },
            query: this.query,
            body: { agent: this.agent, ...(model ? { model } : {}), parts: [{ type: "text", text }] },
          })
          .then((result) => {
            if (result?.error) fail(new Error(`OPENCODE_FAILED: ${errorText(result.error)}`));
          })
          .catch((error: unknown) => fail(new Error(`OPENCODE_FAILED: ${errorText(error)}`)));
      };
      const complete = () => {
        const final = state.finalText();
        if (final) emit({ type: "assistant_message", text: final });
        finish(() => resolve(final));
      };

      const handle = (event: RawEvent) => {
        const p = event.properties ?? {};
        switch (event.type) {
          case "session.created":
          case "session.updated": {
            const info = p.info as { id?: string; parentID?: string } | undefined;
            if (info?.id && info.parentID && sessions.has(info.parentID)) sessions.add(info.id);
            break;
          }
          case "session.status": {
            if (p.sessionID !== this.id) break;
            const status = (p.status as { type?: string } | undefined)?.type;
            if (status === "idle") {
              if (state.active) complete();
            } else if (status) {
              state.active = true;
            }
            break;
          }
          case "message.updated": {
            const info = p.info as { id?: string; role?: string; sessionID?: string } | undefined;
            if (!info?.id || info.sessionID !== this.id) break;
            state.active = true;
            if (info.role) state.setRole(info.id, info.role);
            break;
          }
          case "message.part.updated": {
            const part = (p.part ?? {}) as RawPart;
            if (part.sessionID !== this.id) break;
            state.active = true;
            if (part.type === "text") {
              if (state.setText(part) && typeof p.delta === "string" && p.delta) emit({ type: "assistant_delta", text: p.delta });
            } else {
              state.setPartType(part);
              if (part.type === "tool" && part.callID) this.toolEvent(part, state, emit);
            }
            break;
          }
          case "message.part.delta": {
            if (p.sessionID !== this.id || p.field !== "text" || typeof p.delta !== "string") break;
            if (state.appendText(String(p.messageID), String(p.partID), p.delta) && p.delta) emit({ type: "assistant_delta", text: p.delta });
            break;
          }
          case "permission.updated":
          case "permission.asked": {
            const permission = p as RawPermission;
            if (!permission.id || !permission.sessionID || !sessions.has(permission.sessionID)) break;
            void this.answerPermission(permission.id, permission.sessionID, normalizePermission(permission), () => settled).catch(
              (error: unknown) => {
                void this.client.session.abort({ path: { id: this.id }, query: this.query }).catch(() => undefined);
                fail(new Error(`OPENCODE_PERMISSION_REPLY_FAILED: ${errorText(error)}`));
              },
            );
            break;
          }
          case "session.error": {
            if (p.sessionID !== this.id) break;
            fail(new Error(`OPENCODE_FAILED: ${errorText(p.error ?? "unknown")}`));
            break;
          }
          case "session.idle":
            if (p.sessionID === this.id && state.active) complete();
            break;
        }
      };

      void this.consume(subscription.signal, (event) => {
        // The stream connects lazily; prompt only once it delivers its first event
        // (server.connected), so no event of this turn can be missed.
        if (!prompted) sendPrompt();
        handle(event);
      })
        .then(() => fail(new Error("OPENCODE_DISCONNECTED")))
        .catch((error: unknown) => fail(new Error(`OPENCODE_DISCONNECTED: ${errorText(error)}`)));
    });
  }

  /** Consume the SSE stream until it ends or the turn settles (which aborts `signal`). */
  private async consume(signal: AbortSignal, onEvent: (event: RawEvent) => void): Promise<void> {
    // One retry only: a local server that drops the stream has most likely exited.
    const { stream } = await this.client.event.subscribe({ signal, query: this.query, sseMaxRetryAttempts: 1 });
    for await (const raw of stream) {
      if (signal.aborted) return;
      if (raw && typeof raw === "object") onEvent(raw as RawEvent);
    }
  }

  private toolEvent(part: RawPart, state: TurnState, emit: (event: AgentEvent) => void): void {
    const callID = part.callID!;
    const status = part.state?.status;
    const start = () => {
      if (state.startedTools.has(callID)) return;
      state.startedTools.add(callID);
      emit({ type: "tool_started", toolId: callID, title: part.tool ?? callID });
    };
    if (status === "running") start();
    if ((status === "completed" || status === "error") && !state.finishedTools.has(callID)) {
      start();
      state.finishedTools.add(callID);
      emit({ type: "tool_finished", toolId: callID, ok: status === "completed" });
    }
  }

  /** Guard check, mode decision, and reply for one permission request. */
  private async answerPermission(permissionID: string, sessionID: string, permission: OpencodePermissionLike, settled: () => boolean): Promise<void> {
    const request = toolRequestFromOpencode(permission);
    // The safety guard wins over every permission mode; a block also aborts the turn.
    const allowedByGuard = toolRequestsFromOpencode(permission).every((r) => this.callbacks.checkTool(r));
    let response: "once" | "reject" = "reject";
    if (allowedByGuard) {
      const decision = opencodeDecision(this.options.permission, request);
      response = decision === "ask" ? ((await this.callbacks.requestPermission(request)) ? "once" : "reject") : decision;
    }
    // A settled turn already aborted the session, which rejects its pending permissions.
    if (settled() && response === "once") return;
    const result = await this.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID },
      body: { response },
      query: this.query,
    });
    if (result?.error && !settled()) throw new Error(errorText(result.error));
  }

  async close(): Promise<void> {
    this.cancelTurn?.();
  }
}

function normalizePermission(permission: RawPermission): OpencodePermissionLike {
  return {
    type: permission.permission ?? permission.type ?? "unknown",
    ...(permission.patterns ?? permission.pattern ? { pattern: permission.patterns ?? permission.pattern } : {}),
    ...(permission.title ? { title: permission.title } : {}),
    ...(permission.metadata ? { metadata: permission.metadata } : {}),
  };
}

function agentFor(agents: OpencodeAgentNames, permission: AgentPermission, guarded: boolean): string {
  if (permission === "read-only") return agents.readOnly;
  return guarded ? agents.guarded : agents.open;
}

/** opencode adapter for workflow stages: one dedicated `opencode serve` per adapter. */
export class OpencodeAdapter implements ProviderAdapter {
  private readonly agents: OpencodeAgentNames;
  private readonly startServer: () => Promise<OpencodeServerHandle>;
  private readonly createClient: (baseUrl: string, directory: string) => OpencodeClientLike;
  private readonly run: CommandRunner;
  private server: Promise<OpencodeServerHandle> | undefined;

  constructor(deps: OpencodeAdapterDeps = {}) {
    const suffix = randomBytes(6).toString("hex");
    this.agents = { readOnly: `mdium-read-only-${suffix}`, guarded: `mdium-guarded-${suffix}`, open: `mdium-open-${suffix}` };
    const config = opencodeServerConfig(this.agents);
    this.startServer = deps.startServer ?? (() => startDedicatedServer(config));
    this.createClient =
      deps.createClient ?? ((baseUrl, directory) => createOpencodeClient({ baseUrl, directory }) as unknown as OpencodeClientLike);
    this.run = deps.run ?? runCommand;
  }

  async probe(): Promise<Availability> {
    // The npm install is a .cmd shim on Windows, so run it through cmd.exe with constant arguments.
    const result =
      process.platform === "win32"
        ? await this.run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "opencode --version"])
        : await this.run("opencode", ["--version"]);
    if (result.error) return result.error.code === "ENOENT" ? { kind: "missing", detail: "opencode" } : { kind: "error", detail: "spawn" };
    // cmd.exe exits with 9009 and posix shells with 127 for an unknown command.
    if (result.status === 9009 || result.status === 127) return { kind: "missing", detail: "opencode" };
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (result.status !== 0 || !version) return { kind: "error", detail: "version" };
    // No auth probe: provider failures surface as session errors at turn time.
    return { kind: "available", version };
  }

  private ensureServer(): Promise<OpencodeServerHandle> {
    if (!this.server) {
      const starting = this.startServer();
      this.server = starting;
      // A failed start is retried by the next session.
      starting.catch(() => {
        if (this.server === starting) this.server = undefined;
      });
    }
    return this.server;
  }

  async startSession(options: SessionOptions, callbacks: SessionCallbacks): Promise<AdapterSession> {
    const server = await this.ensureServer();
    const client = this.createClient(server.url, options.workingDirectory);
    let id = options.resumeNativeId;
    if (!id) {
      const created = await client.session.create({ body: { title: "MDium workflow" }, query: { directory: options.workingDirectory } });
      if (created.error || !created.data?.id) throw new Error(`OPENCODE_FAILED: ${errorText(created.error ?? "no session")}`);
      id = created.data.id;
    }
    return new OpencodeSession(client, id, agentFor(this.agents, options.permission, options.guarded), options, callbacks);
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    try {
      (await server).close();
    } catch {
      // The server never started; nothing to close.
    }
  }
}

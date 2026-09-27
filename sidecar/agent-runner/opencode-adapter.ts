import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import type { AgentEvent, AgentPermission, Availability } from "../../src/shared/types/agent-runner";
import type { AdapterSession, ProviderAdapter, SessionCallbacks, SessionOptions } from "./adapter";
import { runCommand, type CommandRunner } from "./availability";
import { startOpencodeServer } from "./opencode-server";
import { imageMimeType } from "./protocol";
import {
  opencodeDecision,
  opencodeServerConfig,
  toolRequestFromOpencode,
  toolRequestsFromOpencode,
  type OpencodeAgentNames,
  type OpencodePaths,
  type OpencodePermissionLike,
} from "./permissions";

/*
 * Images: the prompt's `parts` accept SDK `FilePartInput`s, so each image of a turn is sent
 * after the text part as `{ type: "file", mime, filename, url }` with a `file://` URL; the
 * server reads the file and hands it to the model as an image.
 */

/** Prompt parts this adapter sends (subset of the SDK `TextPartInput | FilePartInput`). */
type OpencodePromptPart = { type: "text"; text: string } | { type: "file"; mime: string; filename: string; url: string };

/*
 * Configuration hardening of the dedicated opencode server.
 *
 * Verified against opencode 1.18.32 (the bundled config loader and `opencode debug agent`):
 * - Config layers merge in this order, later wins: remote well-known, global
 *   (~/.config/opencode), OPENCODE_CONFIG, project opencode.json(c) files, `.opencode`
 *   directories (project, home, OPENCODE_CONFIG_DIR: their opencode.json(c), agents,
 *   commands, plugins), OPENCODE_CONFIG_CONTENT (what startOpencodeServer injects),
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
 * - Formatters and language servers (which run project-installed programs outside the
 *   permission flow) are disabled server-wide with `formatter: false` / `lsp: false`.
 * - The server emits `permission.asked` (1.18) rather than the SDK v1 `permission.updated`;
 *   both are handled. The v1 reply route POST /session/{id}/permissions/{permissionID} is
 *   still served (deprecated). Text deltas arrive as `message.part.delta`.
 * - read/edit/apply_patch paths are relative to the git worktree root, glob/grep paths to
 *   the session directory; GET /path reports both, and the worktree is "/" outside git.
 * - OPENCODE_SERVER_PASSWORD makes the server require HTTP Basic auth (user `opencode`), so
 *   other local processes cannot drive it; every client request (and the health check)
 *   carries the header. The variable is inherited by every process opencode spawns, including
 *   the agent's shell tool, so a shell command could read it and call the server. The
 *   residual risk is low: that command already runs through the guard and permission flow,
 *   and requests it makes to the server are network calls the guard and permissions still
 *   see. A CLI flag or password file would be preferable if opencode adds one.
 * - The server listens on a port the runner picks (see startOpencodeServer); `--port=0` would
 *   make opencode prefer 4096, which MDium's own opencode panel uses.
 * - An unexpected exit after startup is not watched directly: the next failed request or lost
 *   event stream triggers dropServer, whose health check fails, so the next session restarts it.
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
  path: {
    get(options: DirectoryQuery): Promise<OpencodeResult<{ directory: string; worktree: string }>>;
  };
  session: {
    create(options: { body: { title: string } } & DirectoryQuery): Promise<OpencodeResult<{ id: string }>>;
    promptAsync(
      options: {
        path: { id: string };
        body: { agent: string; model?: { providerID: string; modelID: string }; parts: OpencodePromptPart[] };
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
  /** Basic-auth password of the server (user name `opencode`). */
  password: string;
  close(): void;
}

/** Options the adapter passes to the SDK client factory. */
export interface OpencodeClientOptions {
  baseUrl: string;
  directory: string;
  headers: { Authorization: string };
}

export interface OpencodeAdapterDeps {
  startServer?: () => Promise<OpencodeServerHandle>;
  createClient?: (options: OpencodeClientOptions) => OpencodeClientLike;
  run?: CommandRunner;
  /** Resolves true when the server at `url` still answers; used before closing a shared server. */
  checkHealth?: (url: string, password: string) => Promise<boolean>;
}

const HEALTH_TIMEOUT_MS = 3_000;

/** Authorization header value for a server started with `password`. */
function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

/** GET /path of a server with a short timeout. */
async function serverAnswers(url: string, password: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/path`, {
      headers: { Authorization: basicAuth(password) },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

type ServerConfig = ReturnType<typeof opencodeServerConfig>;
type StartServer = (options: { config: ServerConfig }) => Promise<OpencodeServerHandle>;

/** The server process exited while starting, e.g. because another process took the picked port. */
function exitedDuringStart(error: unknown): boolean {
  return /Server exited with code|EADDRINUSE|address already in use/i.test(errorText(error));
}

/**
 * Start `opencode serve` with project configuration disabled (see the note at the top).
 * The free port is picked before the server binds it, so an early exit is retried once
 * (on a freshly picked port).
 */
export async function startDedicatedServer(
  config: ServerConfig,
  start: StartServer = startOpencodeServer,
): Promise<OpencodeServerHandle> {
  try {
    return await start({ config });
  } catch (error) {
    if (!exitedDuringStart(error)) throw error;
    return start({ config });
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

function normalizePermission(permission: RawPermission): OpencodePermissionLike {
  return {
    type: permission.permission ?? permission.type ?? "unknown",
    ...(permission.patterns ?? permission.pattern ? { pattern: permission.patterns ?? permission.pattern } : {}),
    ...(permission.title ? { title: permission.title } : {}),
    ...(permission.metadata ? { metadata: permission.metadata } : {}),
  };
}

const CONNECT_TIMEOUT_MS = 15_000;

/** What a turn needs from its session. */
interface TurnContext {
  client: OpencodeClientLike;
  sessionId: string;
  paths: OpencodePaths;
  permission: AgentPermission;
  callbacks: SessionCallbacks;
  query: { directory: string };
}

/**
 * One turn: event state (fresh messages, text per part, tool calls) and the
 * handling of each server event. Events of messages created before this
 * turn's prompt (e.g. an aborted previous turn) are ignored.
 */
class OpencodeTurn {
  /** Set once a message of this turn appeared, so a stale idle is ignored. */
  private active = false;
  private settled = false;
  private promptTime: number | undefined;
  /** The root session and its sub-agent sessions; only root output belongs to the turn. */
  private readonly sessions: Set<string>;
  /** Messages created after the prompt, with their role. */
  private readonly fresh = new Map<string, string>();
  private readonly partTypes = new Map<string, string>();
  /** Text parts per assistant message, in order of appearance. */
  private readonly texts = new Map<string, Map<string, string>>();
  private readonly startedTools = new Set<string>();
  private readonly finishedTools = new Set<string>();

  constructor(
    private readonly ctx: TurnContext,
    private readonly settle: (outcome: { text: string } | { error: Error }) => void,
  ) {
    this.sessions = new Set([ctx.sessionId]);
  }

  get isSettled(): boolean {
    return this.settled;
  }

  get prompted(): boolean {
    return this.promptTime !== undefined;
  }

  markPrompted(): void {
    this.promptTime = Date.now();
  }

  resolve(text: string): void {
    if (this.settled) return;
    this.settled = true;
    this.settle({ text });
  }

  fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.settle({ error });
  }

  private emit(event: AgentEvent): void {
    if (!this.settled) this.ctx.callbacks.onEvent(event);
  }

  private complete(): void {
    let final = "";
    for (const parts of this.texts.values()) {
      const text = [...parts.values()].join("");
      if (text) final = text;
    }
    if (final) this.emit({ type: "assistant_message", text: final });
    this.resolve(final);
  }

  /** Assistant message of this turn in the root session (known role, created after the prompt). */
  private isFreshAssistant(messageID: string | undefined): boolean {
    return messageID !== undefined && this.fresh.get(messageID) === "assistant";
  }

  handle(event: RawEvent): void {
    const p = event.properties ?? {};
    const root = this.ctx.sessionId;
    switch (event.type) {
      case "session.created":
      case "session.updated": {
        const info = p.info as { id?: string; parentID?: string } | undefined;
        if (info?.id && info.parentID && this.sessions.has(info.parentID)) this.sessions.add(info.id);
        break;
      }
      case "session.status":
        if (p.sessionID === root && (p.status as { type?: string } | undefined)?.type === "idle" && this.active) this.complete();
        break;
      case "session.idle":
        if (p.sessionID === root && this.active) this.complete();
        break;
      case "message.updated": {
        const info = p.info as { id?: string; role?: string; sessionID?: string; time?: { created?: number } } | undefined;
        if (!info?.id || info.sessionID !== root) break;
        const created = info.time?.created;
        const stale = typeof created === "number" && this.promptTime !== undefined && created < this.promptTime;
        if (stale && !this.fresh.has(info.id)) break;
        this.fresh.set(info.id, info.role ?? "assistant");
        this.active = true;
        break;
      }
      case "message.part.updated": {
        const part = (p.part ?? {}) as RawPart;
        if (part.sessionID !== root || !this.isFreshAssistant(part.messageID) || !part.id) break;
        this.partTypes.set(part.id, part.type ?? "");
        if (part.type === "text") {
          if (part.synthetic) break;
          this.textsOf(part.messageID!).set(part.id, part.text ?? "");
          if (typeof p.delta === "string" && p.delta) this.emit({ type: "assistant_delta", text: p.delta });
        } else if (part.type === "tool" && part.callID) {
          this.toolEvent(part);
        }
        break;
      }
      case "message.part.delta": {
        if (p.sessionID !== root || p.field !== "text" || typeof p.delta !== "string" || !p.delta) break;
        const messageID = String(p.messageID);
        const partID = String(p.partID);
        const parts = this.texts.get(messageID);
        if (!this.isFreshAssistant(messageID) || this.partTypes.get(partID) !== "text" || !parts?.has(partID)) break;
        parts.set(partID, parts.get(partID)! + p.delta);
        this.emit({ type: "assistant_delta", text: p.delta });
        break;
      }
      case "permission.updated":
      case "permission.asked": {
        const permission = p as RawPermission;
        if (!permission.id || !permission.sessionID || !this.sessions.has(permission.sessionID)) break;
        void this.answerPermission(permission.id, permission.sessionID, normalizePermission(permission)).catch((error: unknown) => {
          void this.ctx.client.session.abort({ path: { id: root }, query: this.ctx.query }).catch(() => undefined);
          this.fail(new Error(`OPENCODE_PERMISSION_REPLY_FAILED: ${errorText(error)}`));
        });
        break;
      }
      case "session.error":
        if (p.sessionID === root) this.fail(new Error(`OPENCODE_FAILED: ${errorText(p.error ?? "unknown")}`));
        break;
    }
  }

  private textsOf(messageID: string): Map<string, string> {
    let parts = this.texts.get(messageID);
    if (!parts) {
      parts = new Map();
      this.texts.set(messageID, parts);
    }
    return parts;
  }

  private toolEvent(part: RawPart): void {
    const callID = part.callID!;
    const status = part.state?.status;
    const start = () => {
      if (this.startedTools.has(callID)) return;
      this.startedTools.add(callID);
      this.emit({ type: "tool_started", toolId: callID, title: part.tool ?? callID });
    };
    if (status === "running") start();
    if ((status === "completed" || status === "error") && !this.finishedTools.has(callID)) {
      start();
      this.finishedTools.add(callID);
      this.emit({ type: "tool_finished", toolId: callID, ok: status === "completed" });
    }
  }

  /** Guard check, mode decision, and reply for one permission request. */
  private async answerPermission(permissionID: string, sessionID: string, permission: OpencodePermissionLike): Promise<void> {
    const { callbacks, paths } = this.ctx;
    const request = toolRequestFromOpencode(permission, paths);
    // The safety guard wins over every permission mode; a block also aborts the turn.
    const allowedByGuard = toolRequestsFromOpencode(permission, paths).every((r) => callbacks.checkTool(r));
    let response: "once" | "reject" = "reject";
    if (allowedByGuard) {
      const decision = opencodeDecision(this.ctx.permission, request);
      response = decision === "ask" ? ((await callbacks.requestPermission(request)) ? "once" : "reject") : decision;
    }
    // A settled turn already aborted the session, which rejects its pending permissions.
    if (this.settled && response === "once") return;
    const result = await this.ctx.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID },
      body: { response },
      query: this.ctx.query,
    });
    if (result?.error && !this.settled) throw new Error(errorText(result.error));
  }
}

class OpencodeSession implements AdapterSession {
  private cancelTurn: (() => void) | undefined;

  constructor(
    private readonly client: OpencodeClientLike,
    private readonly id: string,
    private readonly agent: string,
    private readonly paths: OpencodePaths,
    private readonly options: SessionOptions,
    private readonly callbacks: SessionCallbacks,
    private readonly onDisconnect: () => void,
  ) {}

  nativeSessionId(): string | undefined {
    return this.id;
  }

  private get query() {
    return { directory: this.options.workingDirectory };
  }

  runTurn(text: string, signal: AbortSignal, images: readonly string[] = []): Promise<string> {
    const parts: OpencodePromptPart[] = [
      { type: "text", text },
      ...images.map(
        (file): OpencodePromptPart => ({
          type: "file",
          // The extension was checked by RunnerCore, so the mime type is known.
          mime: imageMimeType(file)!,
          filename: basename(file),
          url: pathToFileURL(file).href,
        }),
      ),
    ];
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const model = this.options.model ? parseModel(this.options.model) : undefined;
      if (this.options.model && !model) return reject(new Error("OPENCODE_BAD_MODEL"));

      const subscription = new AbortController();
      const onAbort = () => {
        if (turn.isSettled) return;
        void this.client.session.abort({ path: { id: this.id }, query: this.query }).catch(() => undefined);
        turn.fail(abortError());
      };
      const turn = new OpencodeTurn(
        {
          client: this.client,
          sessionId: this.id,
          paths: this.paths,
          permission: this.options.permission,
          callbacks: this.callbacks,
          query: this.query,
        },
        (outcome) => {
          clearTimeout(connectTimer);
          subscription.abort();
          signal.removeEventListener("abort", onAbort);
          if (this.cancelTurn === onAbort) this.cancelTurn = undefined;
          if ("error" in outcome) reject(outcome.error);
          else resolve(outcome.text);
        },
      );
      const disconnected = (detail?: string) => {
        if (turn.isSettled) return;
        this.onDisconnect();
        turn.fail(new Error(detail ? `OPENCODE_DISCONNECTED: ${detail}` : "OPENCODE_DISCONNECTED"));
      };
      this.cancelTurn = onAbort;
      signal.addEventListener("abort", onAbort);
      const connectTimer = setTimeout(() => {
        if (!turn.prompted) disconnected();
      }, CONNECT_TIMEOUT_MS);

      const sendPrompt = () => {
        turn.markPrompted();
        this.client.session
          .promptAsync({
            path: { id: this.id },
            query: this.query,
            body: { agent: this.agent, ...(model ? { model } : {}), parts },
          })
          .then((result) => {
            if (result?.error) turn.fail(new Error(`OPENCODE_FAILED: ${errorText(result.error)}`));
          })
          .catch((error: unknown) => turn.fail(new Error(`OPENCODE_FAILED: ${errorText(error)}`)));
      };

      void this.consume(subscription.signal, (event) => {
        // The stream connects lazily; prompt only once it delivers its first event
        // (server.connected), so no event of this turn can be missed.
        if (!turn.prompted) sendPrompt();
        turn.handle(event);
      })
        .then(() => disconnected())
        .catch((error: unknown) => disconnected(errorText(error)));
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

  async close(): Promise<void> {
    this.cancelTurn?.();
  }
}

function agentFor(agents: OpencodeAgentNames, permission: AgentPermission, guarded: boolean): string {
  if (permission === "read-only") return agents.readOnly;
  return guarded ? agents.guarded : agents.open;
}

/** Session paths; outside a git repository opencode reports the worktree as "/". */
function sessionPaths(directory: string, reported: { directory?: string; worktree?: string } | undefined): OpencodePaths {
  const dir = reported?.directory || directory;
  const worktree = reported?.worktree && reported.worktree !== "/" ? reported.worktree : dir;
  return { directory: dir, worktree };
}

/** opencode adapter for workflow stages: one dedicated `opencode serve` per adapter. */
export class OpencodeAdapter implements ProviderAdapter {
  private readonly agents: OpencodeAgentNames;
  private readonly startServer: () => Promise<OpencodeServerHandle>;
  private readonly createClient: (options: OpencodeClientOptions) => OpencodeClientLike;
  private readonly run: CommandRunner;
  private readonly checkHealth: (url: string, password: string) => Promise<boolean>;
  private server: Promise<OpencodeServerHandle> | undefined;

  constructor(deps: OpencodeAdapterDeps = {}) {
    const suffix = randomBytes(6).toString("hex");
    this.agents = { readOnly: `mdium-read-only-${suffix}`, guarded: `mdium-guarded-${suffix}`, open: `mdium-open-${suffix}` };
    const config = opencodeServerConfig(this.agents);
    this.startServer = deps.startServer ?? (() => startDedicatedServer(config));
    this.createClient = deps.createClient ?? ((options) => createOpencodeClient(options) as unknown as OpencodeClientLike);
    this.run = deps.run ?? runCommand;
    this.checkHealth = deps.checkHealth ?? serverAnswers;
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

  /**
   * After one session lost its connection, close and forget the shared server so the next
   * session restarts it, unless the server still answers (then only that session failed).
   */
  private dropServer(server: Promise<OpencodeServerHandle>): void {
    if (this.server !== server) return;
    void (async () => {
      const handle = await server;
      if (await this.checkHealth(handle.url, handle.password)) return;
      if (this.server === server) this.server = undefined;
      handle.close();
    })().catch(() => undefined);
  }

  async startSession(options: SessionOptions, callbacks: SessionCallbacks): Promise<AdapterSession> {
    const server = this.ensureServer();
    const { url, password } = await server;
    const client = this.createClient({
      baseUrl: url,
      directory: options.workingDirectory,
      headers: { Authorization: basicAuth(password) },
    });
    const query = { directory: options.workingDirectory };
    // A thrown request means the server is unreachable (e.g. it crashed); an `error`
    // result is an HTTP-level failure of a live server.
    const request = async <T>(call: () => Promise<OpencodeResult<T>>): Promise<T | undefined> => {
      let result: OpencodeResult<T>;
      try {
        result = await call();
      } catch (error) {
        this.dropServer(server);
        throw new Error(`OPENCODE_FAILED: ${errorText(error)}`);
      }
      if (result.error) throw new Error(`OPENCODE_FAILED: ${errorText(result.error)}`);
      return result.data;
    };
    const paths = sessionPaths(options.workingDirectory, await request(() => client.path.get({ query })));
    let id = options.resumeNativeId;
    if (!id) {
      const created = await request(() => client.session.create({ body: { title: "MDium workflow" }, query }));
      if (!created?.id) throw new Error("OPENCODE_FAILED: no session");
      id = created.id;
    }
    return new OpencodeSession(client, id, agentFor(this.agents, options.permission, options.guarded), paths, options, callbacks, () =>
      this.dropServer(server),
    );
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

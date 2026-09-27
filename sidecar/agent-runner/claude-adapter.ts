import { readFile, stat } from "node:fs/promises";
import { query as sdkQuery, type HookCallback, type Options, type PermissionResult, type SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, Availability } from "../../src/shared/types/agent-runner";
import { resolveClaudeExecutable, type ResolvedClaude } from "../resolve-claude";
import type { AdapterSession, ProviderAdapter, SessionCallbacks, SessionOptions } from "./adapter";
import { runCommand, type CommandRunner } from "./availability";
import { claudeDecision, claudeDisallowedTools, claudeHookDecision, toolRequestFromClaude } from "./permissions";
import { imageMimeType, type ImageMimeType } from "./protocol";

/*
 * Images: a turn with images is sent as a streamed prompt holding one SDK user message whose
 * content is a base64 `image` block per image followed by the text block. Images larger than
 * MAX_IMAGE_BYTES, unreadable images, and images beyond MAX_TURN_IMAGE_BYTES in total are
 * skipped and named, with the reason, in a note appended to the text.
 * A turn without images is sent as a plain string prompt.
 */

/** The subset of the SDK `Options` this adapter sets. */
export type ClaudeQueryOptions = Pick<
  Options,
  | "cwd"
  | "permissionMode"
  | "settingSources"
  | "systemPrompt"
  | "includePartialMessages"
  | "pathToClaudeCodeExecutable"
  | "executable"
  | "model"
  | "resume"
  | "abortController"
  | "env"
  | "hooks"
  | "disallowedTools"
  | "managedSettings"
  | "strictMcpConfig"
> & {
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
};

type ImageBlock = { type: "image"; source: { type: "base64"; media_type: ImageMimeType; data: string } };
type PromptBlock = ImageBlock | { type: "text"; text: string };

/** Structural subset of the SDK `SDKUserMessage` sent as a streamed prompt. */
export type ClaudeUserMessage = {
  type: "user";
  session_id: string;
  parent_tool_use_id: null;
  message: { role: "user"; content: PromptBlock[] };
};

/** Structural subset of the SDK `query` function. */
export type QueryFn = (params: { prompt: string | AsyncIterable<ClaudeUserMessage>; options: ClaudeQueryOptions }) => AsyncIterable<unknown>;

export interface ClaudeAdapterDeps {
  query?: QueryFn;
  resolve?: () => Promise<ResolvedClaude | null>;
  run?: CommandRunner;
}

type ContentBlock = { type: string; text?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean };
type ClaudeMessage = {
  type: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: string | ContentBlock[] };
  result?: string;
  is_error?: boolean;
  errors?: string[];
};

/** Largest image sent inline; larger images are skipped with a note. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Largest total of inline image bytes per turn; images beyond it are skipped with a note. */
const MAX_TURN_IMAGE_BYTES = 20 * 1024 * 1024;

/** Note appended to the prompt text for an image that is not sent. */
function skipNote(reason: string, file: string): string {
  return `\n\n[Image skipped (${reason}): ${file}]`;
}

/**
 * The prompt of a turn: the plain text, or one user message with image blocks when there are
 * images. The paths come from RunnerCore, already resolved and checked to be image files.
 */
async function buildPrompt(text: string, images: readonly string[]): Promise<string | AsyncIterable<ClaudeUserMessage>> {
  if (images.length === 0) return text;
  const content: PromptBlock[] = [];
  let notes = "";
  let total = 0;
  for (const file of images) {
    let data: Buffer;
    try {
      if ((await stat(file)).size > MAX_IMAGE_BYTES) {
        notes += skipNote("larger than 5 MiB", file);
        continue;
      }
      data = await readFile(file);
    } catch {
      notes += skipNote("unreadable", file);
      continue;
    }
    if (total + data.length > MAX_TURN_IMAGE_BYTES) {
      notes += skipNote("over 20 MiB of images in this turn", file);
      continue;
    }
    total += data.length;
    // The extension was checked by RunnerCore, so the mime type is known.
    content.push({ type: "image", source: { type: "base64", media_type: imageMimeType(file)!, data: data.toString("base64") } });
  }
  content.push({ type: "text", text: `${text}${notes}` });
  const message: ClaudeUserMessage = { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content } };
  return (async function* () {
    yield message;
  })();
}

const GUARD_BLOCKED_MESSAGE = "Blocked by MDium safety guard";
const NOT_PERMITTED_MESSAGE = "Not permitted in this stage";

function hookDeny(reason: string): SyncHookJSONOutput {
  return { reason, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function abortError(): Error {
  return Object.assign(new Error("Turn cancelled"), { name: "AbortError" });
}

function contentBlocks(message: ClaudeMessage): ContentBlock[] {
  const content = message.message?.content;
  return Array.isArray(content) ? content : [];
}

class ClaudeSession implements AdapterSession {
  private sessionId: string | undefined;
  private controller: AbortController | undefined;

  constructor(
    private readonly query: QueryFn,
    private readonly resolved: ResolvedClaude,
    private readonly options: SessionOptions,
    private readonly callbacks: SessionCallbacks,
  ) {
    this.sessionId = options.resumeNativeId;
  }

  nativeSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * PreToolUse hook: runs for every tool call, including calls that settings
   * rules, other hooks, or the CLI pre-approve without asking canUseTool, so
   * the safety guard and hard denials cannot be bypassed.
   */
  private readonly preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
    const request = toolRequestFromClaude(input.tool_name, toolInput);
    // A guard block also stops the whole turn.
    if (!this.callbacks.checkTool(request)) {
      return { continue: false, stopReason: GUARD_BLOCKED_MESSAGE, ...hookDeny(GUARD_BLOCKED_MESSAGE) };
    }
    if (claudeHookDecision(this.options.permission, this.options.guarded, request) === "deny") {
      return hookDeny(NOT_PERMITTED_MESSAGE);
    }
    // No opinion: canUseTool handles the ask/allow flow.
    return {};
  };

  private readonly canUseTool = async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    const request = toolRequestFromClaude(toolName, input);
    // The PreToolUse hook already checked this call; re-checking here is a
    // fallback. An allowed call stays allowed, so no second violation arises.
    if (!this.callbacks.checkTool(request)) {
      return { behavior: "deny", message: GUARD_BLOCKED_MESSAGE, interrupt: true };
    }
    if (claudeHookDecision(this.options.permission, this.options.guarded, request) === "deny") {
      return { behavior: "deny", message: NOT_PERMITTED_MESSAGE };
    }
    const decision = claudeDecision(this.options.permission, request);
    const allow = decision === "allow" || (decision === "ask" && (await this.callbacks.requestPermission(request)));
    return allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: NOT_PERMITTED_MESSAGE };
  };

  async runTurn(text: string, signal: AbortSignal, images: readonly string[] = []): Promise<string> {
    if (signal.aborted) throw abortError();
    const prompt = await buildPrompt(text, images);
    if (signal.aborted) throw abortError();
    const controller = new AbortController();
    this.controller = controller;
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort);
    // Settles when the turn is aborted, so a stream that ignores the abort cannot hang the turn.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    aborted.catch(() => undefined);

    const env = this.options.env
      ? { ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>), ...this.options.env }
      : undefined;
    const disallowedTools = claudeDisallowedTools(this.options.permission, this.options.guarded);
    const restricted = this.options.guarded || this.options.permission === "read-only";
    const options: ClaudeQueryOptions = {
      cwd: this.options.workingDirectory,
      permissionMode: "default",
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      pathToClaudeCodeExecutable: this.resolved.executablePath,
      ...(this.resolved.executable ? { executable: this.resolved.executable } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(env ? { env } : {}),
      resume: this.sessionId,
      abortController: controller,
      canUseTool: this.canUseTool,
      hooks: { PreToolUse: [{ hooks: [this.preToolUse] }] },
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      // Settings-file hooks and permission rules (e.g. a user `permissions.allow`)
      // must not widen a guarded or read-only stage.
      ...(restricted ? { managedSettings: { allowManagedHooksOnly: true, allowManagedPermissionRulesOnly: true } } : {}),
      // MCP servers from settings, `.mcp.json`, and plugins start processes the guard cannot
      // inspect, so a restricted stage loads none (and passes no `mcpServers` of its own).
      ...(restricted ? { strictMcpConfig: true } : {}),
    };

    const iterator = this.query({ prompt, options })[Symbol.asyncIterator]();
    // Tool calls the main agent announced, so a result without a start can still be reported.
    const startedToolIds = new Set<string>();
    const emit = (e: AgentEvent) => this.callbacks.onEvent(e);
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), aborted]);
        // Once the turn is aborted (cancel, timeout, or a guard block), emit nothing further.
        if (controller.signal.aborted) throw abortError();
        if (next.done) throw new Error("CLAUDE_NO_RESULT");
        const message = next.value as ClaudeMessage;
        // Sub-agent output belongs to the sub-agent's tool call, not the main turn.
        if (message.parent_tool_use_id) continue;
        switch (message.type) {
          case "system":
            if (message.subtype === "init" && message.session_id) this.sessionId = message.session_id;
            break;
          case "stream_event": {
            const event = message.event;
            if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
              emit({ type: "assistant_delta", text: event.delta.text });
            }
            break;
          }
          case "assistant":
            for (const block of contentBlocks(message)) {
              if (block.type === "text" && block.text) emit({ type: "assistant_message", text: block.text });
              if (block.type === "tool_use" && block.id) {
                startedToolIds.add(block.id);
                emit({ type: "tool_started", toolId: block.id, title: block.name ?? block.id });
              }
            }
            break;
          case "user":
            for (const block of contentBlocks(message)) {
              if (block.type !== "tool_result" || !block.tool_use_id) continue;
              if (!startedToolIds.has(block.tool_use_id)) {
                startedToolIds.add(block.tool_use_id);
                emit({ type: "tool_started", toolId: block.tool_use_id, title: block.tool_use_id });
              }
              emit({ type: "tool_finished", toolId: block.tool_use_id, ok: !block.is_error });
            }
            break;
          case "result":
            if (message.session_id) this.sessionId = message.session_id;
            if (message.subtype !== "success") {
              const details = message.errors?.length ? `: ${message.errors.join("; ")}` : "";
              throw new Error(`CLAUDE_FAILED: ${message.subtype ?? "unknown"}${details}`);
            }
            // A success result flagged as an error carries the failure text (e.g. an auth failure).
            if (message.is_error) throw new Error(`CLAUDE_FAILED: ${message.result || "unknown"}`);
            return message.result ?? "";
        }
      }
    } catch (error) {
      if (controller.signal.aborted) throw abortError();
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.controller === controller) this.controller = undefined;
      // Release the underlying stream; ignore failures from an already-ended or aborted query.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.controller?.abort();
  }
}

function parseVersion(text: string): string | undefined {
  return text.match(/\bv?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1];
}

/** Claude Agent SDK adapter, used for workflow stages. */
export class ClaudeAdapter implements ProviderAdapter {
  private readonly query: QueryFn;
  private readonly resolve: () => Promise<ResolvedClaude | null>;
  private readonly run: CommandRunner;

  constructor(deps: ClaudeAdapterDeps = {}) {
    this.query = deps.query ?? (sdkQuery as QueryFn);
    this.resolve = deps.resolve ?? (() => resolveClaudeExecutable());
    this.run = deps.run ?? runCommand;
  }

  async probe(): Promise<Availability> {
    const resolved = await this.resolve();
    if (!resolved) return { kind: "missing", detail: "claude" };
    // The SDK spawns a JS entry through `node` by name, so probe with the same binary.
    const isJs = resolved.executable === "node";
    const result = isJs
      ? await this.run("node", [resolved.executablePath, "--version"])
      : await this.run(resolved.executablePath, ["--version"]);
    if (result.error) {
      return isJs && result.error.code === "ENOENT" ? { kind: "missing", detail: "node" } : { kind: "error", detail: "spawn" };
    }
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (result.status !== 0 || !version) return { kind: "error", detail: "version" };
    // No auth probe: the CLI reports auth failures at turn time.
    return { kind: "available", version };
  }

  async startSession(options: SessionOptions, callbacks: SessionCallbacks): Promise<AdapterSession> {
    const resolved = await this.resolve();
    if (!resolved) throw new Error("CLAUDE_NOT_FOUND");
    return new ClaudeSession(this.query, resolved, options, callbacks);
  }
}

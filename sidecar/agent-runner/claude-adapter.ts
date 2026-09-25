import { query as sdkQuery, type HookCallback, type Options, type PermissionResult, type SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, Availability } from "../../src/shared/types/agent-runner";
import { resolveClaudeExecutable, type ResolvedClaude } from "../resolve-claude";
import type { AdapterSession, ProviderAdapter, SessionCallbacks, SessionOptions } from "./adapter";
import { runCommand, type CommandRunner } from "./availability";
import { claudeDecision, claudeDisallowedTools, claudeHookDecision, toolRequestFromClaude } from "./permissions";

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
> & {
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
};

/** Structural subset of the SDK `query` function. */
export type QueryFn = (params: { prompt: string; options: ClaudeQueryOptions }) => AsyncIterable<unknown>;

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

const GUARD_BLOCKED_MESSAGE = "Blocked by MDium safety guard";
const NOT_PERMITTED_MESSAGE = "Not permitted in this stage";

function hookDeny(reason: string): SyncHookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
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

  async runTurn(text: string, signal: AbortSignal): Promise<string> {
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
    };

    const iterator = this.query({ prompt: text, options })[Symbol.asyncIterator]();
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
    if (resolved.executable === "node") {
      // The SDK spawns a JS entry through `node` by name, so it must be on PATH.
      const node = await this.run("node", ["--version"]);
      if (node.error) return node.error.code === "ENOENT" ? { kind: "missing", detail: "node" } : { kind: "error", detail: "spawn" };
    }
    const result = resolved.executable === "node"
      ? await this.run(process.execPath, [resolved.executablePath, "--version"])
      : await this.run(resolved.executablePath, ["--version"]);
    if (result.error) return { kind: "error", detail: "spawn" };
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

import { Codex } from "@openai/codex-sdk";
import type { AgentEvent, Availability } from "../../src/shared/types/agent-runner";
import type { AdapterSession, ProviderAdapter, SessionCallbacks, SessionOptions } from "./adapter";
import { codexSandbox } from "./permissions";
import { resolveCodexPath } from "./resolve-cli";
import { probeCodex } from "./availability";

type CodexItem = {
  id: string;
  type: string;
  text?: string;
  command?: string;
  status?: string;
  server?: string;
  tool?: string;
  query?: string;
  changes?: Array<{ path: string; kind?: string }>;
};
type CodexEvent =
  | { type: "item.started" | "item.updated" | "item.completed"; item: CodexItem }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "error"; message: string }
  | { type: string };

interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<unknown> }>;
}
interface CodexThreadOptionsLike {
  workingDirectory: string;
  skipGitRepoCheck: boolean;
  sandboxMode?: "read-only" | "danger-full-access";
  model?: string;
}
export interface CodexLike {
  startThread(options: CodexThreadOptionsLike): CodexThreadLike;
  resumeThread(id: string, options: CodexThreadOptionsLike): CodexThreadLike;
}

export interface CodexAdapterDeps {
  createCodex: (options: { codexPathOverride?: string; env?: Record<string, string> }) => CodexLike;
  resolvePath: () => Promise<string | null>;
  probe: (path: string | null) => Promise<Availability>;
}

const TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

function toolTitle(item: CodexItem): string {
  if (item.type === "command_execution") return item.command ?? item.type;
  if (item.type === "mcp_tool_call") return `${item.server ?? "mcp"}/${item.tool ?? ""}`;
  if (item.type === "web_search") return item.query ?? item.type;
  return item.type;
}

function abortError(): Error {
  return Object.assign(new Error("Turn cancelled"), { name: "AbortError" });
}

class CodexSession implements AdapterSession {
  constructor(private readonly thread: CodexThreadLike, private readonly callbacks: SessionCallbacks) {}

  nativeSessionId(): string | undefined {
    return this.thread.id ?? undefined;
  }

  async runTurn(text: string, signal: AbortSignal): Promise<string> {
    const { events } = await this.thread.runStreamed(text, { signal });
    let finalResponse = "";
    // Some tool items (e.g. file_change) are single-shot: the SDK emits only
    // "item.completed" for them, with no preceding "item.started". Track which
    // tool ids we already announced so we can synthesize the missing start.
    const startedToolIds = new Set<string>();
    // file_change items are checked by the guard on their first event only.
    const checkedFileChangeIds = new Set<string>();
    const emit = (e: AgentEvent) => this.callbacks.onEvent(e);
    for await (const raw of events) {
      // Once the turn is aborted (cancel, timeout, or a guard block), emit nothing further.
      if (signal.aborted) throw abortError();
      const event = raw as CodexEvent;
      if (event.type === "turn.failed") throw new Error((event as { error: { message: string } }).error.message);
      if (event.type === "error") throw new Error((event as { message: string }).message);
      if (!("item" in event)) continue;
      const { item } = event as { item: CodexItem };
      if (TOOL_ITEMS.has(item.type)) {
        // Report tool calls to the safety guard; a blocked call makes the core
        // abort this turn, so the result needs no handling here.
        if (item.type === "command_execution" && event.type === "item.started") {
          this.callbacks.checkTool({ kind: "shell", summary: item.command ?? "", rawKind: "command_execution" });
        }
        // MCP tools cannot be inspected; a web search is checked like a network request.
        if (item.type === "mcp_tool_call" && event.type === "item.started") {
          this.callbacks.checkTool({ kind: "other", summary: toolTitle(item), rawKind: "mcp_tool_call", opaque: true });
        }
        if (item.type === "web_search" && event.type === "item.started") {
          this.callbacks.checkTool({ kind: "network", summary: item.query ?? "", rawKind: "web_search" });
        }
        if (item.type === "file_change" && !checkedFileChangeIds.has(item.id)) {
          checkedFileChangeIds.add(item.id);
          for (const change of item.changes ?? []) {
            this.callbacks.checkTool({ kind: "write", summary: change.path, rawKind: "file_change" });
          }
        }
        // A blocked call aborts the turn synchronously; do not announce the blocked tool.
        if (signal.aborted) throw abortError();
        if (event.type === "item.started") {
          startedToolIds.add(item.id);
          emit({ type: "tool_started", toolId: item.id, title: toolTitle(item) });
        }
        if (event.type === "item.completed") {
          if (!startedToolIds.has(item.id)) {
            emit({ type: "tool_started", toolId: item.id, title: toolTitle(item) });
          }
          emit({ type: "tool_finished", toolId: item.id, ok: item.status !== "failed" });
        }
      } else if (item.type === "agent_message" && event.type === "item.completed" && item.text) {
        finalResponse = item.text;
        emit({ type: "assistant_message", text: item.text });
      }
    }
    return finalResponse;
  }

  async close(): Promise<void> {
    // Codex threads hold no live process between turns.
  }
}

export class CodexAdapter implements ProviderAdapter {
  constructor(private readonly deps: CodexAdapterDeps = {
    createCodex: (options) => new Codex(options) as unknown as CodexLike,
    resolvePath: () => resolveCodexPath(),
    probe: (path) => probeCodex(path),
  }) {}

  async probe(): Promise<Availability> {
    return this.deps.probe(await this.deps.resolvePath());
  }

  async startSession(options: SessionOptions, callbacks: SessionCallbacks): Promise<AdapterSession> {
    const path = await this.deps.resolvePath();
    if (!path) throw new Error("CODEX_NOT_FOUND");
    const env = options.env
      ? { ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>), ...options.env }
      : undefined;
    const codex = this.deps.createCodex({ codexPathOverride: path, ...(env ? { env } : {}) });
    const sandboxMode = codexSandbox(options.permission);
    const threadOptions: CodexThreadOptionsLike = {
      workingDirectory: options.workingDirectory,
      skipGitRepoCheck: true,
      ...(sandboxMode ? { sandboxMode } : {}),
      ...(options.model ? { model: options.model } : {}),
    };
    const thread = options.resumeNativeId
      ? codex.resumeThread(options.resumeNativeId, threadOptions)
      : codex.startThread(threadOptions);
    return new CodexSession(thread, callbacks);
  }
}

import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import type {
  Message,
  Part,
  Event as OcEvent,
  TextPartInput,
  FilePartInput,
} from "@opencode-ai/sdk/client";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { useOpencodeServerStore } from "@/stores/opencode-server-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { resolveMdiumVbaMcpServer } from "../lib/builtin-mcp-servers";
import type { OpencodeMcpServer } from "@/shared/types";
import { BUILTIN_AGENTS } from "../lib/builtin-registry";
import { isAzureRefusal, isAzureProviderActive } from "../lib/provider-detection";

export interface OpencodeMessage {
  role: "user" | "assistant";
  content: string;
  parts?: Part[];
  completed?: boolean;
  isAutoReply?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
}

export interface OpencodeSessionInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImageAttachment {
  mime: string;
  dataUrl: string;
  filename: string;
}

interface UseOpencodeChatResult {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  messages: OpencodeMessage[];
  loading: boolean;
  sessions: OpencodeSessionInfo[];
  currentSessionId: string | null;
  pendingQuestions: PendingQuestion[] | null;
  selectedAgent: string | null;
  setSelectedAgent: (value: string | null) => void;
  availableAgents: { name: string; description: string }[];
  useMdContext: boolean;
  setUseMdContext: (value: boolean) => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  abortSession: () => Promise<void>;
  sendMessage: (text: string, agent?: string, images?: ImageAttachment[]) => Promise<void>;
  executeCommand: (commandName: string, args?: string) => Promise<void>;
  createNewSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  getSessionHistory: () => Promise<void>;
}

/** Expose the module-level SDK client for use by completion hooks */
export function getOpencodeClient(): OpencodeClient | null {
  return _client;
}

/**
 * Prefix every user message sent to opencode with the active xlsm/xlam file
 * path so the LLM can reason about which file the user is looking at.
 */
async function wrapWithMdiumContext(userMessage: string): Promise<string> {
  try {
    const active = await invoke<string | null>("get_active_xlsm_path");
    if (!active) return userMessage;
    return `<mdium_context>\nactive_file="${active.replace(/"/g, '\\"')}"\n</mdium_context>\n\n${userMessage}`;
  } catch {
    return userMessage;
  }
}

/**
 * Sync the mdium-vba MCP server entry to opencode config based on the
 * current allowLlmVbaImport toggle. Call at app startup and on toggle change.
 * Port/token change each MDium run, so this must be called on every startup
 * while the toggle is ON.
 */
export async function syncMdiumVbaMcpConfig(): Promise<void> {
  const enabled = useSettingsStore.getState().allowLlmVbaImport;
  const mcpServersPath = await invoke<string>("resolve_mcp_servers_path").catch(
    () => null
  );
  if (!mcpServersPath) return;

  const store = useOpencodeConfigStore.getState();
  const name = "mdium-vba";

  if (enabled) {
    const entry = await resolveMdiumVbaMcpServer(mcpServersPath);
    if (!entry) return;
    const server: OpencodeMcpServer = {
      type: entry.type,
      command: entry.command,
      enabled: entry.enabled,
      environment: entry.environment,
    };
    try {
      await store.saveMcpServer(name, server);
    } catch (e) {
      console.warn("[mdium-vba] saveMcpServer failed:", e);
      return;
    }
    // Also sync to running opencode instance (if connected).
    const client = getOpencodeClient();
    if (client) {
      try {
        await client.mcp.add({
          body: {
            name,
            config: {
              type: "local",
              command: entry.command,
              environment: entry.environment,
              enabled: true,
            },
          },
        });
      } catch (e) {
        console.warn("[mdium-vba] client.mcp.add failed:", e);
      }
    }
  } else {
    try {
      await store.deleteMcpServer(name);
    } catch (e) {
      console.warn("[mdium-vba] deleteMcpServer failed:", e);
    }
    const client = getOpencodeClient();
    if (client) {
      try {
        await client.mcp.disconnect({ path: { name } });
      } catch (e) {
        console.warn("[mdium-vba] client.mcp.disconnect failed:", e);
      }
    }
  }
}

/** Get and clear the pending video output path (consumed once) */
export function consumePendingVideoOutput(): string | null {
  const path = _pendingVideoOutput;
  _pendingVideoOutput = null;
  return path;
}

/** Set the pending video output path (for auto-open after generation) */
export function setPendingVideoOutput(path: string | null) {
  _pendingVideoOutput = path;
}

// ─── Module-level connection state (persists across mount/unmount) ───
let _client: OpencodeClient | null = null;
let _abort: AbortController | null = null;
let _connectedFolder: string | undefined;
let _connectLock = false;
let _currentSessionId: string | null = null;
/** Pending folder path requested while a connection was in progress */
let _pendingFolder: { path: string | undefined } | null = null;
/** Output path to auto-open when a generate-video-scenario command completes */
let _pendingVideoOutput: string | null = null;

// ─── Zustand store for UI state (persists across mount/unmount) ───
interface OpencodeChatUIState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  messages: OpencodeMessage[];
  loading: boolean;
  sessions: OpencodeSessionInfo[];
  currentSessionId: string | null;
  pendingQuestions: PendingQuestion[] | null;
  selectedAgent: string | null;
  availableAgents: { name: string; description: string }[];
  useMdContext: boolean;
  chatInput: string;
  aborted: boolean;
  chatSplitRatio: number;
  azureAutoRetryCount: number;
}

export const useChatUIStore = create<OpencodeChatUIState>()(() => ({
  connected: false,
  connecting: false,
  error: null,
  messages: [],
  loading: false,
  sessions: [],
  currentSessionId: null,
  pendingQuestions: null,
  selectedAgent: "build",
  availableAgents: [],
  useMdContext: false,
  chatInput: "",
  aborted: false,
  chatSplitRatio: 75,
  azureAutoRetryCount: 0,
}));

/**
 * Try to extract a questions array from text that contains JSON with a
 * `"questions"` field. Returns the parsed questions or null.
 */
function tryParseQuestions(text: string): PendingQuestion[] | null {
  const trimmed = text.trim();
  if (!trimmed.includes('"questions"')) return null;
  // Need at least one closing brace for valid JSON
  if (!trimmed.includes('}')) return null;

  const validate = (obj: unknown): PendingQuestion[] | null => {
    if (
      obj &&
      typeof obj === "object" &&
      Array.isArray((obj as any).questions) &&
      (obj as any).questions.length > 0 &&
      (obj as any).questions.every(
        (q: any) => typeof q.question === "string" && Array.isArray(q.options)
      )
    ) {
      return (obj as any).questions as PendingQuestion[];
    }
    return null;
  };

  // Try to parse the whole text as JSON
  try {
    const result = validate(JSON.parse(trimmed));
    if (result) return result;
  } catch {
    // Not valid JSON as-is — try other strategies
  }

  // Try to extract JSON from a fenced code block
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try {
      const result = validate(JSON.parse(fenced[1].trim()));
      if (result) return result;
    } catch {
      // not valid
    }
  }

  // Fallback: extract the outermost JSON object from surrounding text
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const result = validate(JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)));
      if (result) return result;
    } catch {
      // not valid
    }
  }

  return null;
}

// ─── Helper: process SSE event stream (runs in background) ───
function processSSEStream(stream: AsyncIterable<unknown>) {
  (async () => {
    try {
      for await (const event of stream) {
        const ev = event as OcEvent;
        if (ev.type === "message.part.updated") {
          const part = ev.properties.part;
          if (part.sessionID !== _currentSessionId) continue;

          if (part.type === "text") {
            useChatUIStore.setState((s) => {
              const last = s.messages[s.messages.length - 1];
              if (last && last.role === "assistant") {
                const updated = [...s.messages];
                const existingParts = (last.parts ?? []).filter(
                  (p) => !(p.type === "text" && (p as any).id === (part as any).id)
                );
                const newParts = [...existingParts, part];
                const textContent = newParts
                  .filter((p) => p.type === "text")
                  .map((p) => (p as any).text ?? "")
                  .join("");
                updated[updated.length - 1] = {
                  ...last,
                  content: textContent,
                  parts: newParts,
                };

                // Detect questions JSON and unlock loading
                const questions = tryParseQuestions(textContent);
                if (questions) {
                  updated[updated.length - 1] = { ...updated[updated.length - 1], content: "" };
                  return { messages: updated, pendingQuestions: questions, loading: false };
                }

                return { messages: updated };
              }
              return s;
            });
          } else if (part.type === "reasoning") {
            useChatUIStore.setState((s) => {
              const last = s.messages[s.messages.length - 1];
              if (last && last.role === "assistant") {
                const updated = [...s.messages];
                const existingParts = (last.parts ?? []).filter(
                  (p) => !(p.type === "reasoning" && (p as any).id === (part as any).id)
                );
                updated[updated.length - 1] = {
                  ...last,
                  parts: [...existingParts, part],
                };
                return { messages: updated };
              }
              return s;
            });
          } else if (part.type === "tool") {
            const toolPart = part as Extract<Part, { type: "tool" }>;

            // Opencode built-in "question" tool: render as QuestionsCard instead of a JSON bubble.
            // https://opencode.ai/docs/en/tools/#question
            if (toolPart.tool === "question") {
              const status = toolPart.state.status;
              const input = toolPart.state.input as any;
              useChatUIStore.setState((s) => {
                // Drop the question tool part from the assistant message so it never renders as a tool bubble
                let messages = s.messages;
                const last = s.messages[s.messages.length - 1];
                if (last && last.role === "assistant" && last.parts?.some(
                  (p) => p.type === "tool" && (p as any).callID === toolPart.callID,
                )) {
                  const filteredParts = (last.parts ?? []).filter(
                    (p) => !(p.type === "tool" && (p as any).callID === toolPart.callID),
                  );
                  messages = [...s.messages];
                  messages[messages.length - 1] = { ...last, parts: filteredParts };
                }

                // Only show the card while the tool is still awaiting an answer
                if (
                  (status === "pending" || status === "running") &&
                  input &&
                  typeof input.question === "string"
                ) {
                  const rawOptions = input.options;
                  const options: QuestionOption[] = Array.isArray(rawOptions)
                    ? rawOptions
                        .map((o: any): QuestionOption => {
                          if (typeof o === "string") return { label: o };
                          if (o && typeof o === "object") {
                            return {
                              label: String(o.label ?? o.value ?? ""),
                              description:
                                typeof o.description === "string" ? o.description : undefined,
                            };
                          }
                          return { label: String(o) };
                        })
                        .filter((o) => o.label)
                    : [];
                  const newQ: PendingQuestion = {
                    question: input.question,
                    header: typeof input.header === "string" ? input.header : undefined,
                    options,
                  };
                  const existing = s.pendingQuestions ?? [];
                  // Dedup by header+question in case the same call fires multiple updates
                  const idx = existing.findIndex(
                    (q) => q.question === newQ.question && q.header === newQ.header,
                  );
                  const nextQuestions =
                    idx >= 0
                      ? existing.map((q, i) => (i === idx ? newQ : q))
                      : [...existing, newQ];
                  return { messages, pendingQuestions: nextQuestions, loading: false };
                }

                return { messages };
              });
              continue;
            }

            useChatUIStore.setState((s) => {
              const last = s.messages[s.messages.length - 1];
              if (last && last.role === "assistant") {
                const updated = [...s.messages];
                updated[updated.length - 1] = {
                  ...last,
                  parts: [
                    ...(last.parts ?? []).filter(
                      (p) => !(p.type === "tool" && (p as any).callID === toolPart.callID)
                    ),
                    part,
                  ],
                };
                return { messages: updated };
              }
              return s;
            });
          }
        } else if (ev.type === "session.idle") {
          if (ev.properties.sessionID === _currentSessionId) {
            const state = useChatUIStore.getState();

            // If the session was aborted, skip — don't show "Done" toast
            if (state.aborted) {
              continue;
            }

            // If questions are pending, the user is interacting — don't reset loading
            if (state.pendingQuestions) {
              continue;
            }

            // Convert final assistant message content to HTML via marked
            // Strip echoed user question before converting
            const last = state.messages[state.messages.length - 1];
            if (last && last.role === "assistant") {
              // Skip spurious session.idle fired when a session is first created
              // (before any prompt response has arrived).
              // Only skip when we are NOT actively waiting for a response.
              if (!state.loading && !last.content && (!last.parts || last.parts.length === 0)) {
                continue;
              }
              let rawText = last.content;
              // Find previous user message to strip echo
              const prevIdx = state.messages.length - 2;
              if (prevIdx >= 0) {
                const prevUser = state.messages[prevIdx];
                if (prevUser?.role === "user" && prevUser.content && last.parts) {
                  const userText = prevUser.content.trim();
                  const textParts = last.parts.filter((p) => p.type === "text");
                  const firstText = textParts.length > 0 ? ((textParts[0] as any).text ?? "") : "";
                  if (firstText.trim().startsWith(userText)) {
                    const stripped = firstText.trim().slice(userText.length).trimStart();
                    const restParts = textParts.slice(1).map((p) => (p as any).text ?? "").join("");
                    rawText = stripped + restParts;
                  }
                }
              }

              // === Azure auto-continue on content-filter refusal ===
              const isRefusal = isAzureRefusal(rawText);

              if (isRefusal && state.azureAutoRetryCount === 0) {
                const isAzure = await isAzureProviderActive();
                if (isAzure) {
                  // Finalize the current assistant message in UI first
                  const refusalHtml = rawText ? await marked(rawText) : "";
                  useChatUIStore.setState((s) => {
                    const updated = [...s.messages];
                    updated[updated.length - 1] = {
                      ...updated[updated.length - 1],
                      content: refusalHtml,
                      completed: true,
                    };
                    return {
                      messages: updated,
                      loading: false,
                      azureAutoRetryCount: 1,
                    };
                  });
                  // Re-check aborted: the user may have clicked abort during
                  // the async isAzureProviderActive() call or between the
                  // finalize setState and this send. doSendMessage
                  // unconditionally clears aborted, so we must guard here.
                  if (!useChatUIStore.getState().aborted) {
                    // Send the auto-reply. Awaiting is safe: promptAsync
                    // schedules the prompt and returns before the model
                    // response arrives. Awaiting also guarantees the new
                    // messages are in the store before the next SSE event.
                    await doSendMessage("続けてください", undefined, undefined, { isAutoReply: true });
                  }
                  continue;
                }
              }

              // Reset counter on a genuine normal response (non-refusal + non-empty)
              if (!isRefusal && rawText.trim()) {
                useChatUIStore.setState({ azureAutoRetryCount: 0 });
              }
              // === end Azure auto-continue ===

              // Try to detect questions in the final text before converting to HTML
              const questionsFromIdle = tryParseQuestions(rawText);
              if (questionsFromIdle) {
                useChatUIStore.setState((s) => {
                  const updated = [...s.messages];
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    content: "",
                    completed: true,
                  };
                  return { messages: updated, pendingQuestions: questionsFromIdle, loading: false };
                });
                continue;
              }

              const html = rawText ? await marked(rawText) : "";
              useChatUIStore.setState((s) => {
                const updated = [...s.messages];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: html,
                  completed: true,
                };
                return { messages: updated, loading: false };
              });
            } else {
              useChatUIStore.setState({ loading: false });
            }
          }
        } else if (ev.type === "message.updated") {
          // Completion (loading: false) is handled exclusively by session.idle
          // to avoid premature "Done" toast when intermediate messages complete
          // before the full agent loop finishes.
          //
          // However, populate assistant message content from message.updated in
          // case message.part.updated events were not fired (e.g. LLM refusal
          // or very short responses).
          const msgInfo = (ev.properties as any).info;
          if (
            msgInfo &&
            msgInfo.role === "assistant" &&
            msgInfo.sessionID === _currentSessionId
          ) {
            useChatUIStore.setState((s) => {
              const last = s.messages[s.messages.length - 1];
              if (last && last.role === "assistant" && !last.content && (!last.parts || last.parts.length === 0)) {
                // Extract text from the message's parts array
                const msgParts: any[] = msgInfo.parts ?? [];
                const textContent = msgParts
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text ?? "")
                  .join("");
                if (textContent) {
                  const updated = [...s.messages];
                  updated[updated.length - 1] = {
                    ...last,
                    content: textContent,
                    parts: msgParts,
                  };
                  return { messages: updated };
                }
              }
              return s;
            });
          }
        }
      }
    } catch (e) {
      console.log("[opencode] SSE stream ended:", e);
    }
  })();
}

// ─── ensureOpencodeServer ───
async function ensureOpencodeServer(cwd?: string): Promise<string> {
  const store = useOpencodeServerStore.getState();
  const folderKey = cwd ?? "__default__";

  const existing = store.getServer(folderKey);
  if (existing) {
    const baseUrl = `http://127.0.0.1:${existing.port}`;
    try {
      const res = await fetch(`${baseUrl}/session`, { method: "GET" });
      if (res.ok) {
        console.log("[opencode] server already running on", baseUrl);
        return baseUrl;
      }
      // Server responded but not OK — remove stale entry
      console.warn("[opencode] stale server on", baseUrl, "status:", res.status);
      await store.removeServer(folderKey);
    } catch {
      await store.removeServer(folderKey);
    }
  }

  // Check if the allocated port is already occupied (e.g., by a zombie server)
  let port = store.allocatePort(folderKey);
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/session`, { method: "GET" });
    if (probe.ok) {
      // Port is already in use — remove the just-created entry and allocate a fresh one
      console.warn("[opencode] port", port, "already occupied, reallocating...");
      await store.removeServer(folderKey);
      port = store.allocatePort(folderKey);
    }
  } catch {
    // Port is free — good
  }

  const baseUrl = `http://127.0.0.1:${port}`;

  console.log("[opencode] starting server via Tauri... cwd:", cwd, "port:", port);
  try {
    const pid = await invoke<number>("spawn_background_process", {
      command: "opencode",
      args: ["serve", `--hostname=127.0.0.1`, `--port=${port}`],
      cwd: cwd ?? null,
    });
    console.log("[opencode] spawned server pid:", pid);
    store.registerServer(folderKey, port, pid);
  } catch (e) {
    console.warn("[opencode] could not auto-start server:", e);
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${baseUrl}/session`, { method: "GET" });
      if (res.ok) {
        console.log("[opencode] server started on", baseUrl, "cwd:", cwd);
        return baseUrl;
      }
    } catch {
      // keep waiting
    }
  }

  return baseUrl;
}

// ─── Module-level actions ───

function doDisconnect() {
  if (_abort) {
    _abort.abort();
    _abort = null;
  }
  _client = null;
  _connectedFolder = undefined;
  _currentSessionId = null;
  _connectLock = false;
  _pendingFolder = null;
  useChatUIStore.setState({
    connected: false,
    connecting: false,
    messages: [],
    loading: false,
    sessions: [],
    currentSessionId: null,
    error: null,
    pendingQuestions: null,
    azureAutoRetryCount: 0,
  });
}

// ─── Auto-register builtin agents as markdown files + copy tool files ───
async function ensureBuiltinAgents(_folderPath: string): Promise<void> {
  const home = await invoke<string>("get_home_dir");
  const sep = home.includes("\\") ? "\\" : "/";
  const configDir = `${home}${sep}.config${sep}opencode`;

  for (const [name, entry] of Object.entries(BUILTIN_AGENTS)) {
    // Write agent markdown file to ~/.config/opencode/agents/<name>.md
    if (entry.agentMd) {
      const agentPath = `${configDir}${sep}agents${sep}${name}.md`;
      try {
        await invoke<string>("read_text_file", { path: agentPath });
      } catch {
        try {
          await invoke("write_text_file_with_dirs", { path: agentPath, content: entry.agentMd });
          console.log(`[opencode] created builtin agent file: ${agentPath}`);
        } catch (e) {
          console.warn(`[opencode] failed to create agent file ${name}.md:`, e);
        }
      }
    }

    // Copy tool files from project source to global config
    if (entry.sourceToolFiles) {
      for (const [srcRel, destRel] of Object.entries(entry.sourceToolFiles)) {
        const destPath = `${configDir}${sep}${destRel.replace(/\//g, sep)}`;
        try {
          await invoke<string>("read_text_file", { path: destPath });
        } catch {
          const srcPath = `${_folderPath}${sep}${srcRel.replace(/\//g, sep)}`;
          try {
            const content = await invoke<string>("read_text_file", { path: srcPath });
            await invoke("write_text_file_with_dirs", { path: destPath, content });
            console.log(`[opencode] copied builtin tool to ${destPath}`);
          } catch (e) {
            console.warn(`[opencode] failed to copy builtin tool ${srcRel}:`, e);
          }
        }
      }
    }
  }
}

export async function doConnect(folderPath?: string) {
  if (_connectLock) {
    // Save the latest requested folder so we can reconnect after the current attempt
    _pendingFolder = { path: folderPath };
    return;
  }

  if (_client && _connectedFolder === folderPath) {
    useChatUIStore.setState({ connected: true });
    return;
  }

  if (_client) {
    doDisconnect();
  }

  _connectLock = true;
  _pendingFolder = null;
  useChatUIStore.setState({ connecting: true, error: null });

  try {
    // Auto-register builtin agents before starting the server
    if (folderPath) {
      await ensureBuiltinAgents(folderPath);
    }

    const baseUrl = await ensureOpencodeServer(folderPath);
    const client = createOpencodeClient({ baseUrl });
    _client = client;
    _connectedFolder = folderPath;

    const testRes = await client.session.list();
    console.log("[opencode] session.list test:", testRes.data);
    useChatUIStore.setState({ connected: true });

    // Fetch available agents
    try {
      const agentsRes = await client.app.agents();
      const agents = (agentsRes.data as any) ?? [];
      useChatUIStore.setState({
        availableAgents: agents
          .filter((a: any) => {
            const mode = a.mode ?? "all";
            if (mode === "subagent") return false;
            if (a.hidden) return false;
            return true;
          })
          .map((a: any) => ({
            name: a.name,
            description: a.description ?? "",
          })),
      });
    } catch {
      // Non-critical — dropdown will show default options
    }

    console.log("[opencode] connected to", baseUrl, "for folder:", folderPath);

    // Sync mdium-vba MCP config on every successful connection (port/token may change per run)
    syncMdiumVbaMcpConfig().catch((e) => {
      console.warn("[mdium-vba] initial sync failed:", e);
    });

    // Subscribe to SSE events (await ensures connection is ready before returning)
    const ac = new AbortController();
    _abort = ac;
    const sseResult = await client.event.subscribe({ signal: ac.signal });
    processSSEStream(sseResult.stream);
  } catch (e: any) {
    console.error("[opencode] connect failed:", e);
    useChatUIStore.setState({
      error: e.message ?? String(e),
      connected: false,
    });
  } finally {
    useChatUIStore.setState({ connecting: false });
    _connectLock = false;

    // If a different folder was requested while we were connecting, reconnect now
    // (TypeScript can't track that _pendingFolder may be set by concurrent async calls)
    const pending = _pendingFolder as { path: string | undefined } | null;
    if (pending !== null) {
      _pendingFolder = null;
      doConnect(pending.path);
    }
  }
}

async function ensureSessionId(title: string): Promise<string | null> {
  if (_currentSessionId) return _currentSessionId;
  if (!_client) return null;

  try {
    const res = await _client.session.create({
      body: { title: title.slice(0, 50) },
    });
    console.log("[opencode] session.create res:", res.data, res.error);
    const data = res.data as any;
    let sessionId: string | null = null;
    if (data?.id) {
      sessionId = data.id;
    } else if (data && typeof data === "object") {
      const keys = Object.keys(data);
      for (const key of keys) {
        const val = data[key];
        if (typeof val === "string" && key.toLowerCase().includes("id")) {
          sessionId = val;
          break;
        }
        if (typeof val === "object" && val?.id) {
          sessionId = val.id;
          break;
        }
      }
    }
    if (!sessionId) {
      useChatUIStore.setState({ error: "Failed to create session" });
      console.error("[opencode] no session ID in:", data);
      return null;
    }
    _currentSessionId = sessionId;
    useChatUIStore.setState({ currentSessionId: sessionId });
    console.log("[opencode] created session:", sessionId);
    return sessionId;
  } catch (e: any) {
    console.error("[opencode] session.create failed:", e);
    useChatUIStore.setState({ error: e.message ?? String(e) });
    return null;
  }
}

interface SendOptions {
  isAutoReply?: boolean;
}

export async function doSendMessage(
  text: string,
  agentOverride?: string,
  images?: ImageAttachment[],
  options?: SendOptions,
) {
  if (!_client || (!text.trim() && (!images || images.length === 0))) return;

  // L1: inject active tab context into every user message payload (SDK call only)
  const wrappedText = await wrapWithMdiumContext(text);

  useChatUIStore.setState({ error: null });
  const sessionId = await ensureSessionId(text || "image");
  if (!sessionId) return;

  // Build display text using original text (not wrapped) for clean UI echo
  const displayText = images && images.length > 0
    ? `${text}${text ? " " : ""}[${images.map((img) => img.filename).join(", ")}]`
    : text;

  useChatUIStore.setState((s) => ({
    messages: [
      ...s.messages,
      {
        role: "user" as const,
        content: displayText,
        isAutoReply: options?.isAutoReply ?? false,
      },
      { role: "assistant" as const, content: "", parts: [] },
    ],
    loading: true,
    pendingQuestions: null,
    aborted: false,
  }));

  try {
    const agent = agentOverride ?? useChatUIStore.getState().selectedAgent ?? undefined;

    // Build parts array using wrappedText for the SDK payload
    const parts: Array<TextPartInput | FilePartInput> = [];
    if (wrappedText.trim()) {
      parts.push({ type: "text", text: wrappedText });
    }
    if (images) {
      for (const img of images) {
        parts.push({
          type: "file",
          mime: img.mime,
          url: img.dataUrl,
          filename: img.filename,
        });
      }
    }

    const res = await _client.session.promptAsync({
      path: { id: sessionId },
      body: {
        ...(agent ? { agent } : {}),
        parts,
      },
    });
    console.log("[opencode] promptAsync res:", res.data, res.error);
    if (res.error) {
      throw new Error(JSON.stringify(res.error));
    }
  } catch (e: any) {
    console.error("[opencode] prompt failed:", e);
    useChatUIStore.setState((s) => {
      const last = s.messages[s.messages.length - 1];
      const msgs =
        last?.role === "assistant" && !last.content
          ? s.messages.slice(0, -1)
          : s.messages;
      return { error: e.message ?? String(e), loading: false, messages: msgs };
    });
  }
}

export async function doAbortSession() {
  if (!_client || !_currentSessionId) return;
  // Set aborted BEFORE the API call so that the SSE session.idle handler
  // (which may fire before the await resolves) won't trigger a "Done" toast.
  useChatUIStore.setState({ aborted: true });
  try {
    await _client.session.abort({ path: { id: _currentSessionId } });
  } catch (e: any) {
    console.error("[opencode] abort failed:", e);
  } finally {
    useChatUIStore.setState({ loading: false, pendingQuestions: null });
  }
}

export async function doExecuteCommand(commandName: string, args?: string) {
  if (!_client) return;

  useChatUIStore.setState({ error: null });
  const sessionId = await ensureSessionId(`/${commandName}`);
  if (!sessionId) return;

  const displayText = `/${commandName}${args ? ` ${args}` : ""}`;

  // Track generate-video-scenario output path for auto-open
  if (commandName === "generate-video-scenario" && args) {
    // Extract quoted paths or whitespace-separated tokens
    const quoted = [...args.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (quoted.length >= 2) {
      _pendingVideoOutput = quoted[quoted.length - 1];
    } else {
      const parts = args.trim().split(/\s+/);
      if (parts.length >= 2) {
        _pendingVideoOutput = parts[parts.length - 1];
      }
    }
  }

  useChatUIStore.setState((s) => ({
    messages: [
      ...s.messages,
      { role: "user" as const, content: displayText },
      { role: "assistant" as const, content: "", parts: [] },
    ],
    loading: true,
    pendingQuestions: null,
    aborted: false,
  }));

  try {
    const res = await _client.session.command({
      path: { id: sessionId },
      body: { command: commandName, arguments: args ?? "" },
    });
    console.log("[opencode] session.command res:", res.data, res.error);
    if (res.error) {
      throw new Error(JSON.stringify(res.error));
    }
  } catch (e: any) {
    console.error("[opencode] executeCommand failed:", e);
    useChatUIStore.setState((s) => {
      const last = s.messages[s.messages.length - 1];
      const msgs =
        last?.role === "assistant" && !last.content
          ? s.messages.slice(0, -1)
          : s.messages;
      return { error: e.message ?? String(e), loading: false, messages: msgs };
    });
  }
}

export async function doCreateNewSession() {
  _currentSessionId = null;
  useChatUIStore.setState({
    messages: [],
    currentSessionId: null,
    error: null,
    pendingQuestions: null,
    azureAutoRetryCount: 0,
  });
}

async function doLoadSession(sessionId: string) {
  if (!_client) return;
  useChatUIStore.setState({ error: null, loading: true });
  try {
    const res = await _client.session.messages({ path: { id: sessionId } });
    console.log("[opencode] session.messages res:", res.data);
    if (res.data) {
      const raw = res.data as any;
      const msgArray = Array.isArray(raw) ? raw : [];
      const loaded: OpencodeMessage[] = [];
      for (const msg of msgArray) {
        const info = (msg.info ?? msg) as Message;
        const parts = msg.parts ?? [];
        const textParts = parts.filter((p: any) => p.type === "text");
        const textContent = textParts.map((p: any) => p.text ?? "").join("");
        const html =
          info.role === "assistant"
            ? await marked(textContent)
            : textContent;

        // Merge consecutive assistant messages so tool parts are grouped
        const prev = loaded[loaded.length - 1];
        if (info.role === "assistant" && prev?.role === "assistant") {
          prev.parts = [...(prev.parts ?? []), ...parts];
          // Append text content
          if (textContent) {
            const prevTextParts = (prev.parts ?? []).filter((p: any) => p.type === "text");
            const prevTextContent = prevTextParts.map((p: any) => p.text ?? "").join("");
            prev.content = await marked(prevTextContent);
          }
        } else {
          loaded.push({ role: info.role, content: html, parts, completed: true });
        }
      }
      _currentSessionId = sessionId;
      useChatUIStore.setState({
        messages: loaded,
        currentSessionId: sessionId,
        azureAutoRetryCount: 0,
      });
    }
  } catch (e: any) {
    console.error("[opencode] loadSession failed:", e);
    useChatUIStore.setState({ error: e.message ?? String(e) });
  } finally {
    useChatUIStore.setState({ loading: false });
  }
}

async function doDeleteSession(sessionId: string) {
  if (!_client) return;
  try {
    await _client.session.delete({ path: { id: sessionId } });
    useChatUIStore.setState((s) => ({
      sessions: s.sessions.filter((ss) => ss.id !== sessionId),
    }));
    if (_currentSessionId === sessionId) {
      _currentSessionId = null;
      useChatUIStore.setState({
        messages: [],
        currentSessionId: null,
        azureAutoRetryCount: 0,
      });
    }
  } catch (e: any) {
    console.error("[opencode] deleteSession failed:", e);
    useChatUIStore.setState({ error: e.message ?? String(e) });
  }
}

async function doGetSessionHistory() {
  if (!_client) return;
  try {
    const res = await _client.session.list();
    const raw = res.data as any;
    console.log("[opencode] session.list raw:", raw);
    if (!raw) return;

    let sessionArray: any[];
    if (Array.isArray(raw)) {
      sessionArray = raw;
    } else if (typeof raw === "object") {
      sessionArray = Object.entries(raw).map(([key, val]) => {
        if (typeof val === "object" && val !== null && "id" in (val as any)) {
          return val;
        }
        return { id: key, ...(val as any) };
      });
    } else {
      sessionArray = [];
    }
    const list: OpencodeSessionInfo[] = sessionArray
      .filter((s) => s && typeof s === "object")
      .map((s) => ({
        id: s.id ?? "",
        title: s.title || (s.id ? String(s.id).slice(0, 8) : "untitled"),
        createdAt: s.time?.created ?? 0,
        updatedAt: s.time?.updated ?? 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    useChatUIStore.setState({ sessions: list });
  } catch (e: any) {
    console.error("[opencode] getSessionHistory failed:", e);
    useChatUIStore.setState({ error: e.message ?? String(e) });
  }
}

// ─── React hook (thin wrapper) ───

export function useOpencodeChat(folderPath?: string): UseOpencodeChatResult {
  const {
    connected,
    connecting,
    error,
    messages,
    loading,
    sessions,
    currentSessionId,
    pendingQuestions,
    selectedAgent,
    availableAgents,
    useMdContext,
  } = useChatUIStore();

  const folderPathRef = useRef(folderPath);
  folderPathRef.current = folderPath;

  const connect = useCallback(async () => {
    await doConnect(folderPathRef.current);
  }, []);

  const disconnect = useCallback(() => {
    doDisconnect();
  }, []);

  const abortSession = useCallback(async () => {
    await doAbortSession();
  }, []);

  const sendMessage = useCallback(async (text: string, agent?: string, images?: ImageAttachment[]) => {
    await doSendMessage(text, agent, images);
  }, []);

  const executeCommand = useCallback(async (commandName: string, args?: string) => {
    await doExecuteCommand(commandName, args);
  }, []);

  const createNewSession = useCallback(async () => {
    await doCreateNewSession();
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    await doLoadSession(sessionId);
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    await doDeleteSession(sessionId);
  }, []);

  const getSessionHistory = useCallback(async () => {
    await doGetSessionHistory();
  }, []);

  const setSelectedAgent = useCallback((value: string | null) => {
    useChatUIStore.setState({ selectedAgent: value });
  }, []);

  const setUseMdContext = useCallback((value: boolean) => {
    useChatUIStore.setState({ useMdContext: value });
  }, []);

  // Auto-connect when folderPath changes (deferred to avoid render storm on folder switch)
  useEffect(() => {
    if (!folderPath) return;
    const timer = setTimeout(() => {
      doConnect(folderPath);
    }, 500);
    return () => clearTimeout(timer);
  }, [folderPath]);

  return {
    connected,
    connecting,
    error,
    messages,
    loading,
    sessions,
    currentSessionId,
    pendingQuestions,
    selectedAgent,
    setSelectedAgent,
    availableAgents,
    useMdContext,
    setUseMdContext,
    connect,
    disconnect,
    abortSession,
    sendMessage,
    executeCommand,
    createNewSession,
    loadSession,
    deleteSession,
    getSessionHistory,
  };
}

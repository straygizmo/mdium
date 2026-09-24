import { create } from "zustand";
import type { AgentEvent, AgentProvider, AgentSessionSummary, Availability, RunnerOutbound, ToolRequest } from "@/shared/types/agent-runner";
import { newRunnerId, onRunnerMessage, requestRunner, sendToRunner } from "./lib/agent-runner-client";

export type ChatProviderTab = "opencode" | AgentProvider;

export interface ChatEntry {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  /** Tool entries: undefined while running, then the outcome. */
  ok?: boolean;
  /** Tool entries only: the SDK's tool call id, used to match a later tool_finished. */
  toolId?: string;
}

export interface PendingPermission { permissionId: string; request: ToolRequest }

export interface ProviderChat {
  sessionId: string | null;
  status: "idle" | "starting" | "running";
  entries: ChatEntry[];
  /**
   * FIFO queue of outstanding permission requests. The Copilot SDK dispatches
   * permission requests fire-and-forget, so more than one can be pending at
   * once; the UI answers them one at a time, oldest first.
   */
  pendingPermissions: PendingPermission[];
}

interface AgentChatState {
  selectedTab: ChatProviderTab;
  availability: Partial<Record<AgentProvider, Availability>>;
  chats: Record<string, ProviderChat>;
  setSelectedTab(tab: ChatProviderTab): void;
  probe(provider: AgentProvider): Promise<void>;
  newSession(folder: string, provider: AgentProvider, resumeNativeId?: string): Promise<void>;
  send(folder: string, provider: AgentProvider, text: string): Promise<boolean>;
  cancel(folder: string, provider: AgentProvider): Promise<void>;
  respondPermission(folder: string, provider: AgentProvider, allow: boolean): Promise<void>;
  listSessions(folder: string, provider: AgentProvider): Promise<AgentSessionSummary[]>;
}

export const chatKey = (folder: string, provider: AgentProvider) => `${provider}::${folder}`;

export const emptyChat: ProviderChat = { sessionId: null, status: "idle", entries: [], pendingPermissions: [] };

/** Assistant entries still receiving deltas. */
const streaming = new Set<string>();

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const useAgentChatStore = create<AgentChatState>()((set, get) => {
  const update = (key: string, fn: (chat: ProviderChat) => ProviderChat) =>
    set((s) => ({ chats: { ...s.chats, [key]: fn(s.chats[key] ?? emptyChat) } }));
  const append = (key: string, entry: ChatEntry) => update(key, (c) => ({ ...c, entries: [...c.entries, entry] }));
  const keyForSession = (sessionId: string) =>
    Object.entries(get().chats).find(([, c]) => c.sessionId === sessionId)?.[0];

  const applyEvent = (key: string, event: AgentEvent) => {
    update(key, (c) => {
      const entries = [...c.entries];
      const last = entries.at(-1);
      const streamingLast = last && last.role === "assistant" && streaming.has(last.id);
      switch (event.type) {
        case "assistant_delta":
          if (streamingLast) entries[entries.length - 1] = { ...last, text: last.text + event.text };
          else {
            const id = newRunnerId();
            streaming.add(id);
            entries.push({ id, role: "assistant", text: event.text });
          }
          break;
        case "assistant_message":
          if (streamingLast) {
            streaming.delete(last.id);
            entries[entries.length - 1] = { ...last, text: event.text };
          } else entries.push({ id: newRunnerId(), role: "assistant", text: event.text });
          break;
        case "tool_started":
          if (streamingLast) streaming.delete(last.id);
          entries.push({ id: newRunnerId(), role: "tool", text: event.title, toolId: event.toolId });
          break;
        case "tool_finished": {
          // A toolId can repeat across turns (the same tool run more than
          // once), so match the most recent still-unresolved entry for it.
          let index = -1;
          for (let i = entries.length - 1; i >= 0; i--) {
            const candidate = entries[i];
            if (candidate.role === "tool" && candidate.toolId === event.toolId && candidate.ok === undefined) {
              index = i;
              break;
            }
          }
          if (index >= 0) entries[index] = { ...entries[index], ok: event.ok };
          break;
        }
      }
      return { ...c, entries };
    });
  };

  const endTurn = (key: string, error?: string) => {
    update(key, (c) => {
      c.entries.forEach((e) => streaming.delete(e.id));
      const entries = error ? [...c.entries, { id: newRunnerId(), role: "error" as const, text: error }] : c.entries;
      return { ...c, status: "idle", pendingPermissions: [], entries };
    });
  };

  onRunnerMessage((msg: RunnerOutbound) => {
    if (msg.type === "error" && msg.message === "RUNNER_EXITED" && !msg.sessionId) {
      for (const key of Object.keys(get().chats)) {
        const c = get().chats[key];
        // Skip chats with nothing in flight (no session, already idle): the
        // runner dying doesn't affect them, so don't spam an error entry.
        if (!c || (c.sessionId === null && c.status === "idle")) continue;
        update(key, (cur) => ({ ...cur, sessionId: null, status: "idle", pendingPermissions: [] }));
        append(key, { id: newRunnerId(), role: "error", text: "RUNNER_EXITED" });
      }
      streaming.clear();
      return;
    }
    if (!("sessionId" in msg) || !msg.sessionId) return;
    const key = keyForSession(msg.sessionId);
    if (!key) return;
    switch (msg.type) {
      case "event":
        applyEvent(key, msg.event);
        break;
      case "permission_request":
        update(key, (c) => ({
          ...c,
          pendingPermissions: [...c.pendingPermissions, { permissionId: msg.permissionId, request: msg.request }],
        }));
        break;
      case "turn_completed":
      case "turn_cancelled":
        endTurn(key);
        break;
      case "turn_failed":
        endTurn(key, msg.message);
        break;
      case "error":
        // Errors answering a request (e.g. start_session) are reported by the requester.
        if (!msg.requestId) endTurn(key, msg.message);
        break;
    }
  });

  return {
    selectedTab: "opencode",
    availability: {},
    chats: {},

    setSelectedTab: (tab) => set({ selectedTab: tab }),

    probe: async (provider) => {
      try {
        const res = await requestRunner({ type: "probe", requestId: newRunnerId(), provider }, "availability");
        set((s) => ({ availability: { ...s.availability, [provider]: res.availability } }));
      } catch (error) {
        set((s) => ({ availability: { ...s.availability, [provider]: { kind: "error", detail: message(error) } } }));
      }
    },

    newSession: async (folder, provider, resumeNativeId) => {
      const key = chatKey(folder, provider);
      const previous = get().chats[key]?.sessionId;
      if (previous) {
        // Mark the old chat as starting (not idle) and drop any pending
        // permission before waiting on the close: this blocks `send` for
        // the whole window and keeps the UI from showing a stale
        // busy/pending state while the runner is tearing the session down.
        update(key, (c) => ({ ...c, status: "starting", pendingPermissions: [] }));
        await sendToRunner({ type: "close_session", sessionId: previous }).catch(() => undefined);
      }
      const sessionId = newRunnerId();
      update(key, (c) => {
        // Drop the discarded entries' ids from the streaming set so it
        // doesn't grow with ids that no longer belong to any entry.
        c.entries.forEach((e) => streaming.delete(e.id));
        return { ...emptyChat, sessionId, status: "starting" };
      });
      try {
        await requestRunner(
          {
            type: "start_session",
            requestId: newRunnerId(),
            sessionId,
            provider,
            workingDirectory: folder,
            permission: "cli-default",
            ...(resumeNativeId ? { resumeNativeId } : {}),
          },
          "session_started",
        );
        // A newer newSession (or a RUNNER_EXITED reset) may have superseded
        // this attempt while it was in flight; don't clobber its state.
        if (get().chats[key]?.sessionId !== sessionId) return;
        update(key, (c) => ({ ...c, status: "idle" }));
      } catch (error) {
        if (get().chats[key]?.sessionId !== sessionId) return;
        update(key, (c) => ({ ...c, sessionId: null, status: "idle" }));
        append(key, { id: newRunnerId(), role: "error", text: message(error) });
      }
    },

    send: async (folder, provider, text) => {
      const key = chatKey(folder, provider);
      const current = get().chats[key] ?? emptyChat;
      if (current.status !== "idle") return false;
      if (!current.sessionId) await get().newSession(folder, provider);
      const sessionId = get().chats[key]?.sessionId;
      if (!sessionId) return false;
      append(key, { id: newRunnerId(), role: "user", text });
      update(key, (c) => ({ ...c, status: "running" }));
      try {
        await sendToRunner({ type: "send", sessionId, text });
        return true;
      } catch (error) {
        endTurn(key, message(error));
        return false;
      }
    },

    cancel: async (folder, provider) => {
      const sessionId = get().chats[chatKey(folder, provider)]?.sessionId;
      if (sessionId) await sendToRunner({ type: "cancel", sessionId }).catch(() => undefined);
    },

    respondPermission: async (folder, provider, allow) => {
      const key = chatKey(folder, provider);
      const chat = get().chats[key];
      const head = chat?.pendingPermissions[0];
      if (!chat?.sessionId || !head) return;
      // Dequeue only the head: later requests in the queue remain pending
      // and are answered by subsequent calls.
      update(key, (c) => ({ ...c, pendingPermissions: c.pendingPermissions.slice(1) }));
      await sendToRunner({ type: "respond_permission", sessionId: chat.sessionId, permissionId: head.permissionId, allow }).catch(
        (error: unknown) => endTurn(key, message(error)),
      );
    },

    listSessions: async (folder, provider) => {
      const res = await requestRunner(
        { type: "list_sessions", requestId: newRunnerId(), provider, workingDirectory: folder },
        "session_list",
      );
      return res.sessions;
    },
  };
});

import { useEffect } from "react";
import { create } from "zustand";
import i18n from "@/shared/i18n";
import { useTabStore } from "@/stores/tab-store";
import { useClaudeSessionStore } from "@/stores/claude-session-store";
import { ensureCommand, NODE_INSTALL_URL } from "@/shared/lib/ensureCommand";
import {
  evaluateStall,
  STALL_TICK_MS,
} from "@/features/opencode-config/hooks/stall-watchdog";
import {
  spawnSidecar,
  sendToSidecar,
  killSidecar,
  subscribeSidecar,
} from "../lib/claude-sidecar-client";
import {
  applySdkEvent,
  appendUserMessage,
  emptyChatModel,
  type ChatModelState,
} from "../lib/claude-message-mapper";
import type {
  SidecarOutbound,
  SidecarPermissionRequest,
} from "@/shared/types/claude-sidecar";

export const CLAUDE_INSTALL_URL = "https://code.claude.com/docs/";

interface ClaudeChatUIState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  chat: ChatModelState;
  pendingPermission: SidecarPermissionRequest | null;
  stallNotice: boolean;
  lastEventAt: number;
}

export const useClaudeChatStore = create<ClaudeChatUIState>()(() => ({
  connected: false,
  connecting: false,
  error: null,
  chat: emptyChatModel(),
  pendingPermission: null,
  stallNotice: false,
  lastEventAt: 0,
}));

// Module-level singleton connection (mirrors the useOpencodeChat pattern).
let _sidecarId: number | null = null;
let _folder: string | null = null;
let _unsubscribe: (() => void) | null = null;
// Prevents doClaudeConnect from running concurrently (guard-then-await race).
let _connectInFlight = false;
// Folder requested by a connect call that raced an in-flight connect; consumed
// once the in-flight connect finishes so the request isn't silently dropped.
let _pendingFolder: string | null = null;
// Bumped whenever killClaudeSidecar runs so an in-flight connect attempt can
// detect it was superseded and avoid publishing a now-orphaned sidecar.
let _generation = 0;

function setState(patch: Partial<ClaudeChatUIState>): void {
  useClaudeChatStore.setState(patch);
}

function handleSidecarMessage(msg: SidecarOutbound): void {
  const st = useClaudeChatStore.getState();
  switch (msg.type) {
    case "ready": {
      // Sidecar booted; start (or resume) the session.
      if (_sidecarId === null || _folder === null) return;
      const folder = _folder;
      const settings = useClaudeSessionStore.getState().getFolderSettings(folder);
      void sendToSidecar(_sidecarId, {
        type: "start_session",
        cwd: folder,
        model: settings.model || undefined,
        permissionMode: settings.permissionMode,
        resumeSessionId: settings.lastSessionId ?? undefined,
      }).catch((e) => setState({ error: String(e) }));
      setState({ connected: true, connecting: false, error: null });
      break;
    }
    case "sdk_event": {
      const chat = applySdkEvent(st.chat, msg.event);
      if (chat.sessionId && chat.sessionId !== st.chat.sessionId && _folder) {
        useClaudeSessionStore.getState().setLastSessionId(_folder, chat.sessionId);
      }
      setState({ chat, lastEventAt: Date.now(), stallNotice: false });
      break;
    }
    case "permission_request":
      setState({ pendingPermission: msg, lastEventAt: Date.now() });
      break;
    case "error": {
      const message =
        msg.message === "CLAUDE_CLI_NOT_FOUND"
          ? i18n.t("claudeCliNotFound", { ns: "claude-config" })
          : msg.message;
      setState({ error: message });
      if (msg.fatal) setState({ connected: false, connecting: false });
      break;
    }
    case "session_closed":
      setState({ chat: { ...st.chat, running: false } });
      break;
  }
}

export async function doClaudeConnect(folder: string): Promise<void> {
  if (_sidecarId !== null && _folder === folder) return;
  if (_connectInFlight) {
    _pendingFolder = folder;
    return;
  }
  _connectInFlight = true;
  try {
    await killClaudeSidecar();
    // Snapshot the generation after the kill above; if another kill happens
    // while we're still awaiting spawn/subscribe below, this attempt is stale.
    const gen = _generation;

    const nodeOk = await ensureCommand("node", {
      messageKey: "nodeNotFound",
      promptKey: "openInstallGuide",
      installUrl: NODE_INSTALL_URL,
    });
    if (!nodeOk) {
      setState({ error: i18n.t("nodeNotFound", { ns: "common" }) });
      return;
    }

    setState({ connecting: true, error: null, chat: emptyChatModel() });
    _folder = folder;
    let id: number;
    try {
      id = await spawnSidecar(folder);
    } catch (e) {
      setState({ connecting: false, error: String(e) });
      _folder = null;
      return;
    }
    if (gen !== _generation) {
      // A kill happened while spawning; this sidecar is already orphaned.
      await killSidecar(id).catch(() => {});
      return;
    }
    _sidecarId = id;
    const unsubscribe = await subscribeSidecar(id, {
      onMessage: handleSidecarMessage,
      onStderr: (line) => console.warn("[claude][diag]", line),
      onExit: () => {
        _sidecarId = null;
        _unsubscribe?.();
        _unsubscribe = null;
        setState({ connected: false, connecting: false });
      },
    });
    if (gen !== _generation) {
      // A kill happened while subscribing; tear down this now-stale sidecar.
      unsubscribe();
      await killSidecar(id).catch(() => {});
      return;
    }
    _unsubscribe = unsubscribe;
  } finally {
    _connectInFlight = false;
    const pending = _pendingFolder;
    _pendingFolder = null;
    if (pending !== null) void doClaudeConnect(pending);
  }
}

/**
 * Prefix outgoing messages with the file currently open in the editor so the
 * agent knows what the user is looking at (same idea as wrapWithMdiumContext
 * in useOpencodeChat, but sourced from the tab store).
 */
function wrapWithFileContext(text: string): string {
  const active = useTabStore.getState().getActiveTab();
  if (!active?.filePath) return text;
  return `<mdium_context>\nactive_file="${active.filePath.replace(/"/g, '\\"')}"\n</mdium_context>\n\n${text}`;
}

export async function doClaudeSend(text: string): Promise<void> {
  if (_sidecarId === null) return;
  const st = useClaudeChatStore.getState();
  setState({ chat: appendUserMessage(st.chat, text), lastEventAt: Date.now() });
  try {
    await sendToSidecar(_sidecarId, { type: "user_message", text: wrapWithFileContext(text) });
  } catch (e) {
    setState({ error: String(e) });
  }
}

export async function doClaudeInterrupt(): Promise<void> {
  if (_sidecarId === null) return;
  try {
    await sendToSidecar(_sidecarId, { type: "interrupt" });
  } catch (e) {
    setState({ error: String(e) });
  }
  const st = useClaudeChatStore.getState();
  setState({ chat: { ...st.chat, running: false }, pendingPermission: null });
}

export async function doClaudeRespondPermission(
  id: string,
  behavior: "allow" | "deny",
): Promise<void> {
  if (_sidecarId === null) return;
  setState({ pendingPermission: null });
  try {
    await sendToSidecar(_sidecarId, { type: "permission_response", id, behavior });
  } catch (e) {
    setState({ error: String(e) });
  }
}

export async function doClaudeNewSession(): Promise<void> {
  if (_folder) useClaudeSessionStore.getState().setLastSessionId(_folder, null);
  const folder = _folder;
  await killClaudeSidecar();
  if (folder) await doClaudeConnect(folder);
}

/** Kill the sidecar (app shutdown / folder close). Safe to call when idle. */
export async function killClaudeSidecar(): Promise<void> {
  _generation++;
  _pendingFolder = null;
  const id = _sidecarId;
  _sidecarId = null;
  _folder = null;
  _unsubscribe?.();
  _unsubscribe = null;
  useClaudeChatStore.setState({
    connected: false,
    connecting: false,
    pendingPermission: null,
    chat: emptyChatModel(),
  });
  if (id !== null) {
    try {
      await sendToSidecar(id, { type: "stop" });
    } catch {
      // already gone
    }
    await killSidecar(id).catch(() => {});
  }
}

export function useClaudeChat() {
  const state = useClaudeChatStore();

  // Soft stall watchdog: only the "still waiting" notice for the MVP.
  useEffect(() => {
    const timer = setInterval(() => {
      const s = useClaudeChatStore.getState();
      const action = evaluateStall({
        now: Date.now(),
        lastEventAt: s.lastEventAt,
        loading: s.chat.running,
        aborted: false,
        noticeShown: s.stallNotice,
      });
      if (action === "notice") setState({ stallNotice: true });
    }, STALL_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return {
    connected: state.connected,
    connecting: state.connecting,
    error: state.error,
    chat: state.chat,
    pendingPermission: state.pendingPermission,
    stallNotice: state.stallNotice,
    connect: doClaudeConnect,
    sendMessage: doClaudeSend,
    interrupt: doClaudeInterrupt,
    respondPermission: doClaudeRespondPermission,
    newSession: doClaudeNewSession,
  };
}

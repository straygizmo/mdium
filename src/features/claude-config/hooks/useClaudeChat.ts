import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import i18n from "@/shared/i18n";
import { useTabStore } from "@/stores/tab-store";
import { useClaudeSessionStore } from "@/stores/claude-session-store";
import { parseTranscript } from "../lib/claude-transcript";
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

export interface ClaudeSessionInfo {
  id: string;
  title: string;
  /** Milliseconds since the Unix epoch (transcript last-modified time). */
  updatedAt: number;
}

interface ClaudeChatUIState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  chat: ChatModelState;
  pendingPermissions: SidecarPermissionRequest[];
  stallNotice: boolean;
  lastEventAt: number;
  sessions: ClaudeSessionInfo[];
  // The `claude` CLI could not be found on the machine; surfaced as a distinct
  // status so the badge can say "CLI not installed" instead of "disconnected".
  cliMissing: boolean;
}

export const useClaudeChatStore = create<ClaudeChatUIState>()(() => ({
  connected: false,
  connecting: false,
  error: null,
  chat: emptyChatModel(),
  pendingPermissions: [],
  stallNotice: false,
  lastEventAt: 0,
  cliMissing: false,
  sessions: [],
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
      setState({
        pendingPermissions: [...st.pendingPermissions, msg],
        lastEventAt: Date.now(),
      });
      break;
    case "error": {
      // The message may be the bare sentinel (from the entry point) or wrapped
      // as "Error: CLAUDE_CLI_NOT_FOUND" (from the SDK start path), so match on
      // substring.
      const cliMissing = msg.message.includes("CLAUDE_CLI_NOT_FOUND");
      const message = cliMissing
        ? i18n.t("claudeCliNotFound", { ns: "claude-config" })
        : msg.message;
      setState({ error: message, ...(cliMissing ? { cliMissing: true } : {}) });
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

    setState({ connecting: true, error: null, chat: emptyChatModel(), cliMissing: false });
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
        // A crash mid-turn must not leave Stop/permission cards stuck as
        // dead controls: reset running state and drop any queued permission
        // requests along with the connection state.
        const current = useClaudeChatStore.getState();
        setState({
          connected: false,
          connecting: false,
          chat: { ...current.chat, running: false },
          pendingPermissions: [],
        });
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
  setState({ chat: { ...st.chat, running: false }, pendingPermissions: [] });
}

export async function doClaudeRespondPermission(
  id: string,
  behavior: "allow" | "deny",
): Promise<void> {
  if (_sidecarId === null) return;
  setState({
    pendingPermissions: useClaudeChatStore
      .getState()
      .pendingPermissions.filter((p) => p.id !== id),
  });
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

/** The folder whose sessions we operate on: the live one, or the active tab's. */
function currentFolder(): string | null {
  return _folder ?? useTabStore.getState().activeFolderPath;
}

interface RawClaudeSession {
  id: string;
  title: string;
  updated_at: number;
}

/** Load the list of past Claude sessions for the current folder into the store. */
export async function doClaudeGetSessions(): Promise<void> {
  const folder = currentFolder();
  if (!folder) return;
  try {
    const raw = await invoke<RawClaudeSession[]>("list_claude_sessions", { folder });
    setState({
      sessions: raw.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updated_at })),
    });
  } catch (e) {
    setState({ error: String(e) });
  }
}

/**
 * Restore a past session: reconnect the sidecar resuming that session id (so new
 * turns continue it) and reconstruct its transcript for display. The transcript
 * is applied after connect so the connecting-time reset doesn't wipe it.
 */
export async function doClaudeLoadSession(id: string): Promise<void> {
  const folder = currentFolder();
  if (!folder) return;
  useClaudeSessionStore.getState().setLastSessionId(folder, id);
  await killClaudeSidecar();
  await doClaudeConnect(folder);
  try {
    const raw = await invoke<string>("read_claude_session", { folder, sessionId: id });
    const messages = parseTranscript(raw);
    const st = useClaudeChatStore.getState();
    setState({ chat: { ...st.chat, messages, sessionId: id } });
  } catch (e) {
    setState({ error: String(e) });
  }
}

/** Delete a past session's transcript and drop it from the list. */
export async function doClaudeDeleteSession(id: string): Promise<void> {
  const folder = currentFolder();
  if (!folder) return;
  try {
    await invoke("delete_claude_session", { folder, sessionId: id });
    // If the deleted session was queued for resume, forget it.
    if (useClaudeSessionStore.getState().getFolderSettings(folder).lastSessionId === id) {
      useClaudeSessionStore.getState().setLastSessionId(folder, null);
    }
    setState({
      sessions: useClaudeChatStore.getState().sessions.filter((s) => s.id !== id),
    });
  } catch (e) {
    setState({ error: String(e) });
  }
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
    pendingPermissions: [],
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
    // Consumer-facing API keeps the singular name/shape (only the oldest
    // queued request is shown at a time); the store holds the full queue so
    // requests don't overwrite each other (see pendingPermissions).
    pendingPermission: state.pendingPermissions[0] ?? null,
    stallNotice: state.stallNotice,
    cliMissing: state.cliMissing,
    sessions: state.sessions,
    connect: doClaudeConnect,
    sendMessage: doClaudeSend,
    interrupt: doClaudeInterrupt,
    respondPermission: doClaudeRespondPermission,
    newSession: doClaudeNewSession,
    getSessions: doClaudeGetSessions,
    loadSession: doClaudeLoadSession,
    deleteSession: doClaudeDeleteSession,
  };
}

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SidecarInbound, SidecarOutbound } from "@/shared/types/claude-sidecar";

interface SidecarLinePayload {
  id: number;
  line: string;
}
interface SidecarExitPayload {
  id: number;
  code: number | null;
}

// `cwd` is kept as a parameter (rather than dropped) because callers still
// need to route the user's project folder to the sidecar -- it just no
// longer travels via the OS process's working directory (a security risk
// when the folder is untrusted; see spawn_claude_sidecar in
// src-tauri/src/commands/claude_sidecar.rs). Instead the caller sends it as
// part of the `start_session` message once the sidecar is up.
export async function spawnSidecar(cwd: string): Promise<number> {
  void cwd;
  const scriptPath = await invoke<string>("resolve_claude_sidecar_path");
  return invoke<number>("spawn_claude_sidecar", { scriptPath });
}

export function sendToSidecar(id: number, msg: SidecarInbound): Promise<void> {
  return invoke("write_claude_sidecar", { id, line: JSON.stringify(msg) });
}

export function killSidecar(id: number): Promise<void> {
  return invoke("kill_claude_sidecar", { id });
}

export function parseSidecarLine(line: string): SidecarOutbound | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as SidecarOutbound;
    }
  } catch {
    // fall through
  }
  return null;
}

export interface SidecarHandlers {
  onMessage(msg: SidecarOutbound): void;
  onStderr(line: string): void;
  onExit(code: number | null): void;
}

/** Subscribe to one sidecar's events. Returns a combined unlisten function. */
export async function subscribeSidecar(
  id: number,
  handlers: SidecarHandlers,
): Promise<() => void> {
  const unlisteners = await Promise.all([
    listen<SidecarLinePayload>("claude-sidecar://line", (e) => {
      if (e.payload.id !== id) return;
      const msg = parseSidecarLine(e.payload.line);
      if (msg) handlers.onMessage(msg);
      else console.warn("[claude][diag] unparseable sidecar line:", e.payload.line);
    }),
    listen<SidecarLinePayload>("claude-sidecar://stderr", (e) => {
      if (e.payload.id === id) handlers.onStderr(e.payload.line);
    }),
    listen<SidecarExitPayload>("claude-sidecar://exit", (e) => {
      if (e.payload.id === id) handlers.onExit(e.payload.code);
    }),
  ]);
  return () => unlisteners.forEach((u) => u());
}

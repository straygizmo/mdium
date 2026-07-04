import type {
  SidecarInbound,
  SidecarOutbound,
  StartSessionMessage,
} from "../src/shared/types/claude-sidecar";

/** Structural subset of the SDK's PermissionResult. */
export type PermissionResultLike =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<PermissionResultLike>;

/** Minimal user message shape for the SDK's streaming-input mode. */
export interface SdkUserMessageLike {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/** Structural subset of the SDK Query object the core needs. */
export interface SidecarQueryHandle extends AsyncIterable<Record<string, unknown>> {
  interrupt(): Promise<void>;
}

export interface SidecarCoreDeps {
  startQuery(
    prompt: AsyncIterable<SdkUserMessageLike>,
    startMsg: StartSessionMessage,
    canUseTool: CanUseToolFn,
  ): SidecarQueryHandle;
  send(msg: SidecarOutbound): void;
}

/**
 * Protocol brain of the sidecar, kept free of process/stdio concerns so it can
 * be unit-tested. The entry point wires it to stdin/stdout and the real SDK.
 */
export class SidecarCore {
  private queue: SdkUserMessageLike[] = [];
  private wake: (() => void) | null = null;
  private stopped = false;
  private permSeq = 0;
  private pendingPermissions = new Map<string, (r: PermissionResultLike) => void>();
  private query: SidecarQueryHandle | null = null;

  constructor(private deps: SidecarCoreDeps) {}

  handleLine(line: string): void {
    let msg: SidecarInbound;
    try {
      msg = JSON.parse(line) as SidecarInbound;
    } catch {
      this.deps.send({ type: "error", message: `unparseable input line: ${line.slice(0, 200)}` });
      return;
    }
    switch (msg.type) {
      case "start_session":
        this.startSession(msg);
        break;
      case "user_message":
        this.queue.push({
          type: "user",
          message: { role: "user", content: msg.text },
          parent_tool_use_id: null,
          session_id: "",
        });
        this.wake?.();
        this.wake = null;
        break;
      case "permission_response": {
        const resolve = this.pendingPermissions.get(msg.id);
        if (resolve) {
          this.pendingPermissions.delete(msg.id);
          if (msg.behavior === "allow") {
            resolve({ behavior: "allow", updatedInput: this.permInputs.get(msg.id) ?? {} });
          } else {
            resolve({ behavior: "deny", message: msg.message ?? "Denied by user" });
          }
          this.permInputs.delete(msg.id);
        }
        break;
      }
      case "interrupt":
        void this.query?.interrupt();
        break;
      case "stop":
        this.shutdownSession();
        break;
    }
  }

  /** Original tool inputs kept so an "allow" can echo them back as updatedInput. */
  private permInputs = new Map<string, Record<string, unknown>>();

  private canUseTool: CanUseToolFn = (toolName, input) =>
    new Promise<PermissionResultLike>((resolve) => {
      const id = `perm-${++this.permSeq}`;
      this.pendingPermissions.set(id, resolve);
      this.permInputs.set(id, input);
      this.deps.send({ type: "permission_request", id, toolName, input });
    });

  private async *inputStream(): AsyncGenerator<SdkUserMessageLike> {
    while (!this.stopped) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else {
        await new Promise<void>((r) => (this.wake = r));
      }
    }
  }

  private startSession(msg: StartSessionMessage): void {
    this.stopped = false;
    try {
      this.query = this.deps.startQuery(this.inputStream(), msg, this.canUseTool);
    } catch (e) {
      this.deps.send({ type: "error", message: String(e), fatal: true });
      return;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.query!) {
        this.deps.send({ type: "sdk_event", event });
      }
    } catch (e) {
      this.deps.send({ type: "error", message: String(e) });
    } finally {
      this.shutdownSession();
    }
  }

  private shutdownSession(): void {
    if (this.stopped) return;
    this.stopped = true;
    // Resolve dangling permission prompts so the SDK's awaits never leak.
    for (const [id, resolve] of this.pendingPermissions) {
      resolve({ behavior: "deny", message: "Session stopped" });
      this.permInputs.delete(id);
    }
    this.pendingPermissions.clear();
    this.wake?.();
    this.wake = null;
    this.deps.send({ type: "session_closed" });
  }
}

import {
  FLOW_APPROVAL_REQUESTED_EVENT,
  FLOW_NODE_CHANGED_EVENT,
  FLOW_PROGRESS_EVENT,
  FLOW_RUN_CHANGED_EVENT,
  FLOW_SETUP_PROGRESS_EVENT,
} from "@/shared/types/flow-run";

/** The backend events a transport can deliver (`flow://...`). */
export type FlowEventName =
  | typeof FLOW_RUN_CHANGED_EVENT
  | typeof FLOW_NODE_CHANGED_EVENT
  | typeof FLOW_PROGRESS_EVENT
  | typeof FLOW_APPROVAL_REQUESTED_EVENT
  | typeof FLOW_SETUP_PROGRESS_EVENT;

/**
 * How the flow UI reaches the engine. The desktop app talks to Tauri
 * commands and events; the web front talks HTTP and WebSocket. Command
 * names and argument objects are identical across transports.
 */
export interface FlowTransport {
  /** Invokes one engine command with its camelCase argument object. */
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  /** Subscribes to one event; resolves to the unsubscribe function. */
  subscribe<T>(event: FlowEventName, handler: (payload: T) => void): Promise<() => void>;
}

let current: FlowTransport | null = null;
let fallback: FlowTransport | null = null;

/** Registers the transport the flow UI uses; `null` restores the default (Tauri). */
export function setFlowTransport(transport: FlowTransport | null): void {
  current = transport;
}

/** The registered transport, or the lazily created Tauri transport. */
export function getFlowTransport(): FlowTransport {
  if (current) return current;
  if (!fallback) fallback = createDefaultTransport();
  return fallback;
}

/* The default is injected by `tauri-transport.ts` at module load so this
 * module stays free of `@tauri-apps/*` imports (spec 2026-10-10, 10.2). */
let createDefaultTransport: () => FlowTransport = () => {
  throw new Error("no default FlowTransport registered");
};

/** Called once by the default transport module to register its factory. */
export function registerDefaultTransport(factory: () => FlowTransport): void {
  createDefaultTransport = factory;
}

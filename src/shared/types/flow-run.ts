/**
 * TypeScript mirrors of flow runs (`src-tauri/src/flow/run/`,
 * `src-tauri/src/commands/flow_run.rs`). Field names are camelCase as
 * serialized by serde; optional fields are omitted when unset.
 */
import type { FlowDef } from "./flow";

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "stopping"
  | "paused"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "awaiting_approval"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "interrupted";

/** A machine-readable reason; the UI localizes `code` with `params`. */
export interface Reason {
  code: string;
  params?: Record<string, unknown>;
}

export interface ApprovalRequest {
  /** Absent for the run-level budget approval. */
  nodeKey?: string;
  options: string[];
  message?: string;
  show?: Record<string, unknown>;
  reason: Reason;
}

export interface CostTotals {
  actual: number;
  estimated: number;
}

export interface NodeState {
  status: NodeStatus;
  attempt: number;
  port?: string;
  reason?: Reason;
  outputs?: Record<string, unknown>;
  artifacts?: Array<{ path: string; label?: string }>;
  progress?: { text: string; fraction?: number };
  cost: CostTotals;
  costReported: boolean;
  process?: { pid: number; startedAt: string; exitFile?: string };
  startedAt?: string;
  finishedAt?: string;
}

export interface RunState {
  seq: number;
  status: RunStatus;
  reason?: Reason;
  nodes: Record<string, NodeState>;
  cost: CostTotals;
  approvals?: ApprovalRequest[];
  budgetLimitUsd?: number;
  updatedAt?: string;
  /** Scopes by prefix (`""` is the root; `docs[0]/`, `sub/` ...). */
  scopes?: Record<string, { status: "running" | "completed" | "failed"; owner?: string; index?: number }>;
  /** Current pass per `<prefix><id>` (absent = 1). */
  passes?: Record<string, number>;
}

/** `(prefix, id, pass)` of a node instance key like `docs[2]/check@2`. */
export function splitNodeKey(key: string): { prefix: string; id: string; pass: number } {
  const cut = key.lastIndexOf("/") + 1;
  const prefix = key.slice(0, cut);
  const last = key.slice(cut);
  const at = last.indexOf("@");
  return at < 0
    ? { prefix, id: last, pass: 1 }
    : { prefix, id: last.slice(0, at), pass: Number(last.slice(at + 1)) || 1 };
}

/** The instance is its node's current pass in a live scope (older passes are history). */
export function isLiveInstance(state: RunState, key: string): boolean {
  const { prefix, id, pass } = splitNodeKey(key);
  const current = state.passes?.[`${prefix}${id}`] ?? 1;
  const scope = state.scopes?.[prefix];
  const live = prefix === "" ? scope?.status !== "failed" : scope?.status === "running";
  return current === pass && live;
}

export interface RunMeta {
  schemaVersion: number;
  runId: string;
  flowPath: string;
  flowSha256: string;
  flow: FlowDef;
  params: Record<string, unknown>;
  createdAt: string;
  startedBy: string;
}

export interface RunSnapshot {
  meta: RunMeta;
  state: RunState;
  /** A driver works on the run in this app process. */
  active: boolean;
}

export interface RunSummary {
  runId: string;
  flowPath: string;
  flowName: string;
  status: RunStatus;
  reason?: Reason;
  createdAt: string;
  updatedAt?: string;
  costUsd: number;
  pendingApprovals: number;
}

export interface CommandSummary {
  /** Project-relative flow file that defines the command. */
  file: string;
  /** Enclosing loop ids (inline loop bodies), outermost first. */
  within?: string[];
  nodeId: string;
  /** argv array or shell string, unexpanded. */
  run: string[] | string;
  shell: boolean;
  workingDir?: string;
  env: Record<string, string>;
  templated: boolean;
}

export interface CommandReview {
  path: string;
  sha256: string;
  confirmed: boolean;
  commands: CommandSummary[];
}

/** Command failures of run operations (plus `details`). */
export interface FlowRunError {
  code: string;
  message: string;
  details?: Reason[];
}

export const FLOW_RUN_CHANGED_EVENT = "flow://run-changed";
export const FLOW_NODE_CHANGED_EVENT = "flow://node-changed";
export const FLOW_PROGRESS_EVENT = "flow://progress";
export const FLOW_APPROVAL_REQUESTED_EVENT = "flow://approval-requested";

export interface RunChangedEvent {
  projectRoot: string;
  runId: string;
  status: RunStatus;
  seq: number;
  costUsd: number;
  pendingApprovals: number;
}

export interface NodeChangedEvent {
  projectRoot: string;
  runId: string;
  nodeKey: string;
  status: NodeStatus;
  attempt: number;
  costUsd: number;
  seq: number;
}

export interface ProgressEvent {
  projectRoot: string;
  runId: string;
  nodeKey: string;
  text: string;
  fraction?: number;
}

export interface ApprovalRequestedEvent {
  projectRoot: string;
  runId: string;
  nodeKey?: string;
  message?: string;
  reason: Reason;
}

/** Run statuses in which a driver is (or should be) working. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["running", "awaiting_approval", "stopping"];

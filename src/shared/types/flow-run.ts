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

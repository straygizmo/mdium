/**
 * TypeScript mirrors of the generic flow engine's definition model and
 * Tauri command payloads (`src-tauri/src/flow/`, `src-tauri/src/commands/flow.rs`).
 * Field names are the camelCase names used on disk and by serde.
 *
 * Flow files: `<project>/.mdium/flows/*.flow.yaml` (primary), `*.flow.yml`,
 * or `*.flow.json`. Spec: `.superpowers/specs/2026-10-06-generic-flow-engine-design.md`.
 *
 * Decoded output omits optional fields that are unset (serde
 * `skip_serializing_if`), so every optional field here may be absent.
 */

export type FlowFormat = "yaml" | "json";

/** Which coding agent runs an `agent` node (same set as the dev workflow). */
export type FlowAgentProvider = "codex" | "copilot" | "opencode" | "claude";

export type FlowParamType = "string" | "number" | "bool" | "path";

export interface FlowParamDef {
  type: FlowParamType;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export type FlowRetryOn = "failed" | "timeout";

export interface FlowRetryPolicy {
  max: number;
  /** Duration: `<n>s`, `<n>m` or `<n>h`. */
  backoff?: string;
  on?: FlowRetryOn[];
}

export interface FlowNodeDefaults {
  timeout?: string;
  retry?: FlowRetryPolicy;
  workingDir?: string;
}

export interface FlowLimits {
  maxConcurrentNodes?: number;
  budgetUsd?: number;
  stopGrace?: string;
}

export interface FlowCostSpec {
  estimateUsd?: number;
  budgetUsd?: number;
}

export type FlowCompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "exists";

/** A condition: one comparison, or `all` / `any` / `not` of conditions. */
export type FlowCondition =
  | { ref: string; op: FlowCompareOp; value?: string | number | boolean | Array<string | number | boolean> }
  | { all: FlowCondition[] }
  | { any: FlowCondition[] }
  | { not: FlowCondition };

/** Attributes shared by every node kind. */
export interface FlowNodeCommon {
  id: string;
  name?: string;
  description?: string;
  timeout?: string;
  retry?: FlowRetryPolicy;
  cost?: FlowCostSpec;
  when?: FlowCondition;
  concurrencyKey?: string;
}

export interface FlowAgentNode extends FlowNodeCommon {
  kind: "agent";
  provider: FlowAgentProvider;
  model?: string;
  prompt?: string;
  /** File-relative path, or `builtin:<name>`. */
  promptRef?: string;
  permission: "read-only" | "full-access";
  outputContract: "outcome" | "free";
  policy?: unknown;
  workingDir?: string;
}

export interface FlowCommandNode extends FlowNodeCommon {
  kind: "command";
  /** argv array, or a shell string when `shell` is true. */
  run: string[] | string;
  shell: boolean;
  workingDir?: string;
  env?: Record<string, string>;
  successCodes?: number[];
  protocol: "mdium-v1" | "none";
  detach?: boolean;
}

export interface FlowApprovalNode extends FlowNodeCommon {
  kind: "approval";
  message?: string;
  show?: string[];
  /** Output ports; defaults to `["approve", "reject"]`. */
  options?: string[];
}

export interface FlowInlineBody {
  nodes: FlowNode[];
  edges?: FlowEdge[];
  outputs?: Record<string, string>;
}

export interface FlowLoopNode extends FlowNodeCommon {
  kind: "loop";
  mode: "foreach" | "while";
  items?: string | unknown[];
  until?: FlowCondition;
  maxIterations?: number;
  parallelism?: number;
  /** File-relative flow path, or an inline graph. */
  body: string | FlowInlineBody;
  /** Iteration variable name; defaults to `item`. */
  as?: string;
  onItemFailure?: "stop" | "continue";
  params?: Record<string, unknown>;
}

export interface FlowBranchNode extends FlowNodeCommon {
  kind: "branch";
  cases: Array<{ when: FlowCondition; port: string }>;
  default?: string;
}

export interface FlowSubflowNode extends FlowNodeCommon {
  kind: "subflow";
  flow: string;
  params?: Record<string, unknown>;
}

export interface FlowActionNode extends FlowNodeCommon {
  kind: "action";
  /** `mdium/<name>` */
  uses: string;
  with?: Record<string, unknown>;
}

export type FlowNode =
  | FlowAgentNode
  | FlowCommandNode
  | FlowApprovalNode
  | FlowLoopNode
  | FlowBranchNode
  | FlowSubflowNode
  | FlowActionNode;

export type FlowNodeKind = FlowNode["kind"];

export interface FlowEdge {
  from: string;
  to: string;
  /** Defaults to `success`. */
  port?: string;
  /** Present on back-edges (edges that close a cycle). */
  maxTraversals?: number;
}

export interface FlowDef {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  params?: Record<string, FlowParamDef>;
  defaults?: FlowNodeDefaults;
  limits?: FlowLimits;
  env?: Record<string, string>;
  envPassthrough?: string[];
  nodes: FlowNode[];
  edges?: FlowEdge[];
  outputs?: Record<string, string>;
  /** Editor-only data, opaque to the engine. */
  ui?: unknown;
}

/** Stable validation issue codes (`src-tauri/src/flow/issues.rs`). */
export const FLOW_ERROR_CODES = [
  "FLOW_SCHEMA_UNSUPPORTED",
  "FLOW_PARSE_FAILED",
  "FLOW_DUPLICATE_NODE_ID",
  "FLOW_UNKNOWN_NODE_REF",
  "FLOW_UNKNOWN_PORT",
  "FLOW_CYCLE_WITHOUT_LIMIT",
  "FLOW_LOOP_LIMIT_MISSING",
  "FLOW_SUBFLOW_RECURSION",
  "FLOW_PATH_OUTSIDE_PROJECT",
  "FLOW_TEMPLATE_INVALID",
  "FLOW_ACTION_UNKNOWN",
  "FLOW_PROVIDER_UNAVAILABLE",
  "FLOW_UNKNOWN_FIELD",
  "FLOW_UNKNOWN_NODE_KIND",
  "FLOW_INVALID_VALUE",
  "FLOW_INVALID_ID",
  "FLOW_CONDITION_INVALID",
  "FLOW_REF_NOT_FOUND",
  "FLOW_SUBFLOW_INVALID",
  "FLOW_PARAM_MISMATCH",
  "FLOW_FILE_TOO_LARGE",
] as const;

export const FLOW_WARNING_CODES = [
  "FLOW_UNKNOWN_KEY",
  "FLOW_DEPRECATED_FIELD",
  "FLOW_TRAVERSAL_LIMIT_UNUSED",
] as const;

export type FlowErrorCode = (typeof FLOW_ERROR_CODES)[number];
export type FlowWarningCode = (typeof FLOW_WARNING_CODES)[number];

/** One validation finding; the UI localizes by `code` + `params`. */
export interface FlowIssue {
  code: FlowErrorCode | FlowWarningCode;
  /** Location in the file, e.g. `nodes[2].retry.max` (empty for the whole file). */
  path: string;
  params: Record<string, unknown>;
}

/** `flow_load` / `flow_validate` result. */
export interface FlowLoadResult {
  /** Project-relative path with `/` separators. */
  path: string;
  format: FlowFormat;
  /** `null` when the file could not be parsed or decoded. */
  flow: FlowDef | null;
  errors: FlowIssue[];
  warnings: FlowIssue[];
}

/** One entry of `flow_list`. */
export interface FlowSummary {
  path: string;
  id: string | null;
  name: string | null;
  errorCount: number;
  warningCount: number;
}

/** Codes of command failures (`{ code, message }`). */
export type FlowCommandErrorCode =
  | "FLOW_PROJECT_INVALID"
  | "FLOW_FILE_PATH_INVALID"
  | "FLOW_FILE_NOT_FOUND"
  | "FLOW_LIST_FAILED"
  | "FLOW_COMMAND_FAILED";

export interface FlowCommandError {
  code: FlowCommandErrorCode;
  message: string;
}

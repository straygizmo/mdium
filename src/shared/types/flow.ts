/**
 * TypeScript mirrors of the generic flow engine's definition model and
 * Tauri command payloads (`src-tauri/crates/flow-core/src/`, `src-tauri/src/commands/flow.rs`).
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

export type FlowParamType = "string" | "number" | "bool" | "path" | "object" | "array";

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
  /** A provider, or a template (`${{ params.provider }}`) rendered when the node starts. */
  provider: FlowAgentProvider | (string & {});
  model?: string;
  prompt?: string;
  /** File-relative path, or `builtin:<name>`. */
  promptRef?: string;
  permission: "read-only" | "full-access";
  outputContract: "outcome" | "free";
  policy?: unknown;
  workingDir?: string;
  /** Inputs handed to the agent as data blocks. */
  with?: Record<string, unknown>;
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
  options?: Array<string | { name: string; commentRequired?: boolean }>;
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
  /** Template of an object passed as arguments under `params` (entries the callee does not declare are dropped). */
  paramsFrom?: string;
  /** Project root of the sub-flow scope (templated). */
  projectRoot?: string;
}

export interface FlowActionNode extends FlowNodeCommon {
  kind: "action";
  /** `mdium/<name>` */
  uses: string;
  with?: Record<string, unknown>;
}

/** Runs a stage of a runtime declared in `.mdium/project.yaml`. */
export interface FlowPythonNode extends FlowNodeCommon {
  kind: "python";
  runtime: string;
  entry: string;
  with?: Record<string, unknown>;
}

export type FlowNode =
  | FlowAgentNode
  | FlowCommandNode
  | FlowApprovalNode
  | FlowLoopNode
  | FlowBranchNode
  | FlowSubflowNode
  | FlowActionNode
  | FlowPythonNode;

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

/** Stable validation issue codes (`src-tauri/crates/flow-core/src/issues.rs`). */
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
  "FLOW_TEMPLATE_UNKNOWN",
  "FLOW_SUBFLOW_ROOT_INVALID",
  "FLOW_SUBFLOW_PARAMS_INVALID",
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
  "FLOW_OUTPUT_UNKNOWN",
  "FLOW_PARAM_TYPE",
  "FLOW_PROJECT_REQUIRED",
  "FLOW_RUNTIME_UNKNOWN",
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
  kind: FlowKind;
  /** `null` when the file could not be parsed or decoded. */
  flow: FlowDef | null;
  errors: FlowIssue[];
  warnings: FlowIssue[];
  /** The checked text; empty when the file could not be read (the report then carries the error). */
  content: string;
  /** SHA-256 of `content` as the engine read it. */
  sha256: string;
}

export type FlowKind = "entry" | "part";

/** A built-in flow template (`mdium:<name>`), from `flow_template_list`. */
export interface FlowTemplateInfo {
  name: string;
  title: string;
  description: string;
  /** The main flow file, relative to the template directory. */
  main: string;
}

/** One entry of `flow_list`. */
export interface FlowSummary {
  path: string;
  kind: FlowKind;
  /** Role from the manifest's `flows` (e.g. `main`). */
  role?: string;
  id: string | null;
  name: string | null;
  description?: string;
  params: Record<string, FlowParamDef>;
  outputs: string[];
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

/** `.mdium/project.yaml` (spec 2026-10-10, 2.1). */
export interface RuntimeDef {
  kind: "python";
  python: string | string[];
  module: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface SetupStep {
  run: string[];
  workingDir?: string;
}

export interface MetricDef {
  ref: string;
  better: "higher" | "lower";
}

export interface ProjectDef {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  runtimes?: Record<string, RuntimeDef>;
  setup?: SetupStep[];
  /** How to test a copy (`mdium/project-test`), same shape as `setup`. */
  test?: SetupStep[];
  secrets?: string[];
  flows?: Record<string, string>;
  metrics?: MetricDef[];
}

/** `flow_project_load` result. */
export interface ProjectLoadResult {
  exists: boolean;
  path: string;
  /** Hex sha256 of the manifest bytes, when the file exists. */
  sha256?: string;
  project: ProjectDef | null;
  errors: FlowIssue[];
  warnings: FlowIssue[];
}

/** Value type of a python stage input or output. */
export type StageInputType = "string" | "number" | "bool" | "path" | "object" | "array";

export interface StageInput {
  type: StageInputType;
  required: boolean;
  default?: unknown;
  description?: string;
}

export interface StageOutput {
  type?: StageInputType;
  description?: string;
}

export interface StageArtifact {
  label: string;
  mediaType?: string;
}

export interface StageDef {
  name: string;
  description?: string;
  inputs: Record<string, StageInput>;
  outputs: Record<string, StageOutput>;
  artifacts: StageArtifact[];
}

/** A runtime's stage manifest, as reported by its worker (`flow_runtime_describe`). */
export interface Manifest {
  module: string;
  stages: StageDef[];
}

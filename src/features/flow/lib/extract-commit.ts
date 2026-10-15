import type { FlowDef, FlowFormat, FlowIssue } from "@/shared/types/flow";
import { flowApi } from "./flow-api";
import { extractSubflow, type ExtractFailure } from "./extract-subflow";
import { stringifyFlow, stringifyFlowAs } from "./flow-yaml";

const partPathOf = (name: string) => `.mdium/flows/lib/${name}.flow.yaml`;

export type CommitOutcome =
  | { ok: true; partPath: string; updated: FlowDef; newNodePath: string }
  | { ok: false; reason?: ExtractFailure; errors: FlowIssue[] };

/**
 * The caller is validated before the part file exists, so the reference of the new
 * `subflow` node cannot resolve yet. That one issue is expected; every other one counts.
 */
function isPendingPartRef(issue: FlowIssue, newNodePath: string): boolean {
  return issue.code === "FLOW_REF_NOT_FOUND" && issue.path === `${newNodePath}.flow`;
}

/**
 * Extracts the selection into a new part file: validates the part and the updated caller
 * (nothing is written when either has errors), then saves the part. The caller text is
 * applied by the editor store afterwards, so the YAML stays the source of truth; the store
 * re-validates it against the saved part. Save failures are thrown as `FlowCommandError`.
 */
export async function commitExtraction(args: {
  projectRoot: string;
  def: FlowDef;
  selectedPaths: string[];
  name: string;
  currentFile: string;
  /** Format of the caller file; the part is always YAML. */
  format: FlowFormat;
}): Promise<CommitOutcome> {
  const { projectRoot, def, selectedPaths, name, currentFile, format } = args;
  const outcome = extractSubflow(def, selectedPaths, name, currentFile);
  if (!outcome.ok) return { ok: false, reason: outcome.reason, errors: [] };
  const partPath = partPathOf(name);
  const partText = stringifyFlow(outcome.part);
  const [partResult, callerResult] = await Promise.all([
    flowApi.validate(projectRoot, partPath, partText),
    flowApi.validate(projectRoot, currentFile, stringifyFlowAs(outcome.updated, format)),
  ]);
  const callerErrors = callerResult.errors.filter((issue) => !isPendingPartRef(issue, outcome.newNodePath));
  const errors = [...partResult.errors, ...callerErrors];
  if (errors.length > 0) return { ok: false, errors };
  await flowApi.save(projectRoot, partPath, partText, null);
  return { ok: true, partPath, updated: outcome.updated, newNodePath: outcome.newNodePath };
}

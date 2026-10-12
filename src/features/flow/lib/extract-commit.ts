import type { FlowDef, FlowIssue } from "@/shared/types/flow";
import { flowApi } from "./flow-api";
import { extractSubflow, type ExtractFailure } from "./extract-subflow";
import { parentList } from "./editor-state";
import { stringifyFlow } from "./flow-yaml";

const partPathOf = (name: string) => `.mdium/flows/lib/${name}.flow.yaml`;

export type CommitOutcome =
  | { ok: true; partPath: string; updated: FlowDef; newNodePath: string | null }
  | { ok: false; reason?: ExtractFailure; errors: FlowIssue[] };

/** Path of the `subflow` node calling `name` in the scope the selection was taken from. */
function callNodePath(updated: FlowDef, selectedPaths: string[], name: string): string | null {
  const first = selectedPaths[0];
  const cut = first.lastIndexOf("nodes[");
  const { list } = parentList(updated, first);
  const index = list.findIndex((n) => n.kind === "subflow" && n.flow.endsWith(`${name}.flow.yaml`));
  return cut < 0 || index < 0 ? null : `${first.slice(0, cut)}nodes[${index}]`;
}

/**
 * Extracts the selection into a new part file: validates the part and the updated caller
 * (nothing is written when either has errors), then saves the part. The caller text is
 * applied by the editor store afterwards, so the YAML stays the source of truth.
 */
export async function commitExtraction(args: {
  projectRoot: string;
  def: FlowDef;
  selectedPaths: string[];
  name: string;
  currentFile: string;
}): Promise<CommitOutcome> {
  const { projectRoot, def, selectedPaths, name, currentFile } = args;
  const outcome = extractSubflow(def, selectedPaths, name, currentFile);
  if (!outcome.ok) return { ok: false, reason: outcome.reason, errors: [] };
  const partPath = partPathOf(name);
  const partText = stringifyFlow(outcome.part);
  const [partResult, callerResult] = await Promise.all([
    flowApi.validate(projectRoot, partPath, partText),
    flowApi.validate(projectRoot, currentFile, stringifyFlow(outcome.updated)),
  ]);
  const errors = [...partResult.errors, ...callerResult.errors];
  if (errors.length > 0) return { ok: false, errors };
  await flowApi.save(projectRoot, partPath, partText, null);
  return { ok: true, partPath, updated: outcome.updated, newNodePath: callNodePath(outcome.updated, selectedPaths, name) };
}

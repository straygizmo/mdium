import type { FlowNode, FlowSummary, ProjectLoadResult } from "@/shared/types/flow";

/** Props shared by every kind-specific attribute form. */
export interface KindFormProps<N extends FlowNode> {
  node: N;
  path: string;
  /** Reusable parts (candidates for loop bodies and sub-flows). */
  parts: FlowSummary[];
  project: ProjectLoadResult | null;
  /** Project-relative path of the file being edited (decides how parts are referenced). */
  currentFile: string;
  /** Writes a partial patch; an `undefined` value deletes the key. */
  onChange: (path: string, patch: Partial<FlowNode>) => void;
}

/** An empty record serializes as no key at all. */
export function recordOrUndefined<T>(record: Record<string, T>): Record<string, T> | undefined {
  return Object.keys(record).length === 0 ? undefined : record;
}

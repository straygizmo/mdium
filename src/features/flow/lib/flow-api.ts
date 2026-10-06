import { invoke } from "@tauri-apps/api/core";
import type { FlowCommandError, FlowLoadResult, FlowSummary } from "@/shared/types/flow";

/** True for a `{ code, message }` command failure. */
export function isFlowCommandError(value: unknown): value is FlowCommandError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** Invokes a flow command, normalizing command failures to `FlowCommandError`. */
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    let candidate: unknown = err;
    if (typeof err === "string") {
      try {
        candidate = JSON.parse(err);
      } catch {
        throw err;
      }
    }
    if (isFlowCommandError(candidate)) {
      throw { code: candidate.code, message: candidate.message } satisfies FlowCommandError;
    }
    throw err;
  }
}

/**
 * Commands of the generic flow engine (definitions only). Paths are
 * project-relative, e.g. `.mdium/flows/doc-digest.flow.yaml`.
 */
export const flowApi = {
  /** Lists the project's flow files with a validation summary each. */
  list: (projectRoot: string) => call<FlowSummary[]>("flow_list", { projectRoot }),
  /** Reads and validates one flow file. */
  load: (projectRoot: string, path: string) => call<FlowLoadResult>("flow_load", { projectRoot, path }),
  /** Validates unsaved content as if it were the file at `path`. */
  validate: (projectRoot: string, path: string, content: string) =>
    call<FlowLoadResult>("flow_validate", { projectRoot, path, content }),
};

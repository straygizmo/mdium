import { getFlowTransport } from "./transport";
import "./tauri-transport";
import type {
  FlowCommandError,
  FlowLoadResult,
  FlowSummary,
  FlowTemplateInfo,
  Manifest,
  ProjectLoadResult,
} from "@/shared/types/flow";
import { FLOW_SETUP_PROGRESS_EVENT } from "@/shared/types/flow-run";
import type { SetupProgressEvent, SetupResult } from "@/shared/types/flow-run";

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
    return await getFlowTransport().call<T>(command, args);
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
  /**
   * Writes a flow file. `expectedSha256` is the hash the caller loaded
   * (`null` creates a new file); a mismatch fails with `FLOW_FILE_CHANGED`.
   */
  save: (projectRoot: string, path: string, content: string, expectedSha256: string | null) =>
    call<FlowLoadResult>("flow_save", { projectRoot, path, content, expectedSha256 }),
  /** Watches a folder for changes; resolves to the stop function. */
  watchFolder: (folder: string, handler: () => void) => getFlowTransport().watchFolder(folder, handler),
  /** Reads and validates `.mdium/project.yaml`. */
  projectLoad: (projectRoot: string) =>
    call<ProjectLoadResult>("flow_project_load", { projectRoot }),
  /** Runs the manifest's setup steps; progress arrives via `subscribeSetupProgress`. */
  projectSetup: (projectRoot: string, sha256: string) => call<SetupResult>("flow_project_setup", { projectRoot, sha256 }),
  /** Starts the runtime's worker only to read its stage manifest. */
  /** Runs project code: `sha256` is the manifest hash (`projectLoad`) whose runtimes the user was shown. */
  runtimeDescribe: (projectRoot: string, runtime: string, sha256: string) =>
    call<Manifest>("flow_runtime_describe", { projectRoot, runtime, sha256 }),
  /** The built-in flow templates (`mdium:<name>`). */
  listTemplates: (projectRoot: string) => call<FlowTemplateInfo[]>("flow_template_list", { projectRoot }),
  /**
   * Copies a template's flow files into `.mdium/flows/` (the main flow as
   * `<fileName>.flow.yaml`); resolves to the written project-relative paths.
   */
  copyTemplate: (projectRoot: string, template: string, fileName: string) =>
    call<string[]>("flow_template_copy", { projectRoot, template, fileName }),
};

/** Subscribes to setup progress; resolves to the unsubscribe function. */
export function subscribeSetupProgress(handler: (event: SetupProgressEvent) => void): Promise<() => void> {
  return getFlowTransport().subscribe<SetupProgressEvent>(FLOW_SETUP_PROGRESS_EVENT, handler);
}

import { create } from "zustand";
import type { FlowDef, FlowFormat, FlowIssue, FlowKind, FlowLoadResult } from "@/shared/types/flow";
import { flowApi, isFlowCommandError } from "./lib/flow-api";
import { hasComments, stringifyFlow } from "./lib/flow-yaml";
import { showConfirm } from "@/stores/dialog-store";

export type Selection =
  | { kind: "node"; path: string }
  | { kind: "edge"; path: string }
  | { kind: "flow" }
  | null;

export type SaveOutcome = "saved" | "changed-outside" | "error";

/** Quiet period after the last edit before the text is validated. */
export const VALIDATE_DEBOUNCE_MS = 300;

const LIB_PREFIX = ".mdium/flows/lib/";

export interface EditorState {
  projectRoot: string | null;
  path: string | null;
  kind: FlowKind | null;
  format: FlowFormat | null;
  /** Source of truth. */
  text: string;
  /** Hash of the text on disk when loaded / last saved; `null` for a file not yet on disk. */
  savedSha256: string | null;
  /** Last successfully decoded flow (by Rust). */
  def: FlowDef | null;
  errors: FlowIssue[];
  warnings: FlowIssue[];
  dirty: boolean;
  validating: boolean;
  commentWarningPending: boolean;
  selection: Selection;
  externalChange: boolean;
  /** Set when the file could not be read or is too large: the editor is read-only. */
  loadError: string | null;
  /** Error code of the last failed save, if any. */
  saveError: string | null;
  open(projectRoot: string, path: string): Promise<void>;
  openNew(projectRoot: string, path: string, def: FlowDef): void;
  setText(text: string): void;
  applyEdit(edit: (def: FlowDef) => FlowDef): void;
  validateNow(): Promise<void>;
  select(selection: Selection): void;
  save(opts: { overwrite?: boolean }): Promise<SaveOutcome>;
  markExternalChange(): void;
  reload(): Promise<void>;
  close(): void;
}

const initial = {
  projectRoot: null,
  path: null,
  kind: null,
  format: null,
  text: "",
  savedSha256: null,
  def: null,
  errors: [],
  warnings: [],
  dirty: false,
  validating: false,
  commentWarningPending: false,
  selection: null,
  externalChange: false,
  loadError: null,
  saveError: null,
} satisfies Partial<EditorState>;

let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every open / close so stale async results are dropped. */
let generation = 0;
/** Bumped by every validation request so only the newest result applies. */
let validationSeq = 0;

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function errorCode(err: unknown): string {
  return isFlowCommandError(err) ? err.code : "UNKNOWN";
}

/** The code that makes a load read-only, or `null` when the text is usable. */
function unreadableCode(result: FlowLoadResult): string | null {
  const tooLarge = result.errors.find((e) => e.code === "FLOW_FILE_TOO_LARGE");
  if (tooLarge) return tooLarge.code;
  if (result.content === "" && result.errors.length > 0) return result.errors[0].code;
  return null;
}

function kindForPath(path: string): FlowKind {
  return path.startsWith(LIB_PREFIX) ? "part" : "entry";
}

export const useFlowEditorStore = create<EditorState>()((set, get) => {
  const schedule = () => {
    clearTimer();
    // Invalidate any request already in flight: its text is outdated.
    validationSeq++;
    timer = setTimeout(() => {
      timer = null;
      void get().validateNow();
    }, VALIDATE_DEBOUNCE_MS);
  };

  const loadInto = async (projectRoot: string, path: string): Promise<void> => {
    const gen = ++generation;
    validationSeq++;
    clearTimer();
    set({ ...initial, projectRoot, path });
    let result: FlowLoadResult;
    try {
      result = await flowApi.load(projectRoot, path);
    } catch (err) {
      if (gen === generation) set({ loadError: errorCode(err) });
      return;
    }
    if (gen !== generation) return;
    set({
      kind: result.kind,
      format: result.format,
      text: result.content,
      savedSha256: result.sha256,
      def: result.flow,
      errors: result.errors,
      warnings: result.warnings,
      commentWarningPending: hasComments(result.content),
      loadError: unreadableCode(result),
    });
  };

  return {
    ...initial,

    open: (projectRoot, path) => loadInto(projectRoot, path),

    openNew: (projectRoot, path, def) => {
      generation++;
      validationSeq++;
      clearTimer();
      set({
        ...initial,
        projectRoot,
        path,
        kind: kindForPath(path),
        format: "yaml",
        text: stringifyFlow(def),
        def,
        dirty: true,
        validating: true,
      });
      schedule();
    },

    setText: (text) => {
      const s = get();
      if (s.loadError || !s.path) return;
      set({ text, dirty: true, saveError: null, validating: true });
      schedule();
    },

    applyEdit: (edit) => {
      const s = get();
      if (s.loadError || !s.path || !s.def) return;
      const next = edit(s.def);
      set({ text: stringifyFlow(next), def: next, dirty: true, saveError: null, validating: true });
      schedule();
    },

    validateNow: async () => {
      clearTimer();
      const { projectRoot, path, text, loadError } = get();
      if (!projectRoot || !path || loadError) return;
      const gen = generation;
      const seq = ++validationSeq;
      set({ validating: true });
      try {
        const result = await flowApi.validate(projectRoot, path, text);
        if (gen !== generation || seq !== validationSeq || get().text !== text) return;
        set({
          // Keep the previous decoded flow while the text cannot be decoded.
          def: result.flow ?? get().def,
          errors: result.errors,
          warnings: result.warnings,
          kind: result.kind,
          format: result.format,
          validating: false,
        });
      } catch {
        if (gen === generation && seq === validationSeq) set({ validating: false });
      }
    },

    select: (selection) => set({ selection }),

    save: async ({ overwrite } = {}) => {
      const s = get();
      if (!s.projectRoot || !s.path || s.loadError) return "error";
      const { projectRoot, path, text } = s;
      const gen = generation;
      try {
        let expected = s.savedSha256;
        // Overwriting adopts whatever is on disk now as the base to replace.
        if (overwrite && expected !== null) expected = (await flowApi.load(projectRoot, path)).sha256;
        if (gen !== generation) return "error";
        const result = await flowApi.save(projectRoot, path, text, expected);
        if (gen !== generation) return "saved";
        set((cur) => ({
          savedSha256: result.sha256,
          dirty: cur.text !== text,
          externalChange: false,
          saveError: null,
        }));
        return "saved";
      } catch (err) {
        if (gen !== generation) return "error";
        const code = errorCode(err);
        if (code === "FLOW_FILE_CHANGED") {
          set({ externalChange: true });
          return "changed-outside";
        }
        set({ saveError: code });
        return "error";
      }
    },

    markExternalChange: () => set({ externalChange: true }),

    reload: async () => {
      const { projectRoot, path } = get();
      if (!projectRoot || !path) return;
      await loadInto(projectRoot, path);
    },

    close: () => {
      generation++;
      validationSeq++;
      clearTimer();
      set({ ...initial });
    },
  };
});

/**
 * The single guard before the open file is replaced (another flow, a new flow, a reload):
 * resolves `true` when nothing is unsaved or the user agrees to discard the edits.
 */
export async function confirmDiscard(message: string): Promise<boolean> {
  if (!useFlowEditorStore.getState().dirty) return true;
  return showConfirm(message, { kind: "warning" });
}

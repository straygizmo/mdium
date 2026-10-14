import { create } from "zustand";
import type { FlowDef, FlowFormat, FlowIssue, FlowKind, FlowLoadResult } from "@/shared/types/flow";
import { flowApi, isFlowCommandError } from "./lib/flow-api";
import { nodeAt } from "./lib/editor-state";
import { mergeFlowIntoText, stringifyFlowAs } from "./lib/flow-yaml";
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

const FILE_NOT_FOUND = "FLOW_FILE_NOT_FOUND";
const FILE_TOO_LARGE = "FLOW_FILE_TOO_LARGE";

export type LineEnding = "\n" | "\r\n";

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
  /**
   * True when `def` was decoded from the current `text` (or produced it). While false, the text
   * holds edits Rust has not decoded yet, so structural edits on `def` would overwrite them.
   */
  defCurrent: boolean;
  /** Line ending of the loaded file; re-applied when an edit re-serializes the text. */
  eol: LineEnding;
  errors: FlowIssue[];
  warnings: FlowIssue[];
  dirty: boolean;
  validating: boolean;
  /** Unknown top-level keys present in the file on disk (load / last save). */
  diskUnknownKeys: string[];
  selection: Selection;
  /** Node paths selected on the canvas (shift / box selection); a single click holds that one path. */
  selectedMany: string[];
  externalChange: boolean;
  /** The external change is a deletion of the file. */
  externalDeleted: boolean;
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
  /** Records the canvas's node selection; exactly one node also becomes `selection`. */
  selectMany(paths: string[]): void;
  save(opts: { overwrite?: boolean }): Promise<SaveOutcome>;
  markExternalChange(deleted?: boolean): void;
  /**
   * Compares the file on disk with the one the editor holds: a clean editor reloads silently,
   * a dirty one (or a deleted file) raises the external-change notice.
   */
  syncWithDisk(): Promise<void>;
  reload(): Promise<void>;
  close(): void;
}

/** True when every selected node path still names a node with the same id in `next`. */
function selectionStillValid(s: Pick<EditorState, "selection" | "selectedMany">, prev: FlowDef, next: FlowDef): boolean {
  const paths = [...s.selectedMany];
  if (s.selection?.kind === "node") paths.push(s.selection.path);
  return paths.every((p) => {
    const before = nodeAt(prev, p);
    return before !== undefined && nodeAt(next, p)?.id === before.id;
  });
}

const initial = {
  projectRoot: null,
  path: null,
  kind: null,
  format: null,
  text: "",
  savedSha256: null,
  def: null,
  defCurrent: false,
  eol: "\n" as LineEnding,
  errors: [],
  warnings: [],
  dirty: false,
  validating: false,
  diskUnknownKeys: [],
  selection: null,
  selectedMany: [] as string[],
  externalChange: false,
  externalDeleted: false,
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

function formatForPath(path: string): FlowFormat {
  return path.toLowerCase().endsWith(".json") ? "json" : "yaml";
}

/** `\r\n` when the text uses it anywhere, else `\n`. */
export function detectEol(text: string): LineEnding {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The unknown top-level keys named by `FLOW_UNKNOWN_KEY` warnings. */
function unknownKeys(warnings: FlowIssue[]): string[] {
  return warnings
    .filter((w) => w.code === "FLOW_UNKNOWN_KEY")
    .map((w) => (typeof w.params.key === "string" ? w.params.key : w.path));
}

/** Unknown keys present on disk that the current text no longer carries (normalization dropped them). */
export function droppedUnknownKeys(s: Pick<EditorState, "diskUnknownKeys" | "warnings">): string[] {
  const now = new Set(unknownKeys(s.warnings));
  return s.diskUnknownKeys.filter((key) => !now.has(key));
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
      defCurrent: result.flow !== null,
      eol: detectEol(result.content),
      errors: result.errors,
      warnings: result.warnings,
      diskUnknownKeys: unknownKeys(result.warnings),
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
      const format = formatForPath(path);
      set({
        ...initial,
        projectRoot,
        path,
        kind: kindForPath(path),
        format,
        text: stringifyFlowAs(def, format),
        def,
        defCurrent: true,
        dirty: true,
        validating: true,
      });
      schedule();
    },

    setText: (text) => {
      const s = get();
      if (s.loadError || !s.path) return;
      // Monaco's text is kept as given (line endings included); `def` is now behind it.
      set({ text, defCurrent: false, dirty: true, saveError: null, validating: true });
      schedule();
    },

    applyEdit: (edit) => {
      const s = get();
      // Refused while the text holds edits that are not decoded yet: they would be overwritten.
      if (s.loadError || !s.path || !s.def || !s.defCurrent) return;
      const next = edit(s.def);
      if (next === s.def) return;
      // YAML is patched in place so hand-written comments and key order survive the edit.
      const serialized =
        s.format === "yaml" ? mergeFlowIntoText(s.text, next) : stringifyFlowAs(next, s.format ?? "yaml");
      const text = s.eol === "\r\n" ? serialized.replace(/\r?\n/g, "\r\n") : serialized;
      set({ text, def: next, defCurrent: true, dirty: true, saveError: null, validating: true });
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
        const previous = get();
        set({
          // Node paths name positions: after a text edit that moved or removed nodes they would
          // point at other nodes, so a selection that no longer matches is dropped.
          ...(result.flow && previous.def && !selectionStillValid(previous, previous.def, result.flow)
            ? { selection: null, selectedMany: [] }
            : {}),
          // Keep the previous decoded flow while the text cannot be decoded.
          def: result.flow ?? get().def,
          defCurrent: result.flow !== null,
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

    select: (selection) =>
      set((s) => {
        // Picking a node of the multi-selection keeps the set (a click on one of several selected nodes).
        if (selection?.kind === "node" && s.selectedMany.length > 1 && s.selectedMany.includes(selection.path)) {
          return { selection, selectedMany: s.selectedMany };
        }
        return { selection, selectedMany: selection?.kind === "node" ? [selection.path] : [] };
      }),

    selectMany: (paths) =>
      set((s) => {
        if (paths.length === 1) return { selectedMany: paths, selection: { kind: "node", path: paths[0] } };
        // Several nodes show no single attribute form; an edge / flow selection survives an emptied node set.
        return { selectedMany: paths, selection: paths.length > 1 || s.selection?.kind === "node" ? null : s.selection };
      }),

    save: async ({ overwrite } = {}) => {
      const s = get();
      if (!s.projectRoot || !s.path || s.loadError) return "error";
      const { projectRoot, path, text } = s;
      const gen = generation;
      try {
        let expected = s.savedSha256;
        // Overwriting adopts whatever is on disk now as the base to replace (nothing: re-create it).
        if (overwrite) {
          try {
            const disk = await flowApi.load(projectRoot, path);
            if (disk.errors.some((e) => e.code === FILE_TOO_LARGE)) {
              // The hash of an unread file is not the file's: saving against it would loop.
              if (gen === generation) set({ saveError: FILE_TOO_LARGE });
              return "error";
            }
            expected = disk.sha256;
          } catch (err) {
            if (errorCode(err) !== FILE_NOT_FOUND) throw err;
            expected = null;
          }
        }
        if (gen !== generation) return "error";
        const result = await flowApi.save(projectRoot, path, text, expected);
        if (gen !== generation) return "saved";
        set((cur) => ({
          savedSha256: result.sha256,
          dirty: cur.text !== text,
          externalChange: false,
          externalDeleted: false,
          diskUnknownKeys: unknownKeys(result.warnings),
          saveError: null,
        }));
        return "saved";
      } catch (err) {
        if (gen !== generation) return "error";
        const code = errorCode(err);
        if (code === "FLOW_FILE_CHANGED") {
          set({ externalChange: true, externalDeleted: false });
          return "changed-outside";
        }
        if (code === FILE_NOT_FOUND && s.savedSha256 !== null) {
          set({ externalChange: true, externalDeleted: true });
          return "changed-outside";
        }
        set({ saveError: code });
        return "error";
      }
    },

    markExternalChange: (deleted = false) => set({ externalChange: true, externalDeleted: deleted }),

    syncWithDisk: async () => {
      const { projectRoot, path, savedSha256, loadError } = get();
      if (!projectRoot || !path) return;
      const gen = generation;
      let sha256: string;
      try {
        sha256 = (await flowApi.load(projectRoot, path)).sha256;
      } catch (err) {
        // A file the editor read before is gone: let the user re-create it (overwrite) or reload.
        if (gen === generation && errorCode(err) === FILE_NOT_FOUND && savedSha256 !== null && !loadError) {
          get().markExternalChange(true);
        }
        return;
      }
      const now = get();
      if (gen !== generation) return;
      if (sha256 === now.savedSha256) {
        // The file came back unchanged.
        if (now.externalDeleted) set({ externalChange: false, externalDeleted: false });
        return;
      }
      if (now.dirty) now.markExternalChange();
      else await loadInto(projectRoot, path);
    },

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

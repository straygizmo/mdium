import { useFlowEditorStore } from "../editor-store";

/** App-wide Ctrl/Cmd shortcuts (undo, redo, save, find, replace) the flow editor owns while focused. */
const FLOW_OWNED_KEYS = new Set(["z", "y", "s", "f", "h"]);

/**
 * True when a window-level Ctrl/Cmd shortcut was pressed inside the flow editor: the app must
 * leave it to the editor instead of acting on the active Markdown tab.
 */
export function isFlowEditorShortcut(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "key" | "target">): boolean {
  if (!(e.ctrlKey || e.metaKey) || !FLOW_OWNED_KEYS.has(e.key.toLowerCase())) return false;
  const target = e.target as HTMLElement | null;
  return !!target?.closest?.(".flow-workspace");
}

/** True when the flow editor holds unsaved edits (checked before the app window closes). */
export function hasUnsavedFlowEdits(): boolean {
  return useFlowEditorStore.getState().dirty;
}

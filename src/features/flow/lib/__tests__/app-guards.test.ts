// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFlowEditorStore } from "../../editor-store";
import { hasUnsavedFlowEdits, isFlowEditorShortcut } from "../app-guards";

afterEach(() => {
  document.body.innerHTML = "";
  useFlowEditorStore.getState().close();
});

/** A window keydown handler shaped like App's: guarded first, then the tab undo. */
function appHandler(undo: () => void) {
  return (e: KeyboardEvent) => {
    if (isFlowEditorShortcut(e)) return;
    if (e.ctrlKey && e.key === "z") {
      e.preventDefault();
      undo();
    }
  };
}

describe("isFlowEditorShortcut", () => {
  it("keeps Ctrl+Z inside the flow workspace away from the tab store's undo", () => {
    document.body.innerHTML = '<div class="flow-workspace"><input id="inside" /></div><input id="outside" />';
    const undo = vi.fn();
    const handler = appHandler(undo);
    window.addEventListener("keydown", handler);
    try {
      const inside = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
      document.getElementById("inside")!.dispatchEvent(inside);
      expect(undo).not.toHaveBeenCalled();
      expect(inside.defaultPrevented).toBe(false);

      document.getElementById("outside")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
      expect(undo).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", handler);
    }
  });

  it("covers undo, redo, save, find and replace with Ctrl or Cmd only", () => {
    document.body.innerHTML = '<div class="flow-workspace"><textarea id="t"></textarea></div>';
    const target = document.getElementById("t")!;
    const at = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = { ctrlKey: true }) =>
      isFlowEditorShortcut({ key, ctrlKey: false, metaKey: false, ...mods, target });
    for (const key of ["z", "y", "s", "S", "f", "h"]) expect(at(key)).toBe(true);
    expect(at("z", { metaKey: true })).toBe(true);
    expect(at("w")).toBe(false);
    expect(at("z", {})).toBe(false);
  });
});

describe("hasUnsavedFlowEdits", () => {
  it("follows the flow editor's dirty flag", () => {
    expect(hasUnsavedFlowEdits()).toBe(false);
    useFlowEditorStore.setState({ dirty: true });
    expect(hasUnsavedFlowEdits()).toBe(true);
  });
});

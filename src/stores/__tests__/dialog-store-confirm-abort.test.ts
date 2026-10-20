import { beforeEach, describe, expect, it } from "vitest";
import { showConfirm, useDialogStore } from "../dialog-store";

describe("showConfirm abort signal", () => {
  beforeEach(() => useDialogStore.setState({ dialogs: [] }));

  it("dismisses the dialog and resolves false when the signal aborts", async () => {
    const ctrl = new AbortController();
    const p = showConfirm("ok?", { signal: ctrl.signal });
    expect(useDialogStore.getState().dialogs).toHaveLength(1);
    ctrl.abort();
    expect(await p).toBe(false);
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  it("does not open a dialog for an already-aborted signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await showConfirm("ok?", { signal: ctrl.signal })).toBe(false);
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  it("ignores an abort after the user already answered", async () => {
    const ctrl = new AbortController();
    const p = showConfirm("ok?", { signal: ctrl.signal });
    const entry = useDialogStore.getState().dialogs[0];
    useDialogStore.getState()._remove(entry.id);
    entry.resolve(true);
    ctrl.abort();
    expect(await p).toBe(true);
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "@/shared/i18n";
import { showConfirm, useDialogStore } from "@/stores/dialog-store";
import { AppDialog } from "./AppDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppDialog overlay", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    useDialogStore.setState({ dialogs: [], _nextId: 1 });
  });

  it("keeps an explicit-decision confirm open when its overlay is clicked", async () => {
    const container = document.createElement("div");
    root = createRoot(container);
    const confirmation = showConfirm("Apply the change?", { closeOnOverlayClick: false });
    let settled = false;
    void confirmation.finally(() => { settled = true; });

    await act(async () => { root?.render(<AppDialog />); });
    const overlay = container.querySelector(".app-dialog__overlay");
    await act(async () => {
      overlay?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });

    expect(settled).toBe(false);
    expect(useDialogStore.getState().dialogs).toHaveLength(1);

    const cancel = container.querySelectorAll<HTMLButtonElement>(".app-dialog__btn")[1];
    await act(async () => { cancel.click(); });
    await expect(confirmation).resolves.toBe(false);
  });

  it("cancels a confirm when its overlay is clicked by default", async () => {
    const container = document.createElement("div");
    root = createRoot(container);
    const confirmation = showConfirm("Continue?");

    await act(async () => { root?.render(<AppDialog />); });
    const overlay = container.querySelector(".app-dialog__overlay");
    await act(async () => {
      overlay?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(container.querySelector(".app-dialog__overlay")).toBeNull();
    await expect(confirmation).resolves.toBe(false);
  });
});

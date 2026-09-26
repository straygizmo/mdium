// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";
import { showConfirm, useDialogStore } from "@/stores/dialog-store";
import { DialogShell } from "../DialogShell";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DialogShell", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let outerKeyDown: ReturnType<typeof vi.fn<(e: unknown) => void>>;
  let outerClick: ReturnType<typeof vi.fn<(e: unknown) => void>>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    onClose = vi.fn<() => void>();
    outerKeyDown = vi.fn<(e: unknown) => void>();
    outerClick = vi.fn<(e: unknown) => void>();
    useDialogStore.setState({ dialogs: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render(props: Partial<Parameters<typeof DialogShell>[0]> = {}, inner?: React.ReactNode) {
    await act(async () =>
      root.render(
        <div onKeyDown={outerKeyDown} onClick={outerClick}>
          <DialogShell overlayClassName="overlay" className="dialog" labelledBy="title" onClose={onClose} {...props}>
            <h3 id="title">Title</h3>
            <button type="button" className="first">
              First
            </button>
            <button type="button" className="last">
              Last
            </button>
            {inner}
          </DialogShell>
        </div>,
      ),
    );
  }

  const overlay = () => container.querySelector<HTMLElement>(".overlay")!;
  const dialog = () => container.querySelector<HTMLElement>(".dialog")!;
  const mouse = (el: HTMLElement, type: string) => el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  const key = (el: HTMLElement, init: KeyboardEventInit) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));

  it("renders a labelled modal dialog, focuses it and restores focus on unmount", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    await render();
    expect(dialog().getAttribute("role")).toBe("dialog");
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(dialog().getAttribute("aria-labelledby")).toBe("title");
    expect(document.activeElement).toBe(dialog());
    await act(async () => root.render(<div />));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("closes on Escape without letting it reach the page", async () => {
    await render();
    await act(async () => key(dialog(), { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outerKeyDown).not.toHaveBeenCalled();
  });

  it("uses a custom Escape handler with the dialog element", async () => {
    const onEscape = vi.fn();
    await render({ onEscape });
    await act(async () => key(dialog(), { key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onEscape).toHaveBeenCalledWith(expect.anything(), dialog());
  });

  it("closes from the overlay only when the press starts and ends on it", async () => {
    await render();
    // A drag (e.g. a text selection) from inside the dialog to the overlay.
    await act(async () => {
      mouse(dialog(), "mousedown");
      mouse(overlay(), "click");
    });
    expect(onClose).not.toHaveBeenCalled();
    // A click without a press on the overlay.
    await act(async () => mouse(overlay(), "click"));
    expect(onClose).not.toHaveBeenCalled();
    // A press on the overlay released inside the dialog.
    await act(async () => {
      mouse(overlay(), "mousedown");
      mouse(dialog(), "click");
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      mouse(overlay(), "mousedown");
      mouse(overlay(), "click");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the dialog", async () => {
    await render();
    const first = container.querySelector<HTMLElement>(".first")!;
    const last = container.querySelector<HTMLElement>(".last")!;
    await act(async () => key(dialog(), { key: "Tab", shiftKey: true }));
    expect(document.activeElement).toBe(last);
    await act(async () => key(last, { key: "Tab" }));
    expect(document.activeElement).toBe(first);
    expect(outerKeyDown).toHaveBeenCalled();
  });

  it("keeps every key, press and click of a nested dialog from the dialog underneath", async () => {
    await render({ nested: true });
    await act(async () => key(dialog(), { key: "a" }));
    await act(async () => key(dialog(), { key: "Tab" }));
    await act(async () => {
      mouse(overlay(), "mousedown");
      mouse(overlay(), "click");
    });
    await act(async () => mouse(dialog(), "click"));
    expect(outerKeyDown).not.toHaveBeenCalled();
    expect(outerClick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("refocuses the topmost dialog after an app dialog closes", async () => {
    vi.useFakeTimers();
    await render(
      {},
      <DialogShell overlayClassName="inner-overlay" className="inner" labelledBy="inner-title" onClose={vi.fn()}>
        <h3 id="inner-title">Inner</h3>
      </DialogShell>,
    );
    const inner = container.querySelector<HTMLElement>(".inner")!;
    expect(document.activeElement).toBe(inner);
    void showConfirm("Discard?");
    // The app dialog took the focus and was removed with its focused button.
    inner.blur();
    expect(document.activeElement).toBe(document.body);
    const [entry] = useDialogStore.getState().dialogs;
    await act(async () => useDialogStore.getState()._remove(entry.id));
    await act(async () => vi.runAllTimers());
    expect(document.activeElement).toBe(inner);
  });

  it("does not take the focus back from another element", async () => {
    vi.useFakeTimers();
    const other = document.createElement("input");
    await render();
    document.body.appendChild(other);
    void showConfirm("Discard?");
    other.focus();
    const [entry] = useDialogStore.getState().dialogs;
    await act(async () => useDialogStore.getState()._remove(entry.id));
    await act(async () => vi.runAllTimers());
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

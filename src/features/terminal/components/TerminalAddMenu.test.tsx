// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/shared/i18n";
import { TerminalAddMenu } from "./TerminalAddMenu";
import type { TerminalKind } from "@/features/terminal/terminal-session";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TerminalAddMenu", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;
  let onAdd: ReturnType<typeof vi.fn<(kind: TerminalKind) => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onAdd = vi.fn((_kind: TerminalKind) => {});
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
  });

  const render = () => act(async () => root?.render(<TerminalAddMenu onAdd={onAdd} />));

  it("does not add a session when arrow keys are pressed on the closed button", async () => {
    await render();
    const button = container.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!;
    button.focus();
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(onAdd).not.toHaveBeenCalled();
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens the menu when the button is clicked", async () => {
    await render();
    const button = container.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await act(async () => button.click());

    expect(button.getAttribute("aria-expanded")).toBe("true");
    const menu = container.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
  });

  it("calls onAdd once with the chosen kind and closes the menu when an item is clicked", async () => {
    await render();
    const button = container.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!;
    await act(async () => button.click());

    const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    await act(async () => item.click());

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith("claude-code");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the menu on Escape without calling onAdd", async () => {
    await render();
    const button = container.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!;
    await act(async () => button.click());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onAdd).not.toHaveBeenCalled();
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});

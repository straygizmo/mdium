// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/shared/i18n";
import {
  SAFETY_ACK_KEY,
  SafetyNoticeDialog,
  acknowledgeSafety,
  isSafetyAcknowledged,
} from "../SafetyNoticeDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SafetyNoticeDialog", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function button(label: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  }

  it("explains the guards and their limits", async () => {
    await act(async () => root.render(<SafetyNoticeDialog onAccept={vi.fn()} onCancel={vi.fn()} />));
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const text = dialog.textContent ?? "";
    for (const key of ["title", "isolation", "guardScreening", "guardRuntime", "guardContainment", "guardPostCheck", "guardMergeReview", "limits", "noPush"]) {
      expect(text).toContain(i18n.t(`workflow:safety.${key}`));
    }
  });

  it("accepts, cancels and cancels on Escape", async () => {
    const onAccept = vi.fn();
    const onCancel = vi.fn();
    await act(async () => root.render(<SafetyNoticeDialog onAccept={onAccept} onCancel={onCancel} />));
    await act(async () => button(i18n.t("workflow:safety.accept"))!.click());
    expect(onAccept).toHaveBeenCalledTimes(1);
    await act(async () => button(i18n.t("workflow:safety.cancel"))!.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("stores the acknowledgement", () => {
    expect(isSafetyAcknowledged()).toBe(false);
    acknowledgeSafety();
    expect(localStorage.getItem(SAFETY_ACK_KEY)).toBe("1");
    expect(isSafetyAcknowledged()).toBe(true);
  });

  it("treats storage failures as not acknowledged", () => {
    localStorage.setItem(SAFETY_ACK_KEY, "1");
    // Accessing storage throws, as it does when site data is blocked.
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => acknowledgeSafety()).not.toThrow();
    expect(isSafetyAcknowledged()).toBe(false);
  });
});

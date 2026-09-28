// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setTitle = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const stopSync = vi.fn();
const startSettingsSync = vi.fn(() => stopSync);
vi.mock("@/shared/lib/settings-sync", () => ({ startSettingsSync: () => startSettingsSync() }));

import i18n from "@/shared/i18n";
import { showMessage, useDialogStore } from "@/stores/dialog-store";
import { useSettingsStore } from "@/stores/settings-store";
import { IntakeRoot } from "../IntakeRoot";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("IntakeRoot", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    document.documentElement.removeAttribute("data-theme-id");
    useSettingsStore.setState({ themeId: "mdium-light" });
    setTitle.mockClear();
    startSettingsSync.mockClear();
    stopSync.mockClear();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    useDialogStore.setState({ dialogs: [], _nextId: 1 });
  });

  async function mount() {
    root = createRoot(container);
    await act(async () => {
      root?.render(<IntakeRoot root="C:\proj" intakeId={null} />);
    });
  }

  it("applies the persisted theme and sets the window title", async () => {
    await mount();
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("mdium-light");
    expect(setTitle).toHaveBeenLastCalledWith(i18n.t("intake.windowTitle", { ns: "workflow" }));
  });

  it("updates the window title when the language changes", async () => {
    await mount();
    setTitle.mockClear();
    await act(async () => {
      await i18n.changeLanguage(i18n.language === "en" ? "ja" : "en");
    });
    expect(setTitle).toHaveBeenCalled();
  });

  it("starts settings sync and stops it on unmount", async () => {
    await mount();
    expect(startSettingsSync).toHaveBeenCalledTimes(1);
    await act(async () => root?.unmount());
    root = undefined;
    expect(stopSync).toHaveBeenCalledTimes(1);
  });

  it("mounts AppDialog so command failures can be shown", async () => {
    await mount();
    await act(async () => {
      void showMessage("boom", { kind: "error" });
    });
    expect(container.querySelector(".app-dialog__overlay")).not.toBeNull();
    expect(container.textContent).toContain("boom");
  });
});

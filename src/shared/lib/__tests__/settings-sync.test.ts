// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import i18n from "@/shared/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import { startSettingsSync } from "../settings-sync";

function writePersisted(themeId: string, language: "ja" | "en"): string {
  const value = JSON.stringify({ state: { themeId, language }, version: 0 });
  localStorage.setItem("mdium-settings", value);
  return value;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("startSettingsSync", () => {
  let stop: (() => void) | undefined;

  beforeEach(async () => {
    localStorage.clear();
    useSettingsStore.setState({ themeId: "mdium-dark", language: "ja" });
    document.documentElement.removeAttribute("data-theme-id");
    await i18n.changeLanguage("ja");
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it("re-applies theme and language when another window changes the settings", async () => {
    stop = startSettingsSync();
    const newValue = writePersisted("mdium-light", "en");
    window.dispatchEvent(new StorageEvent("storage", { key: "mdium-settings", newValue }));
    await flush();

    expect(useSettingsStore.getState().themeId).toBe("mdium-light");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("mdium-light");
    expect(i18n.language).toBe("en");
  });

  it("follows the language key written by setLanguage", async () => {
    stop = startSettingsSync();
    writePersisted("mdium-dark", "en");
    localStorage.setItem("mdium-lang", "en");
    window.dispatchEvent(new StorageEvent("storage", { key: "mdium-lang", newValue: "en" }));
    await flush();

    expect(i18n.language).toBe("en");
    expect(useSettingsStore.getState().language).toBe("en");
  });

  it("ignores unrelated keys", async () => {
    stop = startSettingsSync();
    const rehydrate = vi.spyOn(useSettingsStore.persist, "rehydrate");
    writePersisted("mdium-light", "en");
    window.dispatchEvent(new StorageEvent("storage", { key: "other-key", newValue: "x" }));
    await flush();

    expect(rehydrate).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-theme-id")).toBeNull();
    expect(i18n.language).toBe("ja");
    rehydrate.mockRestore();
  });

  it("stops listening after the returned cleanup runs", async () => {
    startSettingsSync()();
    const newValue = writePersisted("mdium-light", "en");
    window.dispatchEvent(new StorageEvent("storage", { key: "mdium-settings", newValue }));
    await flush();

    expect(document.documentElement.getAttribute("data-theme-id")).toBeNull();
  });
});

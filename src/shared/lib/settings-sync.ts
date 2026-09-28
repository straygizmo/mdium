import i18n from "@/shared/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import { applyTheme } from "@/shared/themes/apply-theme";
import { getThemeById } from "@/shared/themes";

// localStorage keys written by the settings store (persist + setLanguage).
const SYNCED_KEYS = new Set(["mdium-settings", "mdium-lang"]);

/**
 * Keep this window's settings in step with changes made in other windows.
 * `storage` events only fire for writes from other windows, so this never
 * reacts to its own changes. Returns a function that stops listening.
 */
export function startSettingsSync(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || !SYNCED_KEYS.has(event.key)) return;
    void Promise.resolve(useSettingsStore.persist.rehydrate()).then(() => {
      const { themeId, language } = useSettingsStore.getState();
      applyTheme(getThemeById(themeId));
      if (i18n.language !== language) void i18n.changeLanguage(language);
    });
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

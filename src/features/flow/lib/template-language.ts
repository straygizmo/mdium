import i18n from "@/shared/i18n";
import { flowApi } from "./flow-api";

/**
 * Keeps the built-in flow templates in the UI language: sends the current
 * language once, then again whenever it changes, so copies and `mdium:`
 * references use a template's translation when it has one. A failing
 * command is ignored (no templates outside the desktop app). Returns a
 * function that stops following changes.
 */
export function startTemplateLanguageSync(): () => void {
  const apply = (language: string) => {
    void flowApi.setTemplateLanguage(language).catch(() => {});
  };
  apply(i18n.language);
  i18n.on("languageChanged", apply);
  return () => i18n.off("languageChanged", apply);
}

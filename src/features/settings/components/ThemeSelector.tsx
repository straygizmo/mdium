import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/stores/settings-store";
import { themePresets } from "@/shared/themes";
import type { ThemePreset } from "@/shared/themes/types";
import "./ThemeSelector.css";

export function ThemeSelector() {
  const { t } = useTranslation("settings");
  const { themeId, setThemeId } = useSettingsStore();

  const handleSelect = useCallback(
    (theme: ThemePreset) => {
      setThemeId(theme.id);
    },
    [setThemeId]
  );

  return (
    <div className="theme-selector">
      <label className="theme-selector__label">{t("theme")}</label>
      <ul className="theme-selector__list">
        {themePresets.map((theme) => (
          <li
            key={theme.id}
            className={`theme-selector__item ${theme.id === themeId ? "theme-selector__item--active" : ""}`}
            onClick={() => handleSelect(theme)}
          >
            <span
              className="theme-selector__swatch"
              style={{ backgroundColor: theme.colors.primary }}
            />
            <span className="theme-selector__name">{theme.name}</span>
            <span
              className={`theme-selector__badge theme-selector__badge--${theme.type}`}
            >
              {t(theme.type)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

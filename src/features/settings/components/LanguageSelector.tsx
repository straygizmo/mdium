import { useTranslation } from "react-i18next";
import { useSettingsStore, type Language } from "@/stores/settings-store";
import "./LanguageSelector.css";

const languages: { code: Language; label: string }[] = [
  { code: "ja", label: "日本語" },
  { code: "en", label: "English" },
];

export function LanguageSelector() {
  const { t } = useTranslation("settings");
  const { language, setLanguage } = useSettingsStore();

  return (
    <div className="language-selector">
      <label className="language-selector__label">{t("language")}</label>
      <div className="language-selector__options">
        {languages.map((lang) => (
          <button
            key={lang.code}
            className={`language-selector__option ${lang.code === language ? "language-selector__option--active" : ""}`}
            onClick={() => setLanguage(lang.code)}
          >
            {lang.label}
          </button>
        ))}
      </div>
    </div>
  );
}

import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import "./StatusBar.css";

export function StatusBar() {
  const { t } = useTranslation("settings");
  const activeTab = useTabStore((s) => s.getActiveTab());
  const { autoSave, setAutoSave } = useSettingsStore();

  const content = activeTab?.content ?? "";
  const charCount = content.length;
  const lineCount = content ? content.split("\n").length : 0;

  return (
    <footer className="status-bar">
      <div className="status-bar__left">
        <span className="status-bar__item">
          {activeTab?.filePath ?? t("noFile", { ns: "common", defaultValue: "" })}
        </span>
      </div>
      <div className="status-bar__right">
        <span className="status-bar__item">
          {lineCount} L / {charCount} C
        </span>
        <button
          className={`status-bar__auto-save ${autoSave ? "status-bar__auto-save--on" : ""}`}
          onClick={() => setAutoSave(!autoSave)}
          title={t("autoSaveDescription")}
        >
          {t("autoSave")}: {autoSave ? "ON" : "OFF"}
        </button>
      </div>
    </footer>
  );
}

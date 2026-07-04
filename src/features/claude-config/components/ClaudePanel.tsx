import { useTranslation } from "react-i18next";
import { useUiStore } from "@/stores/ui-store";
import { useTabStore } from "@/stores/tab-store";
import { ClaudeChat } from "./ClaudeChat";
import "./ClaudePanel.css";

export function ClaudePanel() {
  const { t } = useTranslation("claude-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const topTab = useUiStore((s) => s.claudeTopTab);
  const setTopTab = useUiStore((s) => s.setClaudeTopTab);

  if (!activeFolderPath) {
    return (
      <div className="claude-panel claude-panel--disabled">
        <div className="claude-panel__no-folder">{t("noFolderOpen")}</div>
      </div>
    );
  }

  return (
    <div className="claude-panel">
      <div className="claude-panel__top-tabs">
        <button
          className={`claude-panel__top-tab${topTab === "chat" ? " claude-panel__top-tab--active" : ""}`}
          onClick={() => setTopTab("chat")}
        >
          {t("tabChat")}
        </button>
        <button
          className={`claude-panel__top-tab${topTab === "settings" ? " claude-panel__top-tab--active" : ""}`}
          onClick={() => setTopTab("settings")}
        >
          {t("tabSettings")}
        </button>
      </div>
      {topTab === "chat" ? <ClaudeChat /> : <div className="claude-panel__settings" />}
    </div>
  );
}

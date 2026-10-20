import { useTranslation } from "react-i18next";
import { useUiStore } from "@/stores/ui-store";
import { NativeChat } from "@/features/agent-chat/components/NativeChat";
import { CodexSettings } from "./CodexSettings";
import "@/features/claude-config/components/ClaudePanel.css";

interface CodexPanelProps {
  folder: string;
}

/** Codex tab of AGENT CHAT: the runner-backed chat plus a settings view, laid out like the Claude panel. */
export function CodexPanel({ folder }: CodexPanelProps) {
  const { t } = useTranslation("codex-config");
  const topTab = useUiStore((s) => s.codexTopTab);
  const setTopTab = useUiStore((s) => s.setCodexTopTab);

  return (
    <div className="claude-panel">
      <div className="claude-panel__top-tabs">
        <button
          type="button"
          className={`claude-panel__top-tab${topTab === "chat" ? " claude-panel__top-tab--active" : ""}`}
          onClick={() => setTopTab("chat")}
        >
          {t("tabChat")}
        </button>
        <button
          type="button"
          className={`claude-panel__top-tab${topTab === "settings" ? " claude-panel__top-tab--active" : ""}`}
          onClick={() => setTopTab("settings")}
        >
          {t("tabSettings")}
        </button>
      </div>
      {topTab === "chat" ? <NativeChat folder={folder} provider="codex" /> : <CodexSettings folder={folder} />}
    </div>
  );
}

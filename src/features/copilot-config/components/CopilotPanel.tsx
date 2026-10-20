import { useTranslation } from "react-i18next";
import { useUiStore } from "@/stores/ui-store";
import { NativeChat } from "@/features/agent-chat/components/NativeChat";
import { CopilotSettings } from "./CopilotSettings";
import "@/features/claude-config/components/ClaudePanel.css";

interface CopilotPanelProps {
  folder: string;
}

/** Copilot tab of AGENT CHAT: the runner-backed chat plus a settings view, laid out like the Claude panel. */
export function CopilotPanel({ folder }: CopilotPanelProps) {
  const { t } = useTranslation("copilot-config");
  const topTab = useUiStore((s) => s.copilotTopTab);
  const setTopTab = useUiStore((s) => s.setCopilotTopTab);

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
      {topTab === "chat" ? <NativeChat folder={folder} provider="copilot" /> : <CopilotSettings folder={folder} />}
    </div>
  );
}

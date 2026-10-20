import { useTranslation } from "react-i18next";
import { useUiStore } from "@/stores/ui-store";
import type { CopilotSettingsTab } from "@/shared/types";
import { GeneralSection } from "./sections/GeneralSection";
import { RulesSection } from "./sections/RulesSection";
import { McpServersTab } from "./sections/McpServersTab";
import { SkillsTab } from "./sections/SkillsTab";
import "@/features/claude-config/components/ClaudeSettings.css";

const TABS: { key: CopilotSettingsTab; labelKey: string }[] = [
  { key: "general", labelKey: "tabGeneral" },
  { key: "rules", labelKey: "tabRules" },
  { key: "mcp", labelKey: "tabMcp" },
  { key: "skills", labelKey: "tabSkills" },
];

interface CopilotSettingsProps {
  folder: string;
}

export function CopilotSettings({ folder }: CopilotSettingsProps) {
  const { t } = useTranslation("copilot-config");
  const tab = useUiStore((s) => s.copilotSettingsTab);
  const setTab = useUiStore((s) => s.setCopilotSettingsTab);

  return (
    <div className="claude-settings">
      <div className="claude-settings__tabs">
        {TABS.map(({ key, labelKey }) => (
          <button
            key={key}
            type="button"
            className={`claude-settings__tab${tab === key ? " claude-settings__tab--active" : ""}`}
            onClick={() => setTab(key)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="claude-settings__body">
        {tab === "general" && <GeneralSection folder={folder} />}
        {tab === "rules" && <RulesSection folder={folder} />}
        {tab === "mcp" && <McpServersTab folder={folder} />}
        {tab === "skills" && <SkillsTab folder={folder} />}
      </div>
    </div>
  );
}

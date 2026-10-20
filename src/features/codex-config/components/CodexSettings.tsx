import { useTranslation } from "react-i18next";
import { useUiStore } from "@/stores/ui-store";
import type { CodexSettingsTab } from "@/shared/types";
import { GeneralSection } from "./sections/GeneralSection";
import { RulesSection } from "./sections/RulesSection";
import { McpServersTab } from "./sections/McpServersTab";
import { SkillsTab } from "./sections/SkillsTab";
import "@/features/claude-config/components/ClaudeSettings.css";

const TABS: { key: CodexSettingsTab; labelKey: string }[] = [
  { key: "general", labelKey: "tabGeneral" },
  { key: "rules", labelKey: "tabRules" },
  { key: "mcp", labelKey: "tabMcp" },
  { key: "skills", labelKey: "tabSkills" },
];

interface CodexSettingsProps {
  folder: string;
}

export function CodexSettings({ folder }: CodexSettingsProps) {
  const { t } = useTranslation("codex-config");
  const tab = useUiStore((s) => s.codexSettingsTab);
  const setTab = useUiStore((s) => s.setCodexSettingsTab);

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

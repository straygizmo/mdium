import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GeneralSection } from "./sections/GeneralSection";
import { RulesSection } from "./sections/RulesSection";
import { McpServersTab } from "./McpServersTab";
import { SkillsTab } from "./SkillsTab";

type SettingsTab = "general" | "rules" | "mcp" | "skills";

const TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "general", labelKey: "tabGeneral" },
  { key: "rules", labelKey: "tabRules" },
  { key: "mcp", labelKey: "tabMcp" },
  { key: "skills", labelKey: "tabSkills" },
];

export function ClaudeSettings() {
  const { t } = useTranslation("claude-config");
  const [tab, setTab] = useState<SettingsTab>("general");

  return (
    <div className="claude-settings">
      <div className="claude-settings__tabs">
        {TABS.map(({ key, labelKey }) => (
          <button
            key={key}
            className={`claude-settings__tab${tab === key ? " claude-settings__tab--active" : ""}`}
            onClick={() => setTab(key)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="claude-settings__body">
        {tab === "general" && <GeneralSection />}
        {tab === "rules" && <RulesSection />}
        {tab === "mcp" && <McpServersTab />}
        {tab === "skills" && <SkillsTab />}
      </div>
    </div>
  );
}

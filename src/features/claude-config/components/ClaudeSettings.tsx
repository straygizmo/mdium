import { useTranslation } from "react-i18next";
import { useUiStore } from "@/stores/ui-store";
import type { ClaudeSettingsTab } from "@/shared/types";
import { GeneralSection } from "./sections/GeneralSection";
import { RulesSection } from "./sections/RulesSection";
import { McpServersTab } from "./McpServersTab";
import { SkillsTab } from "./SkillsTab";
import { PluginsTab } from "./PluginsTab";

const TABS: { key: ClaudeSettingsTab; labelKey: string }[] = [
  { key: "general", labelKey: "tabGeneral" },
  { key: "rules", labelKey: "tabRules" },
  { key: "mcp", labelKey: "tabMcp" },
  { key: "skills", labelKey: "tabSkills" },
  { key: "plugins", labelKey: "tabPlugins" },
];

export function ClaudeSettings() {
  const { t } = useTranslation("claude-config");
  const tab = useUiStore((s) => s.claudeSettingsTab);
  const setTab = useUiStore((s) => s.setClaudeSettingsTab);

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
        {tab === "plugins" && <PluginsTab />}
      </div>
    </div>
  );
}

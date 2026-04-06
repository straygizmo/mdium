import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "@/stores/ui-store";
import { useTabStore } from "@/stores/tab-store";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import type { OpencodeConfigTab } from "@/shared/types";
import { OpencodeConfigProvider } from "./OpencodeConfigContext";
import { RulesSection } from "./sections/RulesSection";
import { ToolsSection } from "./sections/ToolsSection";
import { AgentsSection } from "./sections/AgentsSection";
import { CommandsSection } from "./sections/CommandsSection";
import { McpServersSection } from "./sections/McpServersSection";
import { SkillsSection } from "./sections/SkillsSection";
import { CustomToolsSection } from "./sections/CustomToolsSection";
import { WebUiSection } from "./sections/WebUiSection";
import { OpencodeChat } from "./OpencodeChat";
import "./OpencodeConfigPanel.css";
import "./OpencodeConfigDialog.css";

const TABS: { key: OpencodeConfigTab; labelKey: string }[] = [
  { key: "rules", labelKey: "tabRules" },
  // { key: "tools", labelKey: "tabTools" },  // Hidden because plan agent is forced
  { key: "agents", labelKey: "tabAgents" },
  { key: "commands", labelKey: "tabCommands" },
  { key: "mcp", labelKey: "tabMcp" },
  { key: "skills", labelKey: "tabSkills" },
  { key: "custom-tools", labelKey: "tabCustomTools" },
  // { key: "webui", labelKey: "tabWebUi" }, // May be used in the future, hidden for now
];

export function OpencodeConfigPanel() {
  const { t } = useTranslation("opencode-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const topTab = useUiStore((s) => s.opencodeTopTab);
  const setTopTab = useUiStore((s) => s.setOpencodeTopTab);
  const activeTab = useUiStore((s) => s.opencodeConfigTab);
  const setTab = useUiStore((s) => s.setOpencodeConfigTab);
  const loadConfig = useOpencodeConfigStore((s) => s.loadConfig);
  const loadProjectCommands = useOpencodeConfigStore((s) => s.loadProjectCommands);
  const loadProjectMcpServers = useOpencodeConfigStore((s) => s.loadProjectMcpServers);
  const loadProjectSkills = useOpencodeConfigStore((s) => s.loadProjectSkills);
  const loadGlobalSkills = useOpencodeConfigStore((s) => s.loadGlobalSkills);
  const loadGlobalAgentFiles = useOpencodeConfigStore((s) => s.loadGlobalAgentFiles);

  useEffect(() => {
    if (!activeFolderPath) return;
    const timer = setTimeout(() => {
      loadConfig();
      loadGlobalSkills();
      loadGlobalAgentFiles();
      loadProjectCommands(activeFolderPath);
      loadProjectMcpServers(activeFolderPath);
      loadProjectSkills(activeFolderPath);
    }, 200);
    return () => clearTimeout(timer);
  }, [loadConfig, loadGlobalSkills, loadGlobalAgentFiles, loadProjectCommands, loadProjectMcpServers, loadProjectSkills, activeFolderPath]);

  const contextValue = useMemo(() => ({ useRelativePaths: true }), []);

  const TAB_SECTIONS: Record<OpencodeConfigTab, React.ReactNode> = {
    rules: <RulesSection />,
    tools: <ToolsSection />,
    agents: <AgentsSection />,
    commands: <CommandsSection />,
    mcp: <McpServersSection />,
    skills: <SkillsSection />,
    "custom-tools": <CustomToolsSection />,
    webui: <WebUiSection />,
  };

  if (!activeFolderPath) {
    return (
      <div className="oc-panel oc-panel--disabled">
        <div className="oc-panel__no-folder">
          {t("noFolderOpen")}
        </div>
      </div>
    );
  }

  return (
    <div className="oc-panel">
      <div className="oc-panel__top-tabs">
        <button
          className={`oc-panel__top-tab${topTab === "chat" ? " oc-panel__top-tab--active" : ""}`}
          onClick={() => setTopTab("chat")}
        >
          {t("tabChat")}
        </button>
        <button
          className={`oc-panel__top-tab${topTab === "settings" ? " oc-panel__top-tab--active" : ""}`}
          onClick={() => setTopTab("settings")}
        >
          {t("tabSettings")}
        </button>
      </div>

      {topTab === "chat" ? (
        <OpencodeChat />
      ) : (
        <OpencodeConfigProvider value={contextValue}>
          <div className="oc-panel__tabs">
            {TABS.map(({ key, labelKey }) => (
              <button
                key={key}
                className={`oc-panel__tab${activeTab === key ? " oc-panel__tab--active" : ""}`}
                onClick={() => setTab(key)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
          <div className="oc-panel__body">
            {TABS.map(({ key }) => (
              <div key={key} style={{ display: activeTab === key ? undefined : "none" }}>
                {TAB_SECTIONS[key]}
              </div>
            ))}
          </div>
        </OpencodeConfigProvider>
      )}
    </div>
  );
}

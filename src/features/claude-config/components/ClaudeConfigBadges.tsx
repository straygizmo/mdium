import { useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useClaudeConfigStore } from "@/stores/claude-config-store";
import { useUiStore } from "@/stores/ui-store";
import { useTabStore } from "@/stores/tab-store";
import type { ClaudeSettingsTab } from "@/shared/types";

/**
 * Compact MCP / Skills badges shown under the chat toolbar, mirroring the
 * opencode config badges. Each shows a count and a hover tooltip of names, and
 * double-clicking jumps to the matching settings sub-tab.
 */
export function ClaudeConfigBadges() {
  const { t } = useTranslation("claude-config");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);

  const globalMcpServers = useClaudeConfigStore((s) => s.globalMcpServers);
  const projectMcpServers = useClaudeConfigStore((s) => s.projectMcpServers);
  const globalSkills = useClaudeConfigStore((s) => s.globalSkills);
  const projectSkills = useClaudeConfigStore((s) => s.projectSkills);
  const loadGlobalMcp = useClaudeConfigStore((s) => s.loadGlobalMcp);
  const loadProjectMcp = useClaudeConfigStore((s) => s.loadProjectMcp);
  const loadGlobalSkills = useClaudeConfigStore((s) => s.loadGlobalSkills);
  const loadProjectSkills = useClaudeConfigStore((s) => s.loadProjectSkills);

  useEffect(() => {
    void loadGlobalMcp();
    void loadGlobalSkills();
  }, [loadGlobalMcp, loadGlobalSkills]);

  useEffect(() => {
    if (!activeFolderPath) return;
    void loadProjectMcp(activeFolderPath);
    void loadProjectSkills(activeFolderPath);
  }, [activeFolderPath, loadProjectMcp, loadProjectSkills]);

  const badges = useMemo(() => {
    // MCP: enabled only (disabled !== true), global + project, de-duplicated.
    const mcpNames = [
      ...Object.entries(globalMcpServers),
      ...Object.entries(projectMcpServers),
    ]
      .filter(([, s]) => !s.disabled)
      .map(([name]) => name);
    const allMcp = [...new Set(mcpNames)];

    const skillNames = [...globalSkills, ...projectSkills].map(
      (s) => s.name || s.dirName,
    );
    const allSkills = [...new Set(skillNames)];

    return [
      { key: "mcp" as ClaudeSettingsTab, label: t("tabMcp"), items: allMcp },
      { key: "skills" as ClaudeSettingsTab, label: t("tabSkills"), items: allSkills },
    ];
  }, [globalMcpServers, projectMcpServers, globalSkills, projectSkills, t]);

  const setTopTab = useUiStore((s) => s.setClaudeTopTab);
  const setSettingsTab = useUiStore((s) => s.setClaudeSettingsTab);

  const handleDoubleClick = useCallback(
    (tab: ClaudeSettingsTab) => {
      setTopTab("settings");
      setSettingsTab(tab);
    },
    [setTopTab, setSettingsTab],
  );

  const active = badges.filter((b) => b.items.length > 0);
  if (active.length === 0) return null;

  return (
    <div className="claude-config-badges">
      {active.map((badge) => (
        <span
          key={badge.key}
          className="claude-config-badges__item"
          onDoubleClick={() => handleDoubleClick(badge.key)}
        >
          {badge.label}
          <span className="claude-config-badges__count">{badge.items.length}</span>
          <span className="claude-config-badges__tooltip">
            {badge.items.map((name) => (
              <span key={name} className="claude-config-badges__tooltip-item">
                {name}
              </span>
            ))}
          </span>
        </span>
      ))}
    </div>
  );
}

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";

export function OpencodeConfigBadges() {
  const { t } = useTranslation("opencode-config");
  const config = useOpencodeConfigStore((s) => s.config);
  const projectCommands = useOpencodeConfigStore((s) => s.projectCommands);
  const projectMcpServers = useOpencodeConfigStore((s) => s.projectMcpServers);
  const projectSkillNames = useOpencodeConfigStore((s) => s.projectSkillNames);
  const globalSkillNames = useOpencodeConfigStore((s) => s.globalSkillNames);

  const badges = useMemo(() => {
    // Commands: global + project
    const globalCmds = Object.keys(config.command ?? {});
    const projCmds = Object.keys(projectCommands);
    const allCommands = [...new Set([...globalCmds, ...projCmds])];

    // MCP: enabled only, global + project
    const globalMcp = Object.entries(config.mcp ?? {})
      .filter(([, s]) => s.enabled !== false)
      .map(([name]) => name);
    const projMcp = Object.entries(projectMcpServers)
      .filter(([, s]) => s.enabled !== false)
      .map(([name]) => name);
    const allMcp = [...new Set([...globalMcp, ...projMcp])];

    // Skills: global (file-based) + project (file-based)
    const allSkills = [...new Set([...globalSkillNames, ...projectSkillNames])];

    // Custom Tools
    const allCustomTools = Object.keys(config.customTools ?? {});

    return [
      {
        key: "commands",
        label: t("tabCommands"),
        count: allCommands.length,
        items: allCommands,
      },
      {
        key: "mcp",
        label: t("tabMcp"),
        count: allMcp.length,
        items: allMcp,
      },
      {
        key: "skills",
        label: t("tabSkills"),
        count: allSkills.length,
        items: allSkills,
      },
      {
        key: "custom-tools",
        label: t("tabCustomTools"),
        count: allCustomTools.length,
        items: allCustomTools,
      },
    ];
  }, [config, projectCommands, projectMcpServers, projectSkillNames, globalSkillNames, t]);

  const activeBadges = badges.filter((b) => b.count > 0);
  if (activeBadges.length === 0) return null;

  return (
    <div className="oc-config-badges">
      {activeBadges.map((badge) => (
        <span key={badge.key} className="oc-config-badges__item">
          {badge.label}: {badge.count}
          <span className="oc-config-badges__tooltip">
            {badge.items.map((name) => (
              <span key={name} className="oc-config-badges__tooltip-item">{name}</span>
            ))}
          </span>
        </span>
      ))}
    </div>
  );
}

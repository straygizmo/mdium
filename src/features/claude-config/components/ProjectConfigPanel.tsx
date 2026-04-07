import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useClaudeConfigStore } from "@/stores/claude-config-store";
import { showConfirm } from "@/stores/dialog-store";
import type { McpServer, SkillInfo } from "@/shared/types";
import { McpServerForm } from "./McpServerForm";
import { SkillForm } from "./SkillForm";
import "./ProjectConfigPanel.css";

export function ProjectConfigPanel() {
  const { t } = useTranslation("settings");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const {
    projectMcpServers,
    projectSkills,
    loadProjectMcp,
    loadProjectSkills,
    saveProjectMcpServer,
    deleteProjectMcpServer,
    toggleProjectMcpServer,
    saveProjectSkill,
    deleteProjectSkill,
  } = useClaudeConfigStore();

  const [mcpExpanded, setMcpExpanded] = useState(true);
  const [skillsExpanded, setSkillsExpanded] = useState(true);

  // MCP form state
  const [mcpEditing, setMcpEditing] = useState<string | null>(null);
  const [mcpAdding, setMcpAdding] = useState(false);

  // Skill form state
  const [skillEditing, setSkillEditing] = useState<SkillInfo | null>(null);
  const [skillAdding, setSkillAdding] = useState(false);

  const loadAll = useCallback(() => {
    if (!activeFolderPath) return;
    loadProjectMcp(activeFolderPath);
    loadProjectSkills(activeFolderPath);
  }, [activeFolderPath, loadProjectMcp, loadProjectSkills]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  if (!activeFolderPath) {
    return (
      <div className="project-config-panel">
        <div className="project-config-panel__empty">{t("projectConfigNoFolder")}</div>
      </div>
    );
  }

  const mcpEntries = Object.entries(projectMcpServers);

  const handleMcpSave = async (name: string, server: McpServer) => {
    await saveProjectMcpServer(activeFolderPath, name, server);
    setMcpEditing(null);
    setMcpAdding(false);
  };

  const handleMcpDelete = async (name: string) => {
    if (!(await showConfirm(t("mcpDeleteConfirm"), { kind: "warning" }))) return;
    await deleteProjectMcpServer(activeFolderPath, name);
  };

  const handleSkillSave = async (skill: SkillInfo) => {
    await saveProjectSkill(activeFolderPath, skill);
    setSkillEditing(null);
    setSkillAdding(false);
  };

  const handleSkillDelete = async (dirName: string) => {
    if (!(await showConfirm(t("skillDeleteConfirm"), { kind: "warning" }))) return;
    await deleteProjectSkill(activeFolderPath, dirName);
  };

  return (
    <div className="project-config-panel">
      <div className="project-config-panel__title">{t("projectConfig")}</div>

      {/* MCP Section */}
      <div className="project-config-panel__section">
        <button
          className="project-config-panel__section-header"
          onClick={() => setMcpExpanded(!mcpExpanded)}
        >
          <span className={`project-config-panel__chevron ${mcpExpanded ? "project-config-panel__chevron--open" : ""}`}>&#9654;</span>
          {t("mcpServers")} (.mcp.json)
        </button>
        {mcpExpanded && (
          <div className="project-config-panel__section-body">
            {mcpAdding || mcpEditing !== null ? (
              <McpServerForm
                initialName={mcpEditing ?? undefined}
                initialServer={mcpEditing ? projectMcpServers[mcpEditing] : undefined}
                onSave={handleMcpSave}
                onCancel={() => { setMcpAdding(false); setMcpEditing(null); }}
              />
            ) : (
              <>
                {mcpEntries.length === 0 ? (
                  <div className="project-config-panel__empty-section">{t("mcpNoServers")}</div>
                ) : (
                  mcpEntries.map(([name, server]) => (
                    <div key={name} className="project-config-panel__item">
                      <div className="project-config-panel__item-info">
                        <span className="project-config-panel__item-name">{name}</span>
                        <span className="project-config-panel__item-detail">{server.command} {server.args?.join(" ")}</span>
                      </div>
                      <div className="project-config-panel__item-actions">
                        <button
                          className={`project-config-panel__toggle-btn ${server.disabled ? "project-config-panel__toggle-btn--off" : ""}`}
                          onClick={() => toggleProjectMcpServer(activeFolderPath, name)}
                        >
                          {server.disabled ? t("mcpDisabled") : t("mcpEnabled")}
                        </button>
                        <button className="project-config-panel__edit-btn" onClick={() => setMcpEditing(name)}>
                          {t("mcpEditServer")}
                        </button>
                        <button className="project-config-panel__delete-btn" onClick={() => handleMcpDelete(name)}>×</button>
                      </div>
                    </div>
                  ))
                )}
                <button className="project-config-panel__add-btn" onClick={() => setMcpAdding(true)}>
                  + {t("mcpAddServer")}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Skills Section */}
      <div className="project-config-panel__section">
        <button
          className="project-config-panel__section-header"
          onClick={() => setSkillsExpanded(!skillsExpanded)}
        >
          <span className={`project-config-panel__chevron ${skillsExpanded ? "project-config-panel__chevron--open" : ""}`}>&#9654;</span>
          Skills (.claude/skills/)
        </button>
        {skillsExpanded && (
          <div className="project-config-panel__section-body">
            {skillAdding || skillEditing !== null ? (
              <SkillForm
                initial={skillEditing ?? undefined}
                onSave={handleSkillSave}
                onCancel={() => { setSkillAdding(false); setSkillEditing(null); }}
              />
            ) : (
              <>
                {projectSkills.length === 0 ? (
                  <div className="project-config-panel__empty-section">{t("skillNoSkills")}</div>
                ) : (
                  projectSkills.map((skill) => (
                    <div key={skill.dirName} className="project-config-panel__item">
                      <div className="project-config-panel__item-info">
                        <span className="project-config-panel__item-name">{skill.name || skill.dirName}</span>
                        <span className="project-config-panel__item-detail">{skill.description}</span>
                      </div>
                      <div className="project-config-panel__item-actions">
                        <button className="project-config-panel__edit-btn" onClick={() => setSkillEditing(skill)}>
                          {t("skillEdit")}
                        </button>
                        <button className="project-config-panel__delete-btn" onClick={() => handleSkillDelete(skill.dirName)}>×</button>
                      </div>
                    </div>
                  ))
                )}
                <button className="project-config-panel__add-btn" onClick={() => setSkillAdding(true)}>
                  + {t("skillAdd")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

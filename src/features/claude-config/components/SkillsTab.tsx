import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useClaudeConfigStore } from "@/stores/claude-config-store";
import { showConfirm } from "@/stores/dialog-store";
import type { SkillInfo } from "@/shared/types";
import { SkillForm } from "./SkillForm";
import "./SkillsTab.css";

export function SkillsTab() {
  const { t } = useTranslation("settings");
  const {
    globalSkills,
    loadGlobalSkills,
    saveGlobalSkill,
    deleteGlobalSkill,
  } = useClaudeConfigStore();

  const [editing, setEditing] = useState<SkillInfo | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    loadGlobalSkills();
  }, [loadGlobalSkills]);

  const handleSave = async (skill: SkillInfo) => {
    await saveGlobalSkill(skill);
    setEditing(null);
    setAdding(false);
  };

  const handleDelete = async (dirName: string) => {
    if (!(await showConfirm(t("skillDeleteConfirm"), { kind: "warning" }))) return;
    await deleteGlobalSkill(dirName);
  };

  if (adding || editing !== null) {
    return (
      <SkillForm
        initial={editing ?? undefined}
        onSave={handleSave}
        onCancel={() => { setAdding(false); setEditing(null); }}
      />
    );
  }

  return (
    <div className="skills-tab">
      <div className="skills-tab__header">
        <span className="skills-tab__title">Skills</span>
        <span className="skills-tab__scope">{t("globalScope")} (~/.claude/skills/)</span>
      </div>
      {globalSkills.length === 0 ? (
        <div className="skills-tab__empty">{t("skillNoSkills")}</div>
      ) : (
        <div className="skills-tab__list">
          {globalSkills.map((skill) => (
            <div key={skill.dirName} className="skills-tab__item">
              <div className="skills-tab__item-info">
                <span className="skills-tab__item-name">{skill.name || skill.dirName}</span>
                <span className="skills-tab__item-desc">{skill.description}</span>
              </div>
              <div className="skills-tab__item-actions">
                <button className="skills-tab__edit-btn" onClick={() => setEditing(skill)}>{t("skillEdit")}</button>
                <button className="skills-tab__delete-btn" onClick={() => handleDelete(skill.dirName)}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <button className="skills-tab__add-btn" onClick={() => setAdding(true)}>
        + {t("skillAdd")}
      </button>
    </div>
  );
}

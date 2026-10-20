import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useClaudeConfigStore } from "@/stores/claude-config-store";
import { useTabStore } from "@/stores/tab-store";
import { showConfirm } from "@/stores/dialog-store";
import type { SkillInfo } from "@/shared/types";
import { SkillForm } from "./SkillForm";
import { SectionHint } from "./shared/SectionHint";
import type { Scope } from "./shared/ScopeToggle";
import { useHomeDir } from "../hooks/useHomeDir";
import { joinPath, toRelativeProjectPath } from "../lib/config-paths";

interface ScopedSkill {
  scope: Scope;
  skill: SkillInfo;
}

export function SkillsTab() {
  const { t } = useTranslation("claude-config");
  const folder = useTabStore((s) => s.activeFolderPath)!;
  const home = useHomeDir();
  const globalSkills = useClaudeConfigStore((s) => s.globalSkills);
  const projectSkills = useClaudeConfigStore((s) => s.projectSkills);
  const loadGlobalSkills = useClaudeConfigStore((s) => s.loadGlobalSkills);
  const loadProjectSkills = useClaudeConfigStore((s) => s.loadProjectSkills);
  const saveGlobalSkill = useClaudeConfigStore((s) => s.saveGlobalSkill);
  const saveProjectSkill = useClaudeConfigStore((s) => s.saveProjectSkill);
  const deleteGlobalSkill = useClaudeConfigStore((s) => s.deleteGlobalSkill);
  const deleteProjectSkill = useClaudeConfigStore((s) => s.deleteProjectSkill);

  const [editing, setEditing] = useState<ScopedSkill | null>(null);
  const [adding, setAdding] = useState(false);
  const [formScope, setFormScope] = useState<Scope>("global");

  useEffect(() => {
    void loadGlobalSkills();
    void loadProjectSkills(folder);
  }, [loadGlobalSkills, loadProjectSkills, folder]);

  const items = useMemo<ScopedSkill[]>(
    () => [
      ...globalSkills.map((skill) => ({ scope: "global" as const, skill })),
      ...projectSkills.map((skill) => ({ scope: "project" as const, skill })),
    ],
    [globalSkills, projectSkills],
  );

  const savePathFor = useCallback(
    (dirName: string) => {
      const dir = dirName || "<name>";
      if (formScope === "global") {
        return home ? joinPath(home, ".claude", "skills", dir, "SKILL.md") : "";
      }
      return toRelativeProjectPath(folder, joinPath(folder, ".claude", "skills", dir, "SKILL.md"));
    },
    [formScope, home, folder],
  );

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };

  const handleSave = async (skill: SkillInfo) => {
    try {
      if (formScope === "global") await saveGlobalSkill(skill);
      else await saveProjectSkill(folder, skill);
    } catch {
      return; // store already reported the error
    }
    closeForm();
  };

  const handleDelete = async (scope: Scope, skill: SkillInfo) => {
    const name = skill.name || skill.dirName;
    if (!(await showConfirm(t("skillDeleteConfirm", { name }), { kind: "warning" }))) return;
    try {
      if (scope === "global") await deleteGlobalSkill(skill.dirName);
      else await deleteProjectSkill(folder, skill.dirName);
    } catch {
      // store already reported the error
    }
  };

  if (adding || editing !== null) {
    return (
      <SkillForm
        scope={formScope}
        onScopeChange={setFormScope}
        scopeLocked={editing !== null}
        savePathFor={savePathFor}
        initial={editing?.skill}
        onSave={handleSave}
        onCancel={closeForm}
      />
    );
  }

  return (
    <div className="claude-section">
      <SectionHint docsUrl={t("skillsDocsUrl")}>{t("skillsDescription")}</SectionHint>

      <div className="claude-section__list">
        {items.length === 0 && <div className="claude-section__empty">{t("skillsEmpty")}</div>}
        {items.map(({ scope, skill }) => (
          <div key={`${scope}-${skill.dirName}`} className={`claude-section__item claude-section__item--${scope}`}>
            <div className="claude-section__item-info">
              <span className="claude-section__item-name">{skill.name || skill.dirName}</span>
              <span className="claude-section__item-detail">{skill.description}</span>
            </div>
            <div className="claude-section__item-actions">
              <button
                className="claude-section__edit-btn"
                onClick={() => { setFormScope(scope); setEditing({ scope, skill }); }}
              >
                {t("edit")}
              </button>
              <button className="claude-section__delete-btn" onClick={() => void handleDelete(scope, skill)}>
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="claude-section__list-actions">
        <button className="claude-section__add-btn" onClick={() => { setFormScope("global"); setAdding(true); }}>
          + {t("add")}
        </button>
      </div>
    </div>
  );
}

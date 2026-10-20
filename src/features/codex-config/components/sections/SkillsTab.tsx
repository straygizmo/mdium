import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useCodexConfigStore } from "@/stores/codex-config-store";
import { showConfirm } from "@/stores/dialog-store";
import type { SkillInfo } from "@/shared/types";
import { SectionHint } from "@/features/claude-config/components/shared/SectionHint";
import type { Scope } from "@/features/claude-config/components/shared/ScopeToggle";
import { useHomeDir } from "@/features/claude-config/hooks/useHomeDir";
import { joinPath, toRelativeProjectPath } from "@/features/claude-config/lib/config-paths";
import { SkillForm } from "./SkillForm";

interface ScopedSkill {
  scope: Scope;
  skill: SkillInfo;
}

interface SkillsTabProps {
  folder: string;
}

export function SkillsTab({ folder }: SkillsTabProps) {
  const { t } = useTranslation("codex-config");
  const home = useHomeDir();
  const globalSkills = useCodexConfigStore((s) => s.globalSkills);
  const projectSkills = useCodexConfigStore((s) => s.projectSkills);
  const loadGlobalSkills = useCodexConfigStore((s) => s.loadGlobalSkills);
  const loadProjectSkills = useCodexConfigStore((s) => s.loadProjectSkills);
  const saveSkill = useCodexConfigStore((s) => s.saveSkill);
  const deleteSkill = useCodexConfigStore((s) => s.deleteSkill);

  const [editing, setEditing] = useState<ScopedSkill | null>(null);
  const [adding, setAdding] = useState(false);
  const [formScope, setFormScope] = useState<Scope>("global");

  useEffect(() => {
    void loadGlobalSkills().catch(() => {});
    void loadProjectSkills(folder).catch(() => {});
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
        return home ? joinPath(home, ".codex", "skills", dir, "SKILL.md") : "";
      }
      return toRelativeProjectPath(folder, joinPath(folder, ".codex", "skills", dir, "SKILL.md"));
    },
    [formScope, home, folder],
  );

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };

  const handleSave = async (skill: SkillInfo) => {
    try {
      await saveSkill(formScope, folder, skill);
    } catch {
      return; // store already reported the error
    }
    closeForm();
  };

  const handleDelete = async (scope: Scope, skill: SkillInfo) => {
    const name = skill.name || skill.dirName;
    if (!(await showConfirm(t("skillDeleteConfirm", { name }), { kind: "warning" }))) return;
    try {
      await deleteSkill(scope, folder, skill.dirName);
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

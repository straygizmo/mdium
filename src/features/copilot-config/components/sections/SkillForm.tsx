import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SkillInfo } from "@/shared/types";
import { ScopeToggle, type Scope } from "@/features/claude-config/components/shared/ScopeToggle";
import { ScopeFormWrapper } from "@/features/claude-config/components/shared/ScopeFormWrapper";
import { MarkdownEditorPanel } from "@/features/claude-config/components/shared/MarkdownEditorPanel";

interface SkillFormProps {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  /** True while editing an existing skill, whose scope cannot change. */
  scopeLocked: boolean;
  /** Where the skill will be written, given its directory name. */
  savePathFor: (dirName: string) => string;
  initial?: SkillInfo;
  onSave: (skill: SkillInfo) => void;
  onCancel: () => void;
}

/** Skill names are directory names: lowercase alphanumerics and hyphens. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function extractBody(content: string): string {
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const endIdx = content.indexOf("\n---", 4);
    if (endIdx !== -1) {
      return content.substring(endIdx + 4).replace(/^\r?\n/, "");
    }
  }
  return content.startsWith("---") ? "" : content;
}

export function SkillForm({
  scope,
  onScopeChange,
  scopeLocked,
  savePathFor,
  initial,
  onSave,
  onCancel,
}: SkillFormProps) {
  const { t } = useTranslation("copilot-config");
  const [name, setName] = useState(initial?.dirName ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial ? extractBody(initial.content) : "");

  const trimmedName = name.trim();
  const nameValid = SKILL_NAME_PATTERN.test(trimmedName);

  const handleSave = () => {
    if (!nameValid) return;
    onSave({
      dirName: trimmedName,
      name: trimmedName,
      description: description.trim(),
      userInvocable: false,
      allowedTools: [],
      content: body,
    });
  };

  const savePath = savePathFor(trimmedName);

  return (
    <div className="claude-section">
      <ScopeToggle value={scope} onChange={onScopeChange} disabled={scopeLocked} />

      <ScopeFormWrapper scope={scope}>
        <div className="claude-section__field">
          <label className="claude-section__label">{t("skillName")}</label>
          <input
            className="claude-section__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!!initial}
            placeholder="my-skill-name"
          />
          {trimmedName !== "" && !nameValid && (
            <span className="claude-section__status claude-section__status--error">{t("skillNamePatternError")}</span>
          )}
        </div>
        <div className="claude-section__field">
          <label className="claude-section__label">{t("skillDescription")}</label>
          <input
            className="claude-section__input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="claude-section__field claude-section__field--fill">
          <label className="claude-section__label">{t("skillContent")}</label>
          <MarkdownEditorPanel value={body} onChange={setBody} placeholder={t("skillPlaceholder")} />
        </div>
      </ScopeFormWrapper>

      {savePath && (
        <div className="claude-section__path-hint">
          {t("skillSavePath")}: {savePath}
        </div>
      )}
      <div className="claude-section__form-actions">
        <button className="claude-section__save-btn" onClick={handleSave} disabled={!nameValid}>
          {t("save")}
        </button>
        <button className="claude-section__cancel-btn" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

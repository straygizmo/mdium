import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SkillInfo } from "@/shared/types";
import { ScopeToggle, type Scope } from "./shared/ScopeToggle";
import { ScopeFormWrapper } from "./shared/ScopeFormWrapper";
import { MarkdownEditorPanel } from "./shared/MarkdownEditorPanel";

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
  const { t } = useTranslation("claude-config");
  const [dirName, setDirName] = useState(initial?.dirName ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [userInvocable, setUserInvocable] = useState(initial?.userInvocable ?? false);
  const [allowedTools, setAllowedTools] = useState(initial?.allowedTools?.join(", ") ?? "");
  const [body, setBody] = useState(initial ? extractBody(initial.content) : "");

  const canSave = dirName.trim() !== "" && name.trim() !== "";

  const handleSave = () => {
    if (!canSave) return;
    const tools = allowedTools.split(",").map((s) => s.trim()).filter(Boolean);
    // The store rebuilds the frontmatter from the fields; only the body is passed as content.
    onSave({
      dirName: dirName.trim(),
      name: name.trim(),
      description: description.trim(),
      userInvocable,
      allowedTools: tools,
      content: body,
    });
  };

  const savePath = savePathFor(dirName.trim());

  return (
    <div className="claude-section">
      <ScopeToggle value={scope} onChange={onScopeChange} disabled={scopeLocked} />

      <ScopeFormWrapper scope={scope}>
        <div className="claude-section__field">
          <label className="claude-section__label">{t("skillDirName")}</label>
          <input
            className="claude-section__input"
            value={dirName}
            onChange={(e) => setDirName(e.target.value)}
            disabled={!!initial}
            placeholder="my-skill-name"
          />
        </div>
        <div className="claude-section__field">
          <label className="claude-section__label">{t("skillName")}</label>
          <input className="claude-section__input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="claude-section__field">
          <label className="claude-section__label">{t("skillDescription")}</label>
          <input
            className="claude-section__input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <label className="claude-section__toggle claude-section__toggle--inline">
          <span>{t("skillUserInvocable")}</span>
          <input
            type="checkbox"
            data-switch
            role="switch"
            checked={userInvocable}
            onChange={(e) => setUserInvocable(e.target.checked)}
          />
        </label>
        <div className="claude-section__field">
          <label className="claude-section__label">{t("skillAllowedTools")}</label>
          <input
            className="claude-section__input"
            value={allowedTools}
            onChange={(e) => setAllowedTools(e.target.value)}
            placeholder="Read, Edit, Bash..."
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
        <button className="claude-section__save-btn" onClick={handleSave} disabled={!canSave}>
          {t("save")}
        </button>
        <button className="claude-section__cancel-btn" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

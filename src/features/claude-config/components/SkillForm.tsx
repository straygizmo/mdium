import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SkillInfo } from "@/shared/types";

interface SkillFormProps {
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

export function SkillForm({ initial, onSave, onCancel }: SkillFormProps) {
  const { t } = useTranslation("settings");
  const [dirName, setDirName] = useState(initial?.dirName ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [userInvocable, setUserInvocable] = useState(initial?.userInvocable ?? false);
  const [allowedTools, setAllowedTools] = useState(initial?.allowedTools?.join(", ") ?? "");
  const [body, setBody] = useState(initial ? extractBody(initial.content) : "");

  const handleSave = () => {
    if (!dirName.trim() || !name.trim()) return;
    const tools = allowedTools.split(",").map((s) => s.trim()).filter(Boolean);
    // Build a placeholder content - the store will rebuild with frontmatter
    const content = body;
    onSave({
      dirName: dirName.trim(),
      name: name.trim(),
      description: description.trim(),
      userInvocable,
      allowedTools: tools,
      content,
    });
  };

  return (
    <div className="claude-config-form">
      <div className="claude-config-form__field">
        <label className="claude-config-form__label">{t("skillDirName")}</label>
        <input
          className="claude-config-form__input"
          value={dirName}
          onChange={(e) => setDirName(e.target.value)}
          disabled={!!initial}
        />
      </div>
      <div className="claude-config-form__field">
        <label className="claude-config-form__label">{t("skillName")}</label>
        <input
          className="claude-config-form__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="claude-config-form__field">
        <label className="claude-config-form__label">{t("skillDescription")}</label>
        <input
          className="claude-config-form__input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="claude-config-form__field">
        <label className="claude-config-form__toggle">
          <span>{t("skillUserInvocable")}</span>
          <input
            type="checkbox"
            checked={userInvocable}
            onChange={(e) => setUserInvocable(e.target.checked)}
          />
        </label>
      </div>
      <div className="claude-config-form__field">
        <label className="claude-config-form__label">{t("skillAllowedTools")}</label>
        <input
          className="claude-config-form__input"
          value={allowedTools}
          onChange={(e) => setAllowedTools(e.target.value)}
          placeholder="Read, Edit, Bash..."
        />
      </div>
      <div className="claude-config-form__field">
        <label className="claude-config-form__label">{t("skillContent")}</label>
        <textarea
          className="claude-config-form__textarea claude-config-form__textarea--tall"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
        />
      </div>
      <div className="claude-config-form__actions">
        <button className="claude-config-form__save-btn" onClick={handleSave}>{t("save")}</button>
        <button className="claude-config-form__cancel-btn" onClick={onCancel}>{t("cancel")}</button>
      </div>
    </div>
  );
}

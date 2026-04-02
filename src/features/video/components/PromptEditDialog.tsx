import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_SYSTEM_PROMPT } from "../lib/scene-decorator";
import "./PromptEditDialog.css";

interface PromptEditDialogProps {
  onExecute: (prompt: string) => void;
  onClose: () => void;
}

export function PromptEditDialog({ onExecute, onClose }: PromptEditDialogProps) {
  const { t } = useTranslation("video");
  const [prompt, setPrompt] = useState(DEFAULT_SYSTEM_PROMPT);

  const handleExecute = useCallback(() => {
    onExecute(prompt);
  }, [prompt, onExecute]);

  const handleReset = useCallback(() => {
    setPrompt(DEFAULT_SYSTEM_PROMPT);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div className="prompt-edit-overlay" onClick={onClose}>
      <div
        className="prompt-edit-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h3 className="prompt-edit-dialog__title">{t("promptEditTitle")}</h3>
        <textarea
          className="prompt-edit-dialog__textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={20}
          autoFocus
        />
        <div className="prompt-edit-dialog__actions">
          <button
            className="prompt-edit-dialog__btn prompt-edit-dialog__btn--reset"
            onClick={handleReset}
          >
            {t("promptEditReset")}
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="prompt-edit-dialog__btn prompt-edit-dialog__btn--cancel"
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <button
            className="prompt-edit-dialog__btn prompt-edit-dialog__btn--primary"
            onClick={handleExecute}
            disabled={!prompt.trim()}
          >
            {t("promptEditExecute")}
          </button>
        </div>
      </div>
    </div>
  );
}

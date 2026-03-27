import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import "./AiGenerateModal.css";

interface AiGenerateModalProps {
  onGenerate: (description: string) => Promise<string>;
  onInsert: (code: string) => void;
  onClose: () => void;
}

export function AiGenerateModal({ onGenerate, onInsert, onClose }: AiGenerateModalProps) {
  const { t } = useTranslation("common");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!description.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const code = await onGenerate(description);
      onInsert(`\n\`\`\`mermaid\n${code}\n\`\`\`\n`);
      onClose();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [description, onGenerate, onInsert, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && e.ctrlKey) {
        handleGenerate();
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [handleGenerate, onClose]
  );

  return (
    <div className="ai-modal-overlay" onClick={onClose}>
      <div className="ai-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <h3 className="ai-modal__title">AI Mermaid</h3>
        <textarea
          className="ai-modal__input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the diagram..."
          rows={4}
          autoFocus
        />
        {error && <div className="ai-modal__error">{error}</div>}
        <div className="ai-modal__actions">
          <button className="ai-modal__btn ai-modal__btn--cancel" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="ai-modal__btn ai-modal__btn--primary"
            onClick={handleGenerate}
            disabled={loading || !description.trim()}
          >
            {loading ? t("loading") : "Generate"}
          </button>
        </div>
      </div>
    </div>
  );
}

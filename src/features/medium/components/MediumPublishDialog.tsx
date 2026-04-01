import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import "./MediumPublishDialog.css";

export interface MediumPublishParams {
  title: string;
  tags: string[];
  canonicalUrl: string;
}

interface MediumPublishDialogProps {
  defaultTitle: string;
  defaultTags: string[];
  defaultCanonicalUrl: string;
  onSubmit: (params: MediumPublishParams) => void;
  onCancel: () => void;
}

export function MediumPublishDialog({
  defaultTitle,
  defaultTags,
  defaultCanonicalUrl,
  onSubmit,
  onCancel,
}: MediumPublishDialogProps) {
  const { t } = useTranslation("editor");

  const [title, setTitle] = useState(defaultTitle);
  const [tags, setTags] = useState<string[]>(defaultTags);
  const [tagInput, setTagInput] = useState("");
  const [canonicalUrl, setCanonicalUrl] = useState(defaultCanonicalUrl);

  const handleAddTag = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const tag = tagInput.trim();
      if (!tag || tags.length >= 5 || tags.includes(tag)) return;
      setTags([...tags, tag]);
      setTagInput("");
    },
    [tagInput, tags],
  );

  const handleRemoveTag = useCallback(
    (index: number) => {
      setTags(tags.filter((_, i) => i !== index));
    },
    [tags],
  );

  const handleSubmit = useCallback(() => {
    if (!title.trim()) return;
    onSubmit({ title: title.trim(), tags, canonicalUrl: canonicalUrl.trim() });
  }, [title, tags, canonicalUrl, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    },
    [onCancel],
  );

  return (
    <div className="medium-publish-overlay" onClick={onCancel}>
      <div
        className="medium-publish-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <h3 className="medium-publish-dialog__title">
          {t("mediumPublishTitle")}
        </h3>

        <div className="medium-publish-dialog__field">
          <span className="medium-publish-dialog__field-label">
            {t("mediumTitle")}
          </span>
          <input
            className="medium-publish-dialog__input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>

        <div className="medium-publish-dialog__field">
          <span className="medium-publish-dialog__field-label">
            {t("mediumTags")}
          </span>
          <div className="medium-publish-dialog__tags">
            {tags.map((tag, i) => (
              <span key={tag} className="medium-publish-dialog__tag">
                {tag}
                <span
                  className="medium-publish-dialog__tag-remove"
                  onClick={() => handleRemoveTag(i)}
                >
                  ×
                </span>
              </span>
            ))}
          </div>
          {tags.length < 5 && (
            <input
              className="medium-publish-dialog__input"
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleAddTag}
              placeholder={t("mediumTagsPlaceholder")}
            />
          )}
        </div>

        <div className="medium-publish-dialog__field">
          <span className="medium-publish-dialog__field-label">
            {t("mediumCanonicalUrl")}
          </span>
          <input
            className="medium-publish-dialog__input"
            type="text"
            value={canonicalUrl}
            onChange={(e) => setCanonicalUrl(e.target.value)}
            placeholder="https://..."
          />
        </div>

        <div className="medium-publish-dialog__actions">
          <button className="medium-publish-dialog__btn" onClick={onCancel}>
            {t("mediumCancel")}
          </button>
          <button
            className="medium-publish-dialog__btn medium-publish-dialog__btn--primary"
            onClick={handleSubmit}
            disabled={!title.trim()}
          >
            {t("mediumPublish")}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import "./ZennNewArticleDialog.css";

interface ZennNewArticleDialogProps {
  onClose: () => void;
  onCreate: (slug: string, title: string, emoji: string, type: "tech" | "idea", topics: string[]) => void;
}

export function ZennNewArticleDialog({ onClose, onCreate }: ZennNewArticleDialogProps) {
  const { t } = useTranslation("common");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [emoji, setEmoji] = useState("📝");
  const [type, setType] = useState<"tech" | "idea">("tech");
  const [topicInput, setTopicInput] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const addTopic = useCallback(() => {
    const t = topicInput.trim().toLowerCase();
    if (!t || topics.length >= 5 || topics.includes(t)) return;
    if (!/^[a-z0-9-]+$/.test(t)) return;
    setTopics([...topics, t]);
    setTopicInput("");
  }, [topicInput, topics]);

  const removeTopic = useCallback((idx: number) => {
    setTopics(topics.filter((_, i) => i !== idx));
  }, [topics]);

  const handleCreate = useCallback(() => {
    if (slug.length < 12 || slug.length > 50) {
      setError("Slug must be 12-50 characters");
      return;
    }
    if (!/^[a-z0-9_-]+$/.test(slug)) {
      setError("Slug must contain only a-z, 0-9, -, _");
      return;
    }
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    onCreate(slug, title, emoji, type, topics);
  }, [slug, title, emoji, type, topics, onCreate]);

  return (
    <div className="zenn-dialog-overlay" onClick={onClose}>
      <div className="zenn-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="zenn-dialog__title">New Zenn Article</h3>

        <label className="zenn-dialog__label">Slug</label>
        <input className="zenn-dialog__input" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-article-slug (12-50 chars)" />

        <label className="zenn-dialog__label">Title</label>
        <input className="zenn-dialog__input" value={title} onChange={(e) => setTitle(e.target.value)} />

        <label className="zenn-dialog__label">Emoji</label>
        <input className="zenn-dialog__input zenn-dialog__input--emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} />

        <label className="zenn-dialog__label">Type</label>
        <select className="zenn-dialog__select" value={type} onChange={(e) => setType(e.target.value as "tech" | "idea")}>
          <option value="tech">tech</option>
          <option value="idea">idea</option>
        </select>

        <label className="zenn-dialog__label">Topics (max 5)</label>
        <div className="zenn-dialog__topics">
          {topics.map((topic, i) => (
            <span key={topic} className="zenn-dialog__topic-tag">
              {topic}
              <button onClick={() => removeTopic(i)}>×</button>
            </span>
          ))}
          {topics.length < 5 && (
            <input
              className="zenn-dialog__topic-input"
              value={topicInput}
              onChange={(e) => setTopicInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTopic())}
              placeholder="topic"
            />
          )}
        </div>

        {error && <div className="zenn-dialog__error">{error}</div>}

        <div className="zenn-dialog__actions">
          <button className="zenn-dialog__btn" onClick={onClose}>{t("cancel")}</button>
          <button className="zenn-dialog__btn zenn-dialog__btn--primary" onClick={handleCreate}>Create</button>
        </div>
      </div>
    </div>
  );
}

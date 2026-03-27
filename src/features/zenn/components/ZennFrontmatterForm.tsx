import { useState, useEffect, useCallback, useRef } from "react";
import "./ZennFrontmatterForm.css";

interface ZennFrontMatter {
  title: string;
  emoji: string;
  type: "tech" | "idea";
  topics: string[];
  published: boolean;
}

interface ZennFrontmatterFormProps {
  frontmatter: ZennFrontMatter;
  onChange: (fm: ZennFrontMatter) => void;
}

export function ZennFrontmatterForm({ frontmatter, onChange }: ZennFrontmatterFormProps) {
  const [local, setLocal] = useState(frontmatter);
  const [topicInput, setTopicInput] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocal(frontmatter);
  }, [frontmatter]);

  const update = useCallback(
    (partial: Partial<ZennFrontMatter>) => {
      const next = { ...local, ...partial };
      setLocal(next);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => onChange(next), 400);
    },
    [local, onChange]
  );

  const addTopic = useCallback(() => {
    const t = topicInput.trim().toLowerCase();
    if (!t || local.topics.length >= 5 || local.topics.includes(t)) return;
    update({ topics: [...local.topics, t] });
    setTopicInput("");
  }, [topicInput, local.topics, update]);

  return (
    <div className="zenn-fm">
      <div className="zenn-fm__row">
        <input
          className="zenn-fm__emoji"
          value={local.emoji}
          onChange={(e) => update({ emoji: e.target.value })}
        />
        <input
          className="zenn-fm__title"
          value={local.title}
          onChange={(e) => update({ title: e.target.value })}
          placeholder="Title"
        />
      </div>
      <div className="zenn-fm__row">
        <select
          className="zenn-fm__select"
          value={local.type}
          onChange={(e) => update({ type: e.target.value as "tech" | "idea" })}
        >
          <option value="tech">tech</option>
          <option value="idea">idea</option>
        </select>
        <label className="zenn-fm__checkbox">
          <input
            type="checkbox"
            checked={local.published}
            onChange={(e) => update({ published: e.target.checked })}
          />
          Published
        </label>
      </div>
      <div className="zenn-fm__topics">
        {local.topics.map((topic, i) => (
          <span key={topic} className="zenn-fm__tag">
            {topic}
            <button onClick={() => update({ topics: local.topics.filter((_, j) => j !== i) })}>×</button>
          </span>
        ))}
        {local.topics.length < 5 && (
          <input
            className="zenn-fm__topic-input"
            value={topicInput}
            onChange={(e) => setTopicInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTopic())}
            placeholder="+"
          />
        )}
      </div>
    </div>
  );
}

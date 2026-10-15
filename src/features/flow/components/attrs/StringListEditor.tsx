import { useState } from "react";
import { useTranslation } from "react-i18next";

interface StringListEditorProps {
  items: string[];
  onChange: (items: string[]) => void;
  addLabel: string;
}

/** Row editor for a list of strings: edit in place on blur, remove, and add. */
export function StringListEditor({ items, onChange, addLabel }: StringListEditorProps) {
  const { t } = useTranslation("flow");
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim();
    if (text === "") return;
    onChange([...items, text]);
    setDraft("");
  };
  return (
    <div className="flow-attrs__list">
      {items.map((item, i) => (
        <div key={i} className="flow-attrs__row">
          <input
            type="text"
            aria-label={t("attrs.item")}
            defaultValue={item}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next !== item) onChange(next === "" ? items.filter((_, j) => j !== i) : items.map((x, j) => (j === i ? next : x)));
            }}
          />
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            {t("attrs.remove")}
          </button>
        </div>
      ))}
      <div className="flow-attrs__row">
        <input
          type="text"
          aria-label={t("attrs.item")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" onClick={add}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}

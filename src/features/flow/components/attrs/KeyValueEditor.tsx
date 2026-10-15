import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isIdent } from "../../lib/flow-ports";

export interface ColumnSpec<T> {
  id: string;
  label: string;
  /** Renders the cell of one row; `onChange` replaces the row's value. */
  render: (value: T, onChange: (next: T) => void) => ReactNode;
}

interface KeyValueEditorProps<T> {
  entries: Record<string, T>;
  columns: ColumnSpec<T>[];
  /** Emits the whole next record. */
  onChange: (next: Record<string, T>) => void;
  addLabel: string;
  /** The value of a freshly added row. */
  makeEntry: () => T;
}

/** Row editor for a keyed record. New keys must satisfy `isIdent` and be unique. */
export function KeyValueEditor<T>({ entries, columns, onChange, addLabel, makeEntry }: KeyValueEditorProps<T>) {
  const { t } = useTranslation("flow");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const key = draft.trim();
    if (!isIdent(key)) return setError(t("attrs.invalidKey"));
    if (Object.prototype.hasOwnProperty.call(entries, key)) return setError(t("attrs.duplicateKey"));
    setError(null);
    setDraft("");
    onChange({ ...entries, [key]: makeEntry() });
  };
  return (
    <div className="flow-attrs__list">
      {Object.entries(entries).map(([key, value]) => (
        <div key={key} className="flow-attrs__row">
          <code className="flow-attrs__key">{key}</code>
          {columns.map((col) => (
            <div key={col.id} className="flow-attrs__cell">
              {col.render(value, (next) => onChange({ ...entries, [key]: next }))}
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              const rest = { ...entries };
              delete rest[key];
              onChange(rest);
            }}
          >
            {t("attrs.remove")}
          </button>
        </div>
      ))}
      <div className="flow-attrs__row">
        <input
          type="text"
          aria-label={t("attrs.newKey")}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" onClick={add}>
          {addLabel}
        </button>
      </div>
      {error && <div className="flow-attrs__error">{error}</div>}
    </div>
  );
}

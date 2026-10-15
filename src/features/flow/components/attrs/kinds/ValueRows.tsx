import { useTranslation } from "react-i18next";
import { TextField, parseNumber } from "../fields";

export interface ValueFieldSpec {
  name: string;
  /** Declared value type (`string`, `number`, `bool`, ...). */
  type: string;
  required: boolean;
  description?: string;
}

/** Text shown for a stored value: strings as-is, other values as JSON. */
export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Parses edited text back, guided by the declared type or the type of the previous value. */
export function parseValue(text: string | undefined, type: string | undefined, previous: unknown): unknown {
  if (text === undefined) return "";
  if (type === "number" || (type === undefined && typeof previous === "number")) {
    const n = parseNumber(text);
    return n === undefined ? text : n;
  }
  if (type === "bool" || (type === undefined && typeof previous === "boolean")) {
    if (text === "true") return true;
    if (text === "false") return false;
    return text;
  }
  if (typeof previous === "object" && previous !== null) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

interface ValueRowsProps {
  fields: ValueFieldSpec[];
  values: Record<string, unknown> | undefined;
  /** Emits the whole next record. */
  onChange: (next: Record<string, unknown>) => void;
}

/**
 * One row per declared field (name, required marker, type, current value), followed by removable
 * rows for keys that are present in `values` but not declared.
 */
export function ValueRows({ fields, values, onChange }: ValueRowsProps) {
  const { t } = useTranslation("flow");
  const current = values ?? {};
  const declared = new Set(fields.map((f) => f.name));
  const extras = Object.keys(current).filter((key) => !declared.has(key));
  return (
    <div className="flow-attrs__list">
      {fields.map((field) => (
        <div key={field.name} className="flow-attrs__row" title={field.description}>
          <TextField
            label={field.required ? `${field.name} *` : field.name}
            value={formatValue(current[field.name])}
            onCommit={(text) => {
              if (text !== undefined) {
                onChange({ ...current, [field.name]: parseValue(text, field.type, current[field.name]) });
                return;
              }
              // Cleared: drop the key rather than writing "" (an empty value is not "unset").
              if (!Object.hasOwn(current, field.name)) return;
              const rest = { ...current };
              delete rest[field.name];
              onChange(rest);
            }}
          />
          <span className="flow-attrs__type">{field.type}</span>
        </div>
      ))}
      {extras.length > 0 && <div className="flow-attrs__hint">{t("attrs.extraKeys")}</div>}
      {extras.map((key) => (
        <div key={key} className="flow-attrs__row">
          <TextField
            label={key}
            value={formatValue(current[key])}
            onCommit={(text) => onChange({ ...current, [key]: parseValue(text, undefined, current[key]) })}
          />
          <button
            type="button"
            onClick={() => {
              const rest = { ...current };
              delete rest[key];
              onChange(rest);
            }}
          >
            {t("attrs.remove")}
          </button>
        </div>
      ))}
    </div>
  );
}

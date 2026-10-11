import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlowCompareOp, FlowCondition } from "@/shared/types/flow";

type Comparison = Extract<FlowCondition, { ref: string }>;
type ConditionValue = Comparison["value"];
type GroupKind = "comparison" | "all" | "any" | "not";

const OPS: FlowCompareOp[] = ["==", "!=", "<", "<=", ">", ">=", "in", "exists"];
const KINDS: GroupKind[] = ["comparison", "all", "any", "not"];
const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Parses the value field: number, boolean, JSON array (when it starts with `[` and parses), else a string. */
export function parseConditionValue(text: string): ConditionValue {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  // Only text that is the canonical spelling of its number ("7", not "007" or "1.50") becomes a number.
  if (NUMERIC.test(trimmed) && String(Number(trimmed)) === trimmed) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed as Array<string | number | boolean>;
    } catch {
      // Not valid JSON: keep it as a string.
    }
  }
  return text;
}

/** Text shown in the value field for a stored value. */
export function formatConditionValue(value: ConditionValue): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

export const newComparison = (): Comparison => ({ ref: "", op: "==" });

function kindOf(c: FlowCondition): GroupKind {
  if ("all" in c) return "all";
  if ("any" in c) return "any";
  if ("not" in c) return "not";
  return "comparison";
}

function childrenOf(c: FlowCondition): FlowCondition[] {
  if ("all" in c) return c.all;
  if ("any" in c) return c.any;
  if ("not" in c) return [c.not];
  return [];
}

/** Rebuilds a condition of another kind, carrying the existing children over where possible. */
function convert(c: FlowCondition, kind: GroupKind): FlowCondition {
  const children = childrenOf(c);
  switch (kind) {
    case "comparison":
      return newComparison();
    case "all":
      return { all: children };
    case "any":
      return { any: children };
    case "not":
      return { not: children[0] ?? newComparison() };
  }
}

interface ConditionEditorProps {
  value: FlowCondition;
  onChange: (value: FlowCondition) => void;
  /** Shows a remove button (used for children of a group). */
  onRemove?: () => void;
}

/** Recursive editor for the minimal condition syntax: a comparison or an all / any / not group. */
export function ConditionEditor({ value, onChange, onRemove }: ConditionEditorProps) {
  const { t } = useTranslation("flow");
  const kind = kindOf(value);
  return (
    <div className="flow-attrs__condition">
      <div className="flow-attrs__row">
        <select aria-label={t("attrs.condition.kind")} value={kind} onChange={(e) => onChange(convert(value, e.target.value as GroupKind))}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`attrs.condition.${k}`)}
            </option>
          ))}
        </select>
        {onRemove && (
          <button type="button" onClick={onRemove}>
            {t("attrs.remove")}
          </button>
        )}
      </div>
      {"ref" in value ? (
        <ComparisonFields value={value} onChange={onChange} />
      ) : "not" in value ? (
        <div className="flow-attrs__children">
          <ConditionEditor value={value.not} onChange={(next) => onChange({ not: next })} />
        </div>
      ) : (
        <GroupChildren
          items={"all" in value ? value.all : value.any}
          onChange={(items) => onChange("all" in value ? { all: items } : { any: items })}
        />
      )}
    </div>
  );
}

function GroupChildren({ items, onChange }: { items: FlowCondition[]; onChange: (items: FlowCondition[]) => void }) {
  const { t } = useTranslation("flow");
  return (
    <div className="flow-attrs__children">
      {items.map((item, i) => (
        <ConditionEditor
          key={i}
          value={item}
          onChange={(next) => onChange(items.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(items.filter((_, j) => j !== i))}
        />
      ))}
      <div className="flow-attrs__row">
        <button type="button" onClick={() => onChange([...items, newComparison()])}>
          {t("attrs.condition.addComparison")}
        </button>
        <button type="button" onClick={() => onChange([...items, { all: [] }])}>
          {t("attrs.condition.addGroup")}
        </button>
      </div>
    </div>
  );
}

function ComparisonFields({ value, onChange }: { value: Comparison; onChange: (value: FlowCondition) => void }) {
  const { t } = useTranslation("flow");
  const [ref, setRef] = useState(value.ref);
  const [text, setText] = useState(formatConditionValue(value.value));
  useEffect(() => setRef(value.ref), [value.ref]);
  const stored = formatConditionValue(value.value);
  useEffect(() => setText(stored), [stored]);
  const write = (patch: Partial<Comparison>) => {
    const next: Comparison = { ref: value.ref, op: value.op, ...patch };
    if (value.value !== undefined && !("value" in patch)) next.value = value.value;
    if (next.op === "exists" || next.value === undefined) delete next.value;
    onChange(next);
  };
  return (
    <div className="flow-attrs__row">
      <input
        type="text"
        aria-label={t("attrs.condition.ref")}
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        onBlur={() => ref !== value.ref && write({ ref })}
      />
      <select aria-label={t("attrs.condition.op")} value={value.op} onChange={(e) => write({ op: e.target.value as FlowCompareOp })}>
        {OPS.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>
      {value.op !== "exists" && (
        <input
          type="text"
          aria-label={t("attrs.condition.value")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== stored && write({ value: parseConditionValue(text) })}
        />
      )}
    </div>
  );
}

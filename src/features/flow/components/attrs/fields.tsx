import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlowRetryOn, FlowRetryPolicy } from "@/shared/types/flow";

/** Returns `value`, or `undefined` when it has no defined property (so an empty object deletes its key). */
export function compact<T extends object>(value: T): T | undefined {
  return Object.values(value).some((v) => v !== undefined) ? value : undefined;
}

/** Parses a number field; blank or NaN becomes `undefined`. */
export function parseNumber(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isNaN(n) ? undefined : n;
}

interface TextFieldProps {
  label: string;
  value: string | undefined;
  onCommit: (value: string | undefined) => void;
  placeholder?: string;
  multiline?: boolean;
  readOnly?: boolean;
  /** Called with the raw text on blur / Enter before committing; return false to veto. */
  validate?: (text: string) => boolean;
}

/** A labelled text input that writes through on blur (Enter for single-line); empty text commits `undefined`. */
export function TextField({ label, value, onCommit, placeholder, multiline, readOnly, validate }: TextFieldProps) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const commit = () => {
    if (validate && !validate(text)) return;
    const next = text === "" ? undefined : text;
    if (next !== value) onCommit(next);
  };
  return (
    <label className="flow-attrs__field">
      <span>{label}</span>
      {multiline ? (
        <textarea aria-label={label} value={text} placeholder={placeholder} readOnly={readOnly} onChange={(e) => setText(e.target.value)} onBlur={commit} />
      ) : (
        <input
          type="text"
          aria-label={label}
          value={text}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
      )}
    </label>
  );
}

interface NumberFieldProps {
  label: string;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
}

/** A labelled number input; blank or NaN commits `undefined`. */
export function NumberField({ label, value, onCommit }: NumberFieldProps) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    const next = parseNumber(text);
    if (next !== value) onCommit(next);
  };
  return (
    <label className="flow-attrs__field">
      <span>{label}</span>
      <input type="text" inputMode="decimal" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />
    </label>
  );
}

const RETRY_ON: FlowRetryOn[] = ["failed", "timeout"];

interface RetryFieldsProps {
  value: FlowRetryPolicy | undefined;
  onChange: (value: FlowRetryPolicy | undefined) => void;
}

/** Retry policy editor (max, backoff, triggers); clears to `undefined` when everything is blank. */
export function RetryFields({ value, onChange }: RetryFieldsProps) {
  const { t } = useTranslation("flow");
  const write = (patch: Partial<FlowRetryPolicy>) => {
    const next = { max: value?.max, backoff: value?.backoff, on: value?.on, ...patch };
    const empty = next.max === undefined && next.backoff === undefined && (next.on === undefined || next.on.length === 0);
    if (empty) return onChange(undefined);
    const out: FlowRetryPolicy = { max: next.max ?? 0 };
    if (next.backoff !== undefined) out.backoff = next.backoff;
    if (next.on && next.on.length > 0) out.on = next.on;
    onChange(out);
  };
  return (
    <div className="flow-attrs__row">
      <NumberField label={t("attrs.retryMax")} value={value?.max} onCommit={(max) => write({ max })} />
      <TextField label={t("attrs.retryBackoff")} value={value?.backoff} placeholder="5s" onCommit={(backoff) => write({ backoff })} />
      <fieldset className="flow-attrs__field">
        <legend>{t("attrs.retryOn")}</legend>
        {RETRY_ON.map((on) => (
          <label key={on} className="flow-attrs__check">
            <input
              type="checkbox"
              checked={value?.on?.includes(on) ?? false}
              onChange={(e) => {
                const current = value?.on ?? [];
                write({ on: e.target.checked ? [...current, on] : current.filter((o) => o !== on) });
              }}
            />
            <span>{t(`attrs.retryOnValue.${on}`)}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

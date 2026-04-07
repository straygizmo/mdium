import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDialogStore, type ChoiceOption } from "@/stores/dialog-store";
import "./AppDialog.css";

const KIND_ICONS: Record<string, string> = {
  info: "\u2139\uFE0F",
  warning: "\u26A0\uFE0F",
  error: "\u274C",
};

export function AppDialog() {
  const { t } = useTranslation("common");
  const dialogs = useDialogStore((s) => s.dialogs);
  const remove = useDialogStore((s) => s._remove);

  const entry = dialogs[0];
  if (!entry) return null;

  const handleResolve = (value: boolean | string | null) => {
    remove(entry.id);
    entry.resolve(value);
  };

  return (
    <div className="app-dialog__overlay" onMouseDown={() => {
      if (entry.type === "message") handleResolve(true);
      else handleResolve(entry.type === "confirm" ? false : null);
    }}>
      <div className="app-dialog" onMouseDown={(e) => e.stopPropagation()}>
        {entry.type === "message" ? (
          <MessageContent entry={entry} onClose={() => handleResolve(true)} okLabel={t("ok")} />
        ) : entry.type === "confirm" ? (
          <ConfirmContent
            entry={entry}
            onConfirm={() => handleResolve(true)}
            onCancel={() => handleResolve(false)}
            okLabel={t("ok")}
            cancelLabel={t("cancel")}
          />
        ) : entry.type === "choice" ? (
          <ChoiceContent
            entry={entry}
            onChoice={(v) => handleResolve(v)}
            onCancel={() => handleResolve(null)}
            cancelLabel={t("cancel")}
          />
        ) : (
          <PromptContent
            entry={entry}
            onConfirm={(v) => handleResolve(v)}
            onCancel={() => handleResolve(null)}
            okLabel={t("ok")}
            cancelLabel={t("cancel")}
          />
        )}
      </div>
    </div>
  );
}

/* ── Message ── */
function MessageContent({
  entry,
  onClose,
  okLabel,
}: {
  entry: { title?: string; text: string; kind?: string };
  onClose: () => void;
  okLabel: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { btnRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      {entry.title && <div className="app-dialog__title">{entry.title}</div>}
      <div className="app-dialog__body">
        {entry.kind && <span className="app-dialog__icon">{KIND_ICONS[entry.kind]}</span>}
        <span>{entry.text}</span>
      </div>
      <div className="app-dialog__actions">
        <button ref={btnRef} className="app-dialog__btn app-dialog__btn--primary" onClick={onClose}>
          {okLabel}
        </button>
      </div>
    </>
  );
}

/* ── Confirm ── */
function ConfirmContent({
  entry,
  onConfirm,
  onCancel,
  okLabel,
  cancelLabel,
}: {
  entry: { title?: string; text: string; kind?: string };
  onConfirm: () => void;
  onCancel: () => void;
  okLabel: string;
  cancelLabel: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { btnRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <>
      {entry.title && <div className="app-dialog__title">{entry.title}</div>}
      <div className="app-dialog__body">
        {entry.kind && <span className="app-dialog__icon">{KIND_ICONS[entry.kind]}</span>}
        <span>{entry.text}</span>
      </div>
      <div className="app-dialog__actions">
        <button ref={btnRef} className="app-dialog__btn app-dialog__btn--primary" onClick={onConfirm}>
          {okLabel}
        </button>
        <button className="app-dialog__btn" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </>
  );
}

/* ── Prompt ── */
function PromptContent({
  entry,
  onConfirm,
  onCancel,
  okLabel,
  cancelLabel,
}: {
  entry: { title?: string; text: string; defaultValue?: string };
  onConfirm: (value: string) => void;
  onCancel: () => void;
  okLabel: string;
  cancelLabel: string;
}) {
  const [value, setValue] = useState(entry.defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") onConfirm(value);
      else if (e.key === "Escape") onCancel();
    },
    [value, onConfirm, onCancel],
  );

  return (
    <>
      {entry.title && <div className="app-dialog__title">{entry.title}</div>}
      {entry.text && <div className="app-dialog__label">{entry.text}</div>}
      <input
        ref={inputRef}
        className="app-dialog__input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="app-dialog__actions">
        <button className="app-dialog__btn app-dialog__btn--primary" onClick={() => onConfirm(value)}>
          {okLabel}
        </button>
        <button className="app-dialog__btn" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </>
  );
}

/* ── Choice ── */
function ChoiceContent({
  entry,
  onChoice,
  onCancel,
  cancelLabel,
}: {
  entry: { title?: string; text: string; kind?: string; choices?: ChoiceOption[] };
  onChoice: (value: string) => void;
  onCancel: () => void;
  cancelLabel: string;
}) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { primaryRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const choices = entry.choices ?? [];

  return (
    <>
      {entry.title && <div className="app-dialog__title">{entry.title}</div>}
      <div className="app-dialog__body">
        {entry.kind && <span className="app-dialog__icon">{KIND_ICONS[entry.kind]}</span>}
        <span>{entry.text}</span>
      </div>
      <div className="app-dialog__actions">
        {choices.map((c, i) => (
          <button
            key={c.value}
            ref={c.primary ? primaryRef : (i === 0 && !choices.some((x) => x.primary) ? primaryRef : undefined)}
            className={`app-dialog__btn${c.primary ? " app-dialog__btn--primary" : ""}`}
            onClick={() => onChoice(c.value)}
          >
            {c.label}
          </button>
        ))}
        <button className="app-dialog__btn" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </>
  );
}

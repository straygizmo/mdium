import { type KeyboardEvent, type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { trapTab, useDialogFocus } from "../lib/dialog-focus";
import "./SafetyNoticeDialog.css";

/** localStorage key set to "1" once the user accepted the safety notice. */
export const SAFETY_ACK_KEY = "mdium-workflow-safety-ack";

/** Whether the safety notice was accepted; unreadable storage counts as not accepted. */
export function isSafetyAcknowledged(): boolean {
  try {
    return localStorage.getItem(SAFETY_ACK_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remembers the acceptance; a storage failure only means the notice is shown again. */
export function acknowledgeSafety(): void {
  try {
    localStorage.setItem(SAFETY_ACK_KEY, "1");
  } catch {
    // Enabling still proceeds; the notice will simply be shown next time.
  }
}

const GUARD_KEYS = [
  "guardScreening",
  "guardRuntime",
  "guardContainment",
  "guardPostCheck",
  "guardMergeReview",
] as const;

interface SafetyNoticeDialogProps {
  onAccept(): void;
  onCancel(): void;
}

/** Explains what enabling a workflow allows and where the guards stop. */
export function SafetyNoticeDialog({ onAccept, onCancel }: SafetyNoticeDialogProps) {
  const { t } = useTranslation("workflow");
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogFocus(dialogRef, true);

  const onKeyDown = (e: KeyboardEvent) => {
    // Keep Escape and Tab from reaching the edit dialog underneath.
    e.stopPropagation();
    if (e.key === "Escape") onCancel();
    else trapTab(e, dialogRef.current);
  };

  return (
    <div
      className="workflow-safety-overlay"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="workflow-safety"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-safety-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h3 id="workflow-safety-title" className="workflow-safety__title">
          {t("safety.title")}
        </h3>
        <div className="workflow-safety__body">
          <p className="workflow-safety__text">{t("safety.isolation")}</p>
          <p className="workflow-safety__text">{t("safety.guardsIntro")}</p>
          <ul className="workflow-safety__guards">
            {GUARD_KEYS.map((key) => (
              <li key={key}>{t(`safety.${key}`)}</li>
            ))}
          </ul>
          <p className="workflow-safety__text workflow-safety__text--warning">{t("safety.limits")}</p>
          <p className="workflow-safety__text">{t("safety.noPush")}</p>
        </div>
        <div className="workflow-safety__buttons">
          <button type="button" className="workflow-safety__cancel" onClick={onCancel}>
            {t("safety.cancel")}
          </button>
          <button type="button" className="workflow-safety__accept" onClick={onAccept}>
            {t("safety.accept")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Enable confirmation backed by the safety notice: resolves true at once when
 * the notice was already accepted, otherwise shows `dialog` and resolves with
 * the user's choice. A pending request resolves false on unmount or `cancel`.
 */
export function useSafetyConfirm(): {
  confirmEnable: () => Promise<boolean>;
  /** Closes a pending notice as cancelled. */
  cancel: () => void;
  dialog: ReactElement | null;
} {
  const [pending, setPending] = useState(false);
  const resolveRef = useRef<((accepted: boolean) => void) | null>(null);

  const settle = useCallback((accepted: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setPending(false);
    resolve?.(accepted);
  }, []);

  useEffect(
    () => () => {
      resolveRef.current?.(false);
      resolveRef.current = null;
    },
    [],
  );

  const confirmEnable = useCallback(() => {
    if (isSafetyAcknowledged()) return Promise.resolve(true);
    // A second request replaces the first, which counts as cancelled.
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setPending(true);
    });
  }, []);

  const dialog = pending ? (
    <SafetyNoticeDialog
      onAccept={() => {
        acknowledgeSafety();
        settle(true);
      }}
      onCancel={() => settle(false)}
    />
  ) : null;

  const cancel = useCallback(() => settle(false), [settle]);

  return { confirmEnable, cancel, dialog };
}

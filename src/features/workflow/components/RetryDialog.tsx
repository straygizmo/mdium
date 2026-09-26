import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AttentionReason } from "@/shared/types/workflow";
import { isRecord } from "../lib/errors";
import { formatAttention, formatCode } from "../lib/format";
import { DialogShell } from "./DialogShell";
import "./RetryDialog.css";

/** Acceptance flags of `workflow_retry_task`. */
export interface RetryOptions {
  acceptScreening: boolean;
  acceptAgentConfig: boolean;
  acceptIntegrity: boolean;
}

type RetryFlag = keyof RetryOptions;

const NO_ACCEPTANCES: RetryOptions = { acceptScreening: false, acceptAgentConfig: false, acceptIntegrity: false };

/** Integrity changes the backend only retries with `acceptIntegrity`. */
const ACK_INTEGRITY_CODES: ReadonlySet<string> = new Set([
  "INTEGRITY_GIT_CONFIG_CHANGED",
  "INTEGRITY_HOOKS_CHANGED",
  "INTEGRITY_HOOKS_PATH_CHANGED",
]);

/**
 * Whether an integrity attention lists a git config or hooks change. An
 * unreadable list counts as one, so the acknowledgement is never hidden.
 */
function needsIntegrityAck(reason: AttentionReason): boolean {
  let items: unknown;
  try {
    items = JSON.parse(reason.params?.items ?? "[]");
  } catch {
    return true;
  }
  if (!Array.isArray(items)) return true;
  return items.some((item) => isRecord(item) && ACK_INTEGRITY_CODES.has(String(item.code)));
}

/** The acceptance flags that are relevant to an attention reason. */
export function relevantRetryFlags(reason: AttentionReason | null, integrityAckRequired: boolean): RetryFlag[] {
  const flags: RetryFlag[] = [];
  if (reason?.code === "ATTENTION_SCREENING_FLAGGED") flags.push("acceptScreening");
  if (reason?.code === "ATTENTION_AGENT_CONFIG_CHANGED") flags.push("acceptAgentConfig");
  if (integrityAckRequired || (reason?.code === "ATTENTION_INTEGRITY_CHANGED" && needsIntegrityAck(reason))) {
    flags.push("acceptIntegrity");
  }
  return flags;
}

interface RetryDialogProps {
  /** The task's attention reason. */
  reason: AttentionReason | null;
  /** Set after the backend replied `WORKFLOW_INTEGRITY_ACK_REQUIRED`. */
  integrityAckRequired: boolean;
  /** Choices of the previous attempt when the dialog re-opens. */
  initialOptions?: RetryOptions;
  onConfirm(options: RetryOptions): void;
  onCancel(): void;
}

/** Confirms a retry and collects the acceptances the attention reason needs. */
export function RetryDialog({ reason, integrityAckRequired, initialOptions, onConfirm, onCancel }: RetryDialogProps) {
  const { t } = useTranslation("workflow");
  const [options, setOptions] = useState<RetryOptions>(initialOptions ?? NO_ACCEPTANCES);
  const flags = relevantRetryFlags(reason, integrityAckRequired);

  // Nested: keys and clicks never reach the task detail modal underneath.
  return (
    <DialogShell
      overlayClassName="workflow-retry-overlay"
      className="workflow-retry"
      labelledBy="workflow-retry-title"
      onClose={onCancel}
      nested
    >
      <h3 id="workflow-retry-title" className="workflow-retry__title">
        {t("retry.title")}
      </h3>
      {reason && <p className="workflow-retry__reason">{formatAttention(reason).text}</p>}
      <p className="workflow-retry__text">{t("retry.description")}</p>
      {integrityAckRequired && (
        <p className="workflow-retry__notice" role="alert">
          {formatCode("WORKFLOW_INTEGRITY_ACK_REQUIRED")}
        </p>
      )}
      {flags.map((flag) => (
        <div key={flag} className="workflow-retry__option">
          <label className="workflow-retry__toggle">
            <input
              type="checkbox"
              data-switch
              name={flag}
              checked={options[flag]}
              onChange={(e) => setOptions((o) => ({ ...o, [flag]: e.target.checked }))}
            />
            <span>{t(`retry.${flag}`)}</span>
          </label>
          <p className="workflow-retry__help" data-help={flag}>
            {t(`retry.${flag}Help`)}
          </p>
        </div>
      ))}
      <div className="workflow-retry__buttons">
        <button type="button" className="workflow-retry__cancel" onClick={onCancel}>
          {t("retry.cancel")}
        </button>
        <button type="button" className="workflow-retry__confirm" onClick={() => onConfirm(options)}>
          {t("retry.confirm")}
        </button>
      </div>
    </DialogShell>
  );
}

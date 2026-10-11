import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogShell } from "@/features/workflow/components/DialogShell";
import { isShowArtifacts, type ApprovalRequest, type FlowRunError } from "@/shared/types/flow-run";
import { toFlowRunError } from "../lib/flow-run-api";
import { describeError, describeReason } from "../lib/run-format";
import { ArtifactPreview } from "./ArtifactPreview";

interface ApprovalDialogProps {
  projectRoot: string;
  runId: string;
  request: ApprovalRequest;
  onClose(): void;
  /** Sends the decision; it rejects with a `FlowRunError`, which the dialog shows while staying open. */
  onChoose(choice: string, comment: string): Promise<void>;
}

/** Decides one pending approval: shows what to review, takes a comment and the choice. */
export function ApprovalDialog({ projectRoot, runId, request, onClose, onChoose }: ApprovalDialogProps) {
  const { t } = useTranslation("flow");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FlowRunError | null>(null);
  const commentMissing = comment.trim() === "";
  const blocked = commentMissing && request.options.some((option) => option.commentRequired);

  const choose = async (choice: string) => {
    setBusy(true);
    setError(null);
    try {
      await onChoose(choice, comment);
      onClose();
    } catch (err) {
      // The overlay hides the panel's error box, so the dialog shows the failure itself.
      setError(toFlowRunError(err) ?? { code: "FLOW_COMMAND_FAILED", message: String(err) });
      setBusy(false);
    }
  };

  return (
    <DialogShell overlayClassName="flow-dialog-overlay" className="flow-dialog flow-dialog--wide" labelledBy="flow-approval-title" onClose={onClose}>
      <h2 id="flow-approval-title" className="flow-dialog__title">
        {request.nodeKey ? `${t("run.approvals")}: ${request.nodeKey}` : t("run.budget")}
      </h2>
      {request.message ? <div>{request.message}</div> : <div className="flow-run__muted">{describeReason(t, request.reason)}</div>}
      {Object.entries(request.show ?? {}).map(([name, value]) => (
        <div key={name} className="flow-approval__show">
          <div className="flow-run__muted">{name}</div>
          {isShowArtifacts(value) ? (
            value.artifacts.map((artifact) => (
              <ArtifactPreview
                key={`${artifact.index}:${artifact.path}`}
                projectRoot={projectRoot}
                runId={runId}
                nodeKey={value.nodeKey}
                attempt={value.attempt}
                artifact={artifact}
              />
            ))
          ) : value === null || value === undefined ? (
            <span className="flow-run__muted">{t("run.noValue")}</span>
          ) : (
            <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>
          )}
        </div>
      ))}
      <textarea
        className="flow-dialog__input flow-approval__comment"
        placeholder={t("run.comment")}
        aria-label={t("run.comment")}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      {blocked && <div className="flow-run__muted">{t("run.commentRequired")}</div>}
      {error && (
        <div className="flow-dialog__error" role="alert">
          {describeError(t, error).message}
        </div>
      )}
      <div className="flow-run__actions">
        {request.options.map((option) => {
          const missing = !!option.commentRequired && commentMissing;
          return (
            <button
              key={option.name}
              type="button"
              disabled={busy || missing}
              title={missing ? t("run.commentRequired") : undefined}
              onClick={() => void choose(option.name)}
            >
              {/* Built-in options are localized; options named in the flow file are shown as written. */}
              {t(`run.option.${option.name}`, { defaultValue: option.name })}
            </button>
          );
        })}
      </div>
    </DialogShell>
  );
}

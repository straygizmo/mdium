import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { IntakeSessionView } from "@/shared/types/workflow";
import { formatCode } from "@/features/workflow/lib/format";
import { openExternal } from "@/features/workflow/lib/open-external";
import { showConfirm } from "@/stores/dialog-store";
import { ISSUE_TRACKING_UNAVAILABLE, turnRequestInFlight, useIntakeStore } from "../intake-store";
import { issueTarget } from "./IntakeStartForm";
import "./FinalizePanel.css";

/** Stages after which the drafts are the root task's attachments. */
const ATTACHED_STAGES = new Set(["attachments_committed", "task_created", "done"]);

/**
 * Finalizing a session with a proposal: the planned steps and the Finalize
 * button while in conversation; while finalizing, the stage reached, the
 * failure and exactly the next steps the backend allows; the result once
 * done. Nothing is shown for an abandoned session.
 */
export function FinalizePanel({ session }: { session: IntakeSessionView }) {
  const { t } = useTranslation("workflow");
  const workflows = useIntakeStore((s) => s.workflows);
  const forge = useIntakeStore((s) => s.forge);
  const drafts = useIntakeStore((s) => s.drafts);
  const action = useIntakeStore((s) => s.finalizeAction);
  const failure = useIntakeStore((s) => s.finalizeError);
  const turnInFlight = useIntakeStore(turnRequestInFlight);
  const finalize = useIntakeStore((s) => s.finalize);
  const reopen = useIntakeStore((s) => s.reopen);
  const abandon = useIntakeStore((s) => s.abandon);

  if (!session.proposal || session.status === "abandoned") return null;
  if (session.status === "done") return <FinalizeDone session={session} />;

  const f = session.finalize;
  const target = issueTarget(forge);
  const inFlight = action !== null;
  const finalizing = session.status === "finalizing";
  // A finalize is running (from this window or before it was reopened):
  // nothing can be done until it ends.
  const running = session.finalizeRunning;
  const showProgress = running || (finalizing && inFlight);
  // This window's latest failure, unless the session changed since. It is
  // newer than the recorded one, and some failures (e.g. a finalize already
  // in progress) are not recorded at all.
  const fresh = failure && failure.updatedAt === session.updatedAt ? failure : null;
  const errorCode = fresh ? fresh.code : finalizing ? f.lastError : null;
  // `ISSUE_TRACKING_UNAVAILABLE` implies tracking, even while the workflow
  // list does not contain the session's workflow.
  const tracksIssues =
    workflows.find((w) => w.id === session.workflowId)?.issueTracking === "auto" ||
    errorCode === ISSUE_TRACKING_UNAVAILABLE;

  // Why Issue tracking is unavailable, from the latest forge probe.
  const unavailableText =
    "reason" in target
      ? t("intake.finalize.issueUnavailable", { reason: t(`intake.start.forgeReason.${target.reason}`) })
      : formatCode(ISSUE_TRACKING_UNAVAILABLE);
  const errorText = (() => {
    if (errorCode === ISSUE_TRACKING_UNAVAILABLE) return unavailableText;
    if (errorCode) return formatCode(errorCode);
    // A failure without a code (e.g. the IPC call itself failed).
    return fresh?.text ?? null;
  })();

  // Skipping only makes sense while no Issue exists and it is not skipped yet.
  const canSkip = tracksIssues && !f.issue && !f.skipIssue;
  // Nothing has left the app yet: the conversation can resume or be dropped.
  const canStepBack = f.stage === "ready" && !f.issue && !f.issueCreating;

  const issueStep = f.issue
    ? t("intake.issue.link", { number: f.issue.number, host: f.issue.host, path: f.issue.path })
    : tracksIssues && !f.skipIssue
      ? "repo" in target
        ? t("intake.finalize.stepIssue", { host: target.repo.host, path: target.repo.path })
        : unavailableText
      : t("intake.finalize.stepNoIssue");
  const attachmentCount = ATTACHED_STAGES.has(f.stage) ? f.attachmentIds.length : drafts.length;
  const pendingDocs = session.docUpdates.some((d) => d.status === "pending");

  const skipIssue = async () => {
    if (inFlight) return;
    let text = t("intake.finalize.continueWithoutIssueConfirm");
    // An Issue created by an interrupted attempt would stay unlinked.
    if (f.issueCreating) text += `\n\n${t("intake.finalize.continueWithoutIssueCreatingConfirm")}`;
    if (!(await showConfirm(text, { kind: "warning" }))) return;
    await finalize(true);
  };

  const confirmAbandon = async () => {
    if (inFlight) return;
    if (!(await showConfirm(t("intake.finalize.abandonConfirm"), { kind: "warning" }))) return;
    await abandon();
  };

  const skipButton = (
    <button type="button" className="intake-finalize__skip" disabled={inFlight} onClick={() => void skipIssue()}>
      {t("intake.finalize.continueWithoutIssue")}
    </button>
  );

  return (
    <section className="intake-finalize" aria-label={t("intake.finalize.title")}>
      <h2 className="intake-finalize__title">{t("intake.finalize.title")}</h2>
      {!finalizing && <p className="intake-finalize__description">{t("intake.finalize.description")}</p>}
      {finalizing && (
        <p className="intake-finalize__stage">
          {t(`intake.finalize.stage.${f.stage}`)}
        </p>
      )}

      <div className="intake-finalize__plan">
        <span className="intake-finalize__steps-label">{t("intake.finalize.steps")}</span>
        <ol className="intake-finalize__steps">
          <li>{issueStep}</li>
          {attachmentCount > 0 && <li>{t("intake.finalize.stepAttachments", { count: attachmentCount })}</li>}
          <li>{t("intake.finalize.stepTask")}</li>
        </ol>
      </div>

      {!finalizing && pendingDocs && (
        <p className="intake-finalize__note" role="note">
          {t("intake.finalize.pendingDocs")}
        </p>
      )}

      {showProgress && (
        <p className="intake-finalize__progress" role="status">
          {t("intake.finalize.finalizing")}
        </p>
      )}
      {finalizing && !showProgress && <p className="intake-finalize__failed">{t("intake.finalize.failed")}</p>}
      {errorText && !showProgress && (
        <p className="intake-finalize__error" role="alert">
          {errorText}
        </p>
      )}
      {finalizing && f.issueCreating && <p className="intake-finalize__note">{t("intake.finalize.issueCreating")}</p>}

      {!running && (
        <div className="intake-finalize__buttons">
          {finalizing ? (
            <>
              <button
                type="button"
                className="intake-finalize__retry"
                disabled={inFlight}
                onClick={() => void finalize(false)}
              >
                {t("intake.finalize.retry")}
              </button>
              {canSkip && skipButton}
              {canStepBack && (
                <>
                  <button
                    type="button"
                    className="intake-finalize__reopen"
                    disabled={inFlight}
                    onClick={() => void reopen()}
                  >
                    {t("intake.finalize.reopen")}
                  </button>
                  <button
                    type="button"
                    className="intake-finalize__abandon"
                    disabled={inFlight}
                    onClick={() => void confirmAbandon()}
                  >
                    {t("intake.finalize.abandon")}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                className="intake-finalize__submit"
                disabled={inFlight || session.busy || turnInFlight}
                onClick={() => void finalize(false)}
              >
                {action === "finalize" || action === "skipIssue"
                  ? t("intake.finalize.finalizing")
                  : t("intake.finalize.finalize")}
              </button>
              {/* Tracking turned out unavailable before finalizing started. */}
              {errorCode === ISSUE_TRACKING_UNAVAILABLE && canSkip && skipButton}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** The finished intake: the Issue link and "Open task". */
function FinalizeDone({ session }: { session: IntakeSessionView }) {
  const { t } = useTranslation("workflow");
  const openTask = useIntakeStore((s) => s.openTask);
  const unhandled = useIntakeStore((s) => s.openTaskUnhandled);
  const [opening, setOpening] = useState(false);
  const { issue, rootTaskId } = session.finalize;

  const onOpenTask = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await openTask();
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="intake-finalize intake-finalize--done" aria-label={t("intake.finalize.title")}>
      <h2 className="intake-finalize__title">{t("intake.finalize.title")}</h2>
      <p className="intake-finalize__done" role="status">
        {t("intake.finalize.done")}
      </p>
      {issue && (
        <button type="button" className="intake-finalize__issue-link" onClick={() => void openExternal(issue.url, "workflow:intake.issue.openFailed")}>
          {t("intake.issue.link", { number: issue.number, host: issue.host, path: issue.path })}
        </button>
      )}
      {rootTaskId && (
        <div className="intake-finalize__buttons">
          <button
            type="button"
            className="intake-finalize__open-task"
            disabled={opening}
            onClick={() => void onOpenTask()}
          >
            {t("intake.finalize.openTask")}
          </button>
        </div>
      )}
      {unhandled && (
        <p className="intake-finalize__unhandled" role="alert">
          {t("intake.finalize.openTaskUnhandled")}
        </p>
      )}
    </section>
  );
}

/** Abandons a session still in conversation, after confirmation. */
export function AbandonIntakeButton() {
  const { t } = useTranslation("workflow");
  const status = useIntakeStore((s) => s.session?.status);
  const running = useIntakeStore((s) => s.session?.finalizeRunning ?? false);
  const inFlight = useIntakeStore((s) => s.finalizeAction !== null);
  const abandon = useIntakeStore((s) => s.abandon);

  // Also offered while the agent replies (the backend cancels the turn), but
  // not while a finalize runs (the backend refuses it).
  if (status !== "active" || running) return null;

  const onClick = async () => {
    if (inFlight) return;
    if (!(await showConfirm(t("intake.conversation.abandonConfirm"), { kind: "warning" }))) return;
    await abandon();
  };

  return (
    <button type="button" className="intake-abandon" disabled={inFlight} onClick={() => void onClick()}>
      {t("intake.conversation.abandon")}
    </button>
  );
}

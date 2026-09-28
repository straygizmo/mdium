import { type MouseEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IssueRef, WorkflowRun } from "@/shared/types/workflow";
import { formatCode } from "../lib/format";
import { workflowApi } from "../lib/workflow-api";
import { useWorkflowStore } from "../workflow-store";
import { externalUrl, openExternal } from "../lib/open-external";
import "./IssueSection.css";

interface IssueSectionProps {
  issue: IssueRef;
  /** The run tracked by the Issue, if any (for its closed state and retrying the close). */
  run: WorkflowRun | null;
  /** Rendered as a section of its own (a task without a run) instead of inside the run section. */
  standalone?: boolean;
}

/**
 * The forge Issue of a task or run: a link opened in the external browser,
 * the closed state of a run's Issue and, for merged runs whose Issue could
 * not be closed, the retry.
 */
export function IssueSection({ issue, run, standalone = false }: IssueSectionProps) {
  const { t } = useTranslation("workflow");
  const [busy, setBusy] = useState(false);
  // Only http/https URLs become a link; anything else is shown as text.
  const url = externalUrl(issue.url);

  const onOpen = (e: MouseEvent<HTMLAnchorElement>) => {
    // Never navigate the app: the link opens in the external browser.
    e.preventDefault();
    if (url) void openExternal(url, "workflow:intake.issue.openFailed");
  };
  const label = t("intake.issue.link", { number: issue.number, host: issue.host, path: issue.path });

  const canRetryClose = run !== null && run.status === "merged" && run.issue !== null && !run.issueClosed;

  const onRetryClose = async () => {
    if (!run || busy) return;
    setBusy(true);
    try {
      await useWorkflowStore
        .getState()
        .run(t("intake.issue.retryCloseFailed"), (root) => workflowApi.retryIssueClose(root, run.rootTaskId));
    } finally {
      setBusy(false);
    }
  };

  const Container = standalone ? "section" : "div";
  return (
    <Container
      className={standalone ? "workflow-detail__section workflow-issue workflow-issue--standalone" : "workflow-issue"}
      data-section="issue"
    >
      {standalone ? (
        <h3 className="workflow-detail__heading">{t("intake.issue.title")}</h3>
      ) : (
        <h4 className="workflow-issue__heading">{t("intake.issue.title")}</h4>
      )}
      <p className="workflow-issue__row">
        {url ? (
          <a
            className="workflow-issue__link"
            href={url}
            title={t("intake.issue.openLink")}
            onClick={onOpen}
            onAuxClick={(e) => e.preventDefault()}
          >
            {label}
          </a>
        ) : (
          <span className="workflow-issue__text">{label}</span>
        )}
        {run && (
          <span className="workflow-issue__state">
            {t(run.issueClosed ? "intake.issue.closed" : "intake.issue.stateOpen")}
          </span>
        )}
      </p>
      {canRetryClose && (
        <>
          {run.issueCloseError && (
            <p className="workflow-issue__error" role="alert">
              {t("intake.issue.closeFailed", { error: formatCode(run.issueCloseError) })}
            </p>
          )}
          <div>
            <button
              type="button"
              className="workflow-issue__btn"
              data-action="retryIssueClose"
              disabled={busy}
              onClick={() => void onRetryClose()}
            >
              {t("intake.issue.retryClose")}
            </button>
          </div>
        </>
      )}
    </Container>
  );
}

import { type MouseEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { IssueRef, WorkflowRun } from "@/shared/types/workflow";
import { formatCode } from "../lib/format";
import { workflowApi } from "../lib/workflow-api";
import { useWorkflowStore } from "../workflow-store";
import { externalUrl } from "./SafeMarkdown";
import "./IssueSection.css";

interface IssueSectionProps {
  issue: IssueRef;
  /** The run tracked by the Issue, if any (for its closed state and retrying the close). */
  run: WorkflowRun | null;
}

/**
 * The forge Issue of a task or run: a link opened in the external browser,
 * the closed state of a run's Issue and, for merged runs whose Issue could
 * not be closed, the retry.
 */
export function IssueSection({ issue, run }: IssueSectionProps) {
  const { t } = useTranslation("workflow");
  const [busy, setBusy] = useState(false);

  const onOpen = (e: MouseEvent<HTMLAnchorElement>) => {
    // Never navigate the app; only http/https URLs are opened externally.
    e.preventDefault();
    const url = externalUrl(issue.url);
    if (!url) return;
    invoke("open_external_url", { url }).catch((err: unknown) => console.warn("[workflow] open Issue failed", err));
  };

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

  return (
    <div className="workflow-issue" data-section="issue">
      <h4 className="workflow-issue__heading">{t("intake.issue.title")}</h4>
      <p className="workflow-issue__row">
        <a
          className="workflow-issue__link"
          href={issue.url}
          title={t("intake.issue.openLink")}
          onClick={onOpen}
          onAuxClick={(e) => e.preventDefault()}
        >
          {t("intake.issue.link", { number: issue.number, host: issue.host, path: issue.path })}
        </a>
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
    </div>
  );
}

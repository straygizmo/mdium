import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UnifiedDiffView } from "@/shared/components/UnifiedDiffView";
import type { MergePreview, WorkflowRun } from "@/shared/types/workflow";
import { showConfirm, showMessage } from "@/stores/dialog-store";
import { isCommandError } from "../lib/errors";
import { formatCode, formatCommandError } from "../lib/format";
import { workflowApi } from "../lib/workflow-api";
import { useWorkflowStore } from "../workflow-store";
import "./MergeSection.css";

/** Lines of the branch diff rendered in the preview; the rest is cut off with a note. */
const MAX_DIFF_LINES = 5000;

/** Refusals after which the preview no longer matches the repository. */
const STALE_PREVIEW_CODES: ReadonlySet<string> = new Set([
  "WORKFLOW_MERGE_REVIEW_CHANGED",
  "WORKFLOW_MERGE_INTEGRITY_CHANGED",
]);

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/**
 * Merge and discard operations of a run: the merge preview and the local
 * merge for runs awaiting a merge, and removing the worktree of cancelled or
 * merged runs. Renders nothing for runs without such an operation.
 */
export function MergeSection({ run }: { run: WorkflowRun }) {
  const { t } = useTranslation("workflow");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [integrityAck, setIntegrityAck] = useState(false);
  const [mergedHere, setMergedHere] = useState(false);
  const { rootTaskId, status, worktree } = run;

  const awaitingMerge = status === "awaiting_merge";
  const canDiscard = (status === "cancelled" || status === "merged") && worktree !== null;
  if (!awaitingMerge && !canDiscard && !mergedHere) return null;

  const withBusy = async <T,>(fn: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  };

  const loadPreview = async () => {
    const root = useWorkflowStore.getState().activeRoot;
    if (!root) return;
    try {
      const next = await workflowApi.mergePreview(root, rootTaskId);
      setPreview(next);
      setTicked(new Set());
      setIntegrityAck(false);
    } catch (err) {
      setPreview(null);
      void showMessage(formatCommandError(err), { title: t("merge.previewFailed"), kind: "error" });
    }
  };

  /** Runs `workflow_merge_run` through the store; a refusal against a stale preview reloads it. */
  const merge = async (paths: string[]) => {
    let stale = false;
    const merged = await useWorkflowStore.getState().run(t("merge.failed"), async (root) => {
      try {
        return await workflowApi.mergeRun(root, rootTaskId, paths, false);
      } catch (err) {
        if (isCommandError(err) && STALE_PREVIEW_CODES.has(err.code)) stale = true;
        throw err;
      }
    });
    if (merged) {
      setPreview(null);
      setMergedHere(true);
      return;
    }
    if (stale) await loadPreview();
  };

  const onMerge = async (target: MergePreview) => {
    const confirmed = await showConfirm(
      t("merge.mergeConfirm", { branch: target.branch, baseBranch: target.baseBranch }),
      { kind: "warning" },
    );
    if (confirmed) await withBusy(() => merge(target.reviewPaths));
  };

  const onRecheck = async () => {
    if (!(await showConfirm(t("merge.recheckConfirm"), { kind: "warning" }))) return;
    await withBusy(async () => {
      // Only stores a new integrity baseline; the merge is a separate step.
      const acknowledged = await useWorkflowStore
        .getState()
        .run(t("merge.failed"), (root) => workflowApi.acknowledgeIntegrity(root, rootTaskId));
      if (acknowledged) await loadPreview();
    });
  };

  const onDiscard = async () => {
    if (!worktree) return;
    const text =
      status === "merged"
        ? t("merge.removeWorktreeConfirm", { branch: worktree.branch, baseBranch: worktree.baseBranch })
        : t("merge.discardConfirm", { branch: worktree.branch });
    if (!(await showConfirm(text, { kind: "warning" }))) return;
    await withBusy(() =>
      useWorkflowStore.getState().run(t("merge.discardFailed"), (root) => workflowApi.discardRun(root, rootTaskId)),
    );
  };

  const toggle = (path: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });

  const shown = awaitingMerge ? preview : null;
  const needsIntegrityAck = shown !== null && shown.integrityChanges.length > 0;
  const allTicked = shown !== null && shown.reviewPaths.every((path) => ticked.has(path));

  return (
    <div className="workflow-merge" data-section="merge">
      <h4 className="workflow-merge__heading">{t("merge.label")}</h4>
      {mergedHere && (
        <p className="workflow-merge__done" role="status">
          {t("merge.done")}
        </p>
      )}

      {shown && (
        <>
          <dl className="workflow-merge__facts">
            <dt>{t("merge.branch")}</dt>
            <dd>{shown.branch}</dd>
            <dt>{t("merge.baseBranch")}</dt>
            <dd>{shown.baseBranch}</dd>
            <dt>{t("merge.baseCommit")}</dt>
            <dd className="workflow-merge__hash">{shortHash(shown.baseCommit)}</dd>
          </dl>

          {needsIntegrityAck ? (
            <div className="workflow-merge__block" data-block="integrity">
              <h5 className="workflow-merge__subheading">{t("merge.integrity")}</h5>
              <p className="workflow-merge__help">{t("merge.integrityHelp")}</p>
              <ul className="workflow-merge__list">
                {shown.integrityChanges.map((change, i) => (
                  <li key={i}>
                    {formatCode(change.code)}
                    {change.detail && `: ${change.detail}`}
                  </li>
                ))}
              </ul>
              <label className="workflow-merge__toggle">
                <input
                  type="checkbox"
                  data-switch
                  name="acknowledgeIntegrity"
                  checked={integrityAck}
                  onChange={(e) => setIntegrityAck(e.target.checked)}
                />
                <span>{t("merge.acknowledgeIntegrity")}</span>
              </label>
            </div>
          ) : (
            <>
              <div className="workflow-merge__block" data-block="commits">
                <h5 className="workflow-merge__subheading">{t("merge.commits")}</h5>
                {shown.commits.length === 0 ? (
                  <p className="workflow-merge__muted">{t("merge.noCommits")}</p>
                ) : (
                  <ul className="workflow-merge__list">
                    {shown.commits.map((commit) => (
                      <li key={commit.hash}>
                        <span className="workflow-merge__hash">{shortHash(commit.hash)}</span> {commit.subject}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="workflow-merge__block" data-block="diff">
                <h5 className="workflow-merge__subheading">{t("merge.diff")}</h5>
                {shown.diff ? (
                  <UnifiedDiffView diff={shown.diff} maxLines={MAX_DIFF_LINES} />
                ) : (
                  <p className="workflow-merge__muted">{t("merge.noDiff")}</p>
                )}
              </div>

              {shown.reviewPaths.length > 0 && (
                <div className="workflow-merge__block" data-block="review">
                  <h5 className="workflow-merge__subheading">{t("merge.reviewPaths")}</h5>
                  <p className="workflow-merge__help">{t("merge.reviewHelp")}</p>
                  {shown.reviewPaths.map((path) => (
                    <label key={path} className="workflow-merge__toggle">
                      <input
                        type="checkbox"
                        data-switch
                        data-review-path={path}
                        checked={ticked.has(path)}
                        onChange={(e) => toggle(path, e.target.checked)}
                      />
                      <span className="workflow-merge__path">{path}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      <div className="workflow-merge__buttons">
        {awaitingMerge && (
          <button
            type="button"
            className="workflow-merge__btn"
            data-action="preview"
            disabled={busy}
            onClick={() => void withBusy(loadPreview)}
          >
            {t(shown ? "merge.reloadPreview" : "merge.preview")}
          </button>
        )}
        {shown && needsIntegrityAck && (
          <button
            type="button"
            className="workflow-merge__btn workflow-merge__btn--primary"
            data-action="recheck"
            disabled={busy || !integrityAck}
            onClick={() => void onRecheck()}
          >
            {t("merge.recheck")}
          </button>
        )}
        {shown && !needsIntegrityAck && (
          <button
            type="button"
            className="workflow-merge__btn workflow-merge__btn--primary"
            data-action="merge"
            disabled={busy || !allTicked}
            onClick={() => void onMerge(shown)}
          >
            {t("merge.merge")}
          </button>
        )}
        {canDiscard && (
          <button
            type="button"
            className="workflow-merge__btn workflow-merge__btn--danger"
            data-action={status === "merged" ? "removeWorktree" : "discard"}
            disabled={busy}
            onClick={() => void onDiscard()}
          >
            {t(status === "merged" ? "merge.removeWorktree" : "merge.discard")}
          </button>
        )}
      </div>
    </div>
  );
}

import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AttemptRecord, HistoryEntry, Task, TaskDetail, WorkflowRun } from "@/shared/types/workflow";
import { formatAttention, formatCommandError } from "../lib/format";
import { workflowApi } from "../lib/workflow-api";
import { useWorkflowStore } from "../workflow-store";
import { DialogShell } from "./DialogShell";
import { MergeSection } from "./MergeSection";
import { SafeMarkdown } from "./SafeMarkdown";
import { TaskActions } from "./TaskActions";
import { statusBackground } from "./TaskCard";
import "./TaskDetailModal.css";

/** Longest Markdown text (in characters) rendered in the modal; the rest is cut off. */
export const MAX_MARKDOWN_CHARS = 200 * 1024;

type Loaded = { taskId: string; detail: TaskDetail } | { taskId: string; error: string };

function time(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

function stageName(run: WorkflowRun | null, stageId: string | null): string {
  if (!stageId) return "";
  return run?.workflow.stages.find((s) => s.id === stageId)?.name ?? stageId;
}

/** "from <stage> to <stage>" of the run's latest stage transition, derived from its tasks. */
function latestTransition(run: WorkflowRun, tasks: Task[]): { from: string; to: string } | null {
  const runTasks = tasks.filter((task) => task.meta.rootId === run.rootTaskId);
  const children = runTasks
    .filter((task) => task.meta.parentId !== null)
    .sort((a, b) => time(b.meta.createdAt) - time(a.meta.createdAt));
  const child = children[0];
  if (!child) return null;
  const parent = runTasks.find((task) => task.meta.id === child.meta.parentId);
  if (!parent) return null;
  return { from: stageName(run, parent.meta.stageId), to: stageName(run, child.meta.stageId) };
}

function Markdown({ source, className }: { source: string; className: string }) {
  const { t } = useTranslation("workflow");
  const truncated = source.length > MAX_MARKDOWN_CHARS;
  const text = useMemo(() => (truncated ? source.slice(0, MAX_MARKDOWN_CHARS) : source), [source, truncated]);
  return (
    <>
      {/* Untrusted Markdown: only ever rendered through the sanitizing renderer. */}
      <SafeMarkdown source={text} className={className} />
      {truncated && (
        <p className="workflow-detail__truncated">{t("detail.truncated", { size: MAX_MARKDOWN_CHARS / 1024 })}</p>
      )}
    </>
  );
}

/**
 * Detail view of the selected task with its operations. Reloads the detail
 * whenever the store's copy of the task or its run changes (event-driven
 * refreshes and refreshes after actions).
 */
export function TaskDetailModal() {
  const { t, i18n } = useTranslation("workflow");
  const taskId = useWorkflowStore((s) => s.selectedTaskId);
  const activeRoot = useWorkflowStore((s) => s.activeRoot);
  const project = useWorkflowStore((s) => (s.activeRoot ? s.projects[s.activeRoot] : undefined));
  const openTask = useWorkflowStore((s) => s.openTask);
  const progress = useWorkflowStore((s) =>
    s.activeRoot && s.selectedTaskId ? s.projects[s.activeRoot]?.progress[s.selectedTaskId] : undefined,
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const tasks = project?.tasks;
  const storeTask = taskId ? tasks?.find((task) => task.meta.id === taskId) : undefined;
  const storeRun = storeTask ? project?.runs.find((r) => r.rootTaskId === storeTask.meta.rootId) : undefined;
  // Changes whenever the task or its run is refreshed with new content.
  const version = `${storeTask?.meta.updatedAt ?? ""}|${storeRun?.updatedAt ?? ""}`;

  useEffect(() => {
    if (!taskId || !activeRoot) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const detail = await workflowApi.taskDetail(activeRoot, taskId);
        if (!cancelled) setLoaded({ taskId, detail });
      } catch (err) {
        if (!cancelled) setLoaded({ taskId, error: formatCommandError(err) });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [taskId, activeRoot, version]);

  const hasDetail = loaded?.taskId === taskId && loaded !== null && "detail" in loaded;
  const storeLoaded = project?.loaded ?? false;
  useEffect(() => {
    // The task was deleted (or is no longer listed) after it had been shown.
    if (taskId && hasDetail && storeLoaded && !storeTask) openTask(null);
  }, [taskId, hasDetail, storeLoaded, storeTask, openTask]);

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }),
    [i18n.language],
  );

  if (!taskId) return null;

  const close = () => openTask(null);
  const onEscape = (e: KeyboardEvent, dialog: HTMLElement | null) => {
    const target = e.target;
    if (target instanceof HTMLTextAreaElement && target.value !== "") {
      // Keep typed text: the first Escape only leaves the text field.
      dialog?.focus();
      return;
    }
    close();
  };
  const formatDate = (iso: string | null) => (iso ? (time(iso) ? dateFormat.format(time(iso)) : iso) : "");

  const current = loaded?.taskId === taskId ? loaded : null;
  const detail = current && "detail" in current ? current.detail : null;
  const task = detail?.task ?? storeTask ?? null;

  let content;
  if (current && "error" in current) {
    content = (
      <p className="workflow-detail__error" role="alert">
        {t("detail.loadFailed")}
        <br />
        {current.error}
      </p>
    );
  } else if (!detail || !task) {
    content = <p className="workflow-detail__message">{t("loading")}</p>;
  } else {
    content = <DetailSections detail={detail} tasks={tasks ?? []} formatDate={formatDate} />;
  }

  return (
    <DialogShell
      overlayClassName="workflow-detail-overlay"
      className="workflow-detail"
      labelledBy="workflow-detail-title"
      onClose={close}
      onEscape={onEscape}
    >
      <header className="workflow-detail__header">
        <h2 id="workflow-detail-title" className="workflow-detail__title">
          {task?.meta.title ?? ""}
        </h2>
        {task && (
          <span className="workflow-detail__status" style={{ background: statusBackground(task.meta.status) }}>
            {t(`status.${task.meta.status}`)}
          </span>
        )}
        <button type="button" className="workflow-detail__close" aria-label={t("detail.close")} title={t("detail.close")} onClick={close}>
          ×
        </button>
      </header>
      {progress && (storeTask ?? task)?.meta.status === "running" && (
        <p className="workflow-detail__progress" data-section="progress" aria-live="polite">
          <span className="workflow-detail__progress-label">{t("detail.progress")}</span>
          <span className="workflow-detail__progress-text" title={progress.text}>
            {progress.text}
          </span>
        </p>
      )}
      <div className="workflow-detail__content">{content}</div>
      {detail && <TaskActions key={detail.task.meta.id} task={detail.task} />}
    </DialogShell>
  );
}

interface DetailSectionsProps {
  detail: TaskDetail;
  /** All tasks of the project (for the run's stage transitions). */
  tasks: Task[];
  formatDate(iso: string | null): string;
}

function DetailSections({ detail, tasks, formatDate }: DetailSectionsProps) {
  const { t } = useTranslation("workflow");
  const { task, run, latestOutput, logTail } = detail;
  const { meta } = task;

  const attempts = useMemo(
    () =>
      (run?.attempts ?? [])
        .filter((a) => a.taskId === meta.id)
        .sort((a, b) => time(b.startedAt) - time(a.startedAt)),
    [run, meta.id],
  );
  const latestFinished: AttemptRecord | undefined = attempts.find((a) => a.outcome !== null);
  const attention = meta.status === "attention" && meta.attention ? formatAttention(meta.attention) : null;
  const transition = run ? latestTransition(run, tasks) : null;
  const currentTask = run ? tasks.find((task) => task.meta.id === run.currentTaskId) : undefined;

  const statusText = (entry: HistoryEntry) =>
    entry.from ? `${t(`status.${entry.from}`)} → ${t(`status.${entry.to}`)}` : `${t("detail.created")}: ${t(`status.${entry.to}`)}`;

  return (
    <>
      {attention && (
        <section className="workflow-detail__section workflow-detail__attention" data-section="attention">
          <h3 className="workflow-detail__heading">{t("detail.attention")}</h3>
          <p>{attention.text}</p>
          {attention.items.length > 0 && (
            <ul className="workflow-detail__items">
              {attention.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {meta.status === "awaiting_user" && meta.awaiting && (
        <section className="workflow-detail__section" data-section="awaiting">
          <h3 className="workflow-detail__heading">{t("detail.awaiting")}</h3>
          {meta.awaiting.kind === "question" ? (
            <>
              <p>{t("detail.question")}</p>
              <p className="workflow-detail__question">{meta.awaiting.question ?? ""}</p>
            </>
          ) : (
            <p>{t("detail.planApproval")}</p>
          )}
        </section>
      )}

      <section className="workflow-detail__section" data-section="body">
        <h3 className="workflow-detail__heading">{t("detail.body")}</h3>
        {task.body.trim() ? (
          <Markdown source={task.body} className="workflow-detail__markdown" />
        ) : (
          <p className="workflow-detail__muted">{t("detail.emptyBody")}</p>
        )}
      </section>

      {latestOutput !== null && (
        <details
          className="workflow-detail__section"
          data-section="output"
          open={latestOutput.length <= MAX_MARKDOWN_CHARS}
        >
          <summary className="workflow-detail__heading">
            {t("detail.latestOutput")}
            {latestFinished && (
              <span className="workflow-detail__labels">
                <span className="workflow-detail__label">
                  {t(`mode.${latestFinished.mode}`, { defaultValue: latestFinished.mode })}
                </span>
                {latestFinished.outcome && (
                  <span className="workflow-detail__label">
                    {t(`outcome.${latestFinished.outcome}`, { defaultValue: latestFinished.outcome })}
                  </span>
                )}
              </span>
            )}
          </summary>
          <Markdown source={latestOutput} className="workflow-detail__markdown" />
        </details>
      )}

      <section className="workflow-detail__section" data-section="attempts">
        <h3 className="workflow-detail__heading">{t("detail.attempts")}</h3>
        {attempts.length === 0 ? (
          <p className="workflow-detail__muted">{t("detail.noAttempts")}</p>
        ) : (
          <table className="workflow-detail__table">
            <thead>
              <tr>
                <th>{t("detail.started")}</th>
                <th>{t("detail.finished")}</th>
                <th>{t("detail.mode")}</th>
                <th>{t("detail.outcome")}</th>
                <th>{t("detail.stage")}</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.attemptId}>
                  <td>{formatDate(a.startedAt)}</td>
                  <td>{a.finishedAt ? formatDate(a.finishedAt) : t("detail.inProgress")}</td>
                  <td>{t(`mode.${a.mode}`, { defaultValue: a.mode })}</td>
                  <td>{a.outcome ? t(`outcome.${a.outcome}`, { defaultValue: a.outcome }) : ""}</td>
                  <td>{stageName(run, a.stageId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {meta.history.length > 0 && (
        <section className="workflow-detail__section" data-section="history">
          <h3 className="workflow-detail__heading">{t("detail.history")}</h3>
          <ul className="workflow-detail__history">
            {meta.history.map((entry, i) => (
              <li key={i}>
                <span className="workflow-detail__muted">{formatDate(entry.at)}</span> {statusText(entry)}
                {entry.reason && <span className="workflow-detail__reason">{formatAttention(entry.reason).text}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {run && (
        <section className="workflow-detail__section" data-section="run">
          <h3 className="workflow-detail__heading">{t("detail.run")}</h3>
          <dl className="workflow-detail__facts">
            <dt>{t("detail.runStatus")}</dt>
            <dd>{t(`runStatus.${run.status}`, { defaultValue: run.status })}</dd>
            <dt>{t("detail.reentry")}</dt>
            <dd>{t("detail.reentryValue", { count: run.reentryCount, max: run.workflow.maxReentryCount })}</dd>
            {run.worktree && (
              <>
                <dt>{t("detail.branch")}</dt>
                <dd>{run.worktree.branch}</dd>
                <dt>{t("detail.baseBranch")}</dt>
                <dd>{run.worktree.baseBranch}</dd>
              </>
            )}
            {currentTask?.meta.stageId && (
              <>
                <dt>{t("detail.currentStage")}</dt>
                <dd>{stageName(run, currentTask.meta.stageId)}</dd>
              </>
            )}
            {transition && (
              <>
                <dt>{t("detail.transition")}</dt>
                <dd>{t("detail.transitionValue", transition)}</dd>
              </>
            )}
          </dl>
          <MergeSection run={run} />
        </section>
      )}

      <details className="workflow-detail__section" data-section="log">
        <summary className="workflow-detail__heading">{t("detail.log")}</summary>
        {logTail.length > 0 ? (
          <pre className="workflow-detail__log">{logTail.join("\n")}</pre>
        ) : (
          <p className="workflow-detail__muted">{t("detail.noLog")}</p>
        )}
      </details>
    </>
  );
}

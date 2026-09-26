import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskStatus, WorkflowRun } from "@/shared/types/workflow";
import { type TaskProgress, useWorkflowStore } from "../workflow-store";
import { KanbanBoard } from "./KanbanBoard";
import { MatrixView } from "./MatrixView";
import "./Workspace.css";

/** Board columns in display order; `cancelled` is appended when shown. */
const STATUSES: readonly TaskStatus[] = ["inbox", "running", "awaiting_user", "attention", "on_hold", "completed"];
const STATUSES_WITH_CANCELLED: readonly TaskStatus[] = [...STATUSES, "cancelled"];

/** Waiting statuses whose task keeps its run's concurrency slot. */
const SLOT_HOLDING: ReadonlySet<TaskStatus> = new Set(["attention", "awaiting_user"]);

const NO_TASKS: Task[] = [];
const NO_RUNS: WorkflowRun[] = [];
const NO_PROGRESS: Record<string, TaskProgress> = {};

/** Last segment of a project root (`C:\work\app` -> `app`). */
function projectName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

function updatedTime(task: Task): number {
  const time = Date.parse(task.meta.updatedAt);
  return Number.isNaN(time) ? 0 : time;
}

/** Main-area workspace of the workflows panel: the task board of the active project. */
export function Workspace() {
  const { t, i18n } = useTranslation("workflow");
  const activeRoot = useWorkflowStore((s) => s.activeRoot);
  const attachError = useWorkflowStore((s) => s.attachError);
  const project = useWorkflowStore((s) => (s.activeRoot ? s.projects[s.activeRoot] : undefined));
  const filters = useWorkflowStore((s) => s.filters);
  const setFilters = useWorkflowStore((s) => s.setFilters);
  const openTask = useWorkflowStore((s) => s.openTask);

  const tasks = project?.tasks ?? NO_TASKS;
  const runs = project?.runs ?? NO_RUNS;
  const progress = project?.progress ?? NO_PROGRESS;
  const { workflowId, showArchived, showCancelled, view } = filters;

  const visible = useMemo(
    () =>
      tasks
        .filter(
          (task) =>
            (workflowId === null || task.meta.workflowId === workflowId) &&
            (showArchived || !task.meta.archived) &&
            (showCancelled || task.meta.status !== "cancelled"),
        )
        .sort((a, b) => updatedTime(b) - updatedTime(a)),
    [tasks, workflowId, showArchived, showCancelled],
  );

  const slotHolders = useMemo(() => {
    // An active run holds one slot; it is shown on the run's current task while that task waits.
    const currentTasks = new Set(runs.filter((r) => r.status === "active").map((r) => r.currentTaskId));
    return new Set(
      tasks
        .filter((task) => SLOT_HOLDING.has(task.meta.status) && currentTasks.has(task.meta.id))
        .map((task) => task.meta.id),
    );
  }, [tasks, runs]);

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }),
    [i18n.language],
  );

  const statuses = showCancelled ? STATUSES_WITH_CANCELLED : STATUSES;
  const Board = view === "matrix" ? MatrixView : KanbanBoard;

  let content: ReactNode;
  if (attachError) {
    content = (
      <p className="workflow-workspace__error" role="alert">
        {attachError}
      </p>
    );
  } else if (!project?.loaded) {
    content = project?.error ? (
      <p className="workflow-workspace__error" role="alert">
        {project.error}
      </p>
    ) : (
      <p className="workflow-workspace__message">{t("loading")}</p>
    );
  } else if (visible.length === 0) {
    content = <p className="workflow-workspace__message">{t("emptyBoard")}</p>;
  } else {
    content = (
      <Board
        tasks={visible}
        statuses={statuses}
        progress={progress}
        slotHolders={slotHolders}
        dateFormat={dateFormat}
        onOpen={openTask}
      />
    );
  }

  return (
    <div className="workflow-workspace">
      <header className="workflow-workspace__header">
        <h2 className="workflow-workspace__title" title={activeRoot ?? undefined}>
          {activeRoot ? projectName(activeRoot) : t("title")}
        </h2>
        <div className="workflow-workspace__view" role="group" aria-label={t("panel.view")}>
          {(["kanban", "matrix"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`workflow-workspace__view-btn${view === v ? " workflow-workspace__view-btn--active" : ""}`}
              aria-pressed={view === v}
              onClick={() => setFilters({ view: v })}
            >
              {t(v === "kanban" ? "panel.viewKanban" : "panel.viewMatrix")}
            </button>
          ))}
        </div>
      </header>
      {content}
    </div>
  );
}

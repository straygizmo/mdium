import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@/shared/types/workflow";
import { formatAttention } from "../lib/format";
import "./TaskCard.css";

interface TaskCardProps {
  task: Task;
  /** Latest progress line; shown only for running tasks. */
  progress?: string;
  /** Whether the task's active run keeps its concurrency slot while it waits. */
  holdsSlot: boolean;
  /** Shared formatter of the update time (created once per board render). */
  dateFormat: Intl.DateTimeFormat;
  /** Renders the title only (matrix cells). */
  compact?: boolean;
  onOpen(taskId: string): void;
}

/** What the kanban board and the matrix view need to render cards. */
export interface BoardProps {
  /** Visible tasks, newest first. */
  tasks: Task[];
  /** Board columns, in display order. */
  statuses: readonly Task["meta"]["status"][];
  /** Latest progress line per task id. */
  progress: Record<string, { text: string }>;
  /** Ids of the tasks that hold a concurrency slot while waiting. */
  slotHolders: ReadonlySet<string>;
  dateFormat: Intl.DateTimeFormat;
  onOpen(taskId: string): void;
}

/** CSS variable holding the background of a task status (`on_hold` -> `on-hold`). */
export function statusBackground(status: Task["meta"]["status"]): string {
  return `var(--task-status-${status.replace(/_/g, "-")}-background)`;
}

function formatDate(format: Intl.DateTimeFormat, iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : format.format(time);
}

/**
 * One task on the board. Only plain text is rendered (never Markdown), so
 * hundreds of cards stay cheap to render.
 */
export const TaskCard = memo(function TaskCard({
  task,
  progress,
  holdsSlot,
  dateFormat,
  compact = false,
  onOpen,
}: TaskCardProps) {
  const { t } = useTranslation("workflow");
  const { meta } = task;
  const className = `workflow-card${compact ? " workflow-card--compact" : ""}`;
  const style = { background: statusBackground(meta.status) };

  if (compact) {
    return (
      <button
        type="button"
        className={className}
        style={style}
        data-task-id={meta.id}
        title={meta.title}
        onClick={() => onOpen(meta.id)}
      >
        <span className="workflow-card__title">{meta.title}</span>
      </button>
    );
  }

  const updated = formatDate(dateFormat, meta.updatedAt);

  return (
    <button type="button" className={className} style={style} data-task-id={meta.id} onClick={() => onOpen(meta.id)}>
      <span className="workflow-card__head">
        <span className="workflow-card__title">{meta.title}</span>
        {holdsSlot && (
          <span className="workflow-card__slot" title={t("workspace.holdsSlot")}>
            {t("workspace.slot")}
          </span>
        )}
      </span>
      <span className="workflow-card__meta">
        {meta.role && <span className="workflow-card__role">{t(`role.${meta.role}`)}</span>}
        <span className="workflow-card__time" title={t("workspace.updatedAt", { time: updated })}>
          {updated}
        </span>
      </span>
      {meta.status === "attention" && meta.attention && (
        <span className="workflow-card__line workflow-card__attention">{formatAttention(meta.attention).text}</span>
      )}
      {meta.status === "awaiting_user" && meta.awaiting && (
        <span className="workflow-card__line workflow-card__awaiting">{t(`awaiting.${meta.awaiting.kind}`)}</span>
      )}
      {meta.status === "running" && progress && (
        <span className="workflow-card__line workflow-card__progress" title={progress}>
          {progress}
        </span>
      )}
    </button>
  );
});

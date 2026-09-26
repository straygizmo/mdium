import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskStatus } from "@/shared/types/workflow";
import { type BoardProps, TaskCard } from "./TaskCard";
import "./KanbanBoard.css";

/** Groups tasks by status, keeping their order. */
function groupByStatus(tasks: Task[]): Map<TaskStatus, Task[]> {
  const groups = new Map<TaskStatus, Task[]>();
  for (const task of tasks) {
    const list = groups.get(task.meta.status);
    if (list) list.push(task);
    else groups.set(task.meta.status, [task]);
  }
  return groups;
}

/** One column per status with a count badge. */
export function KanbanBoard({ tasks, statuses, progress, slotHolders, dateFormat, onOpen }: BoardProps) {
  const { t } = useTranslation("workflow");
  const idPrefix = useId();
  const groups = groupByStatus(tasks);

  return (
    <div className="workflow-kanban">
      {statuses.map((status) => {
        const list = groups.get(status) ?? [];
        return (
          <section
            key={status}
            className="workflow-kanban__column"
            data-status={status}
            aria-labelledby={`${idPrefix}-${status}`}
          >
            <header className="workflow-kanban__header">
              <span id={`${idPrefix}-${status}`} className="workflow-kanban__title">{t(`status.${status}`)}</span>
              <span className="workflow-kanban__count" title={t("workspace.count", { count: list.length })}>
                {list.length}
              </span>
            </header>
            <div className="workflow-kanban__cards">
              {list.map((task) => (
                <TaskCard
                  key={task.meta.id}
                  task={task}
                  progress={progress[task.meta.id]?.text}
                  holdsSlot={slotHolders.has(task.meta.id)}
                  dateFormat={dateFormat}
                  onOpen={onOpen}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

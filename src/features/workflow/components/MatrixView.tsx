import { useTranslation } from "react-i18next";
import type { Role, Task } from "@/shared/types/workflow";
import { type BoardProps, TaskCard } from "./TaskCard";
import "./MatrixView.css";

const ROLES: readonly Role[] = ["design", "implement", "review"];

/** Row key of tasks without a role. */
const NO_ROLE = "none";

/** Groups tasks by `role/status`, keeping their order. */
function groupByCell(tasks: Task[]): Map<string, Task[]> {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = `${task.meta.role ?? NO_ROLE}/${task.meta.status}`;
    const list = groups.get(key);
    if (list) list.push(task);
    else groups.set(key, [task]);
  }
  return groups;
}

/** Roles as rows, statuses as columns; cells list compact cards. */
export function MatrixView({ tasks, statuses, slotHolders, progress, dateFormat, onOpen }: BoardProps) {
  const { t } = useTranslation("workflow");
  const groups = groupByCell(tasks);
  // Tasks without a role get their own row, shown only when there are any.
  const rows: string[] = tasks.some((task) => !task.meta.role) ? [...ROLES, NO_ROLE] : [...ROLES];

  return (
    <div className="workflow-matrix">
      <table className="workflow-matrix__table">
        <thead>
          <tr>
            <th className="workflow-matrix__corner">{t("workspace.roleHeader")}</th>
            {statuses.map((status) => (
              <th key={status} className="workflow-matrix__status" data-status={status}>
                {t(`status.${status}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((role) => (
            <tr key={role} data-role={role}>
              <th className="workflow-matrix__role">{role === NO_ROLE ? t("workspace.noRole") : t(`role.${role}`)}</th>
              {statuses.map((status) => {
                const list = groups.get(`${role}/${status}`) ?? [];
                return (
                  <td key={status} className="workflow-matrix__cell" data-role={role} data-status={status}>
                    {list.length > 0 && (
                      <>
                        <span className="workflow-matrix__count" title={t("workspace.count", { count: list.length })}>
                          {list.length}
                        </span>
                        <div className="workflow-matrix__cards">
                          {list.map((task) => (
                            <TaskCard
                              key={task.meta.id}
                              task={task}
                              progress={progress[task.meta.id]?.text}
                              holdsSlot={slotHolders.has(task.meta.id)}
                              dateFormat={dateFormat}
                              compact
                              onOpen={onOpen}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

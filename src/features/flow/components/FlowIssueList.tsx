import { useTranslation } from "react-i18next";
import type { FlowIssue } from "@/shared/types/flow";
import { issueNodePath } from "../lib/flow-graph";

interface FlowIssueListProps {
  errors: FlowIssue[];
  warnings: FlowIssue[];
  /** Called with the node path an issue points into. */
  onSelectNode?: (path: string) => void;
}

/** Interpolation values for an issue message (arrays shown comma-separated). */
export function issueParams(issue: FlowIssue): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(issue.params)) {
    if (typeof value === "number" || typeof value === "string") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map(String).join(", ");
    else if (value !== null && value !== undefined) out[key] = JSON.stringify(value);
  }
  return out;
}

function IssueItem({ issue, severity, onSelectNode }: { issue: FlowIssue; severity: "error" | "warning"; onSelectNode?: (path: string) => void }) {
  const { t } = useTranslation("flow");
  const params = issueParams(issue);
  const nodePath = issueNodePath(issue.path);
  const location = issue.path ? t("workspace.location", { path: issue.path }) : t("workspace.wholeFile");
  const lineColumn =
    params.line !== undefined ? t("workspace.lineColumn", { line: params.line, column: params.column ?? "?" }) : null;
  const content = (
    <>
      <span className={`flow-issue__severity flow-issue__severity--${severity}`} aria-hidden="true" />
      <span className="flow-issue__body">
        <span className="flow-issue__message">
          {t(`issue.${issue.code}`, { ...params, defaultValue: issue.code, interpolation: { escapeValue: false } })}
        </span>
        <span className="flow-issue__location">
          {location}
          {lineColumn && ` · ${lineColumn}`}
          <span className="flow-issue__code"> · {issue.code}</span>
        </span>
      </span>
    </>
  );
  return (
    <li className={`flow-issue flow-issue--${severity}`}>
      {nodePath && onSelectNode ? (
        <button type="button" className="flow-issue__button" onClick={() => onSelectNode(nodePath)}>
          {content}
        </button>
      ) : (
        <div className="flow-issue__button">{content}</div>
      )}
    </li>
  );
}

/** Validation errors and warnings with localized messages. */
export function FlowIssueList({ errors, warnings, onSelectNode }: FlowIssueListProps) {
  const { t } = useTranslation("flow");
  if (errors.length === 0 && warnings.length === 0) {
    return <div className="flow-issues__empty">{t("workspace.noIssues")}</div>;
  }
  return (
    <div className="flow-issues">
      {errors.length > 0 && (
        <>
          <div className="flow-issues__heading">
            {t("workspace.errors")} ({errors.length})
          </div>
          <ul className="flow-issues__list">
            {errors.map((issue, i) => (
              <IssueItem key={`e${i}`} issue={issue} severity="error" onSelectNode={onSelectNode} />
            ))}
          </ul>
        </>
      )}
      {warnings.length > 0 && (
        <>
          <div className="flow-issues__heading">
            {t("workspace.warnings")} ({warnings.length})
          </div>
          <ul className="flow-issues__list">
            {warnings.map((issue, i) => (
              <IssueItem key={`w${i}`} issue={issue} severity="warning" onSelectNode={onSelectNode} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

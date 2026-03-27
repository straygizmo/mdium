import { useTranslation } from "react-i18next";
import type { GitFileEntry } from "@/features/git/lib/parse-status";

const STATUS_COLORS: Record<string, string> = {
  M: "var(--git-modified, #e2a438)",
  A: "var(--git-added, #73c991)",
  D: "var(--git-deleted, #f44747)",
  "??": "var(--git-untracked, #73c991)",
  R: "var(--git-renamed, #6eb5ff)",
  C: "var(--git-copied, #6eb5ff)",
  U: "var(--git-conflict, #f44747)",
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] || "var(--text-muted)";
}

interface GitFileListProps {
  title: string;
  files: GitFileEntry[];
  staged: boolean;
  onStage?: (files: string[]) => void;
  onUnstage?: (files: string[]) => void;
  onDiscard?: (files: string[]) => void;
}

export function GitFileList({
  title,
  files,
  staged,
  onStage,
  onUnstage,
  onDiscard,
}: GitFileListProps) {
  const { t } = useTranslation("git");

  if (files.length === 0) return null;

  const allPaths = files.map((f) => f.path);

  return (
    <div className="git-file-list">
      <div className="git-file-list__header">
        <span className="git-file-list__title">
          {title} ({files.length})
        </span>
        <div className="git-file-list__header-actions">
          {staged && onUnstage && (
            <button
              className="git-file-list__action-btn"
              onClick={() => onUnstage(allPaths)}
              title={t("unstageAll")}
            >
              −
            </button>
          )}
          {!staged && onStage && (
            <button
              className="git-file-list__action-btn"
              onClick={() => onStage(allPaths)}
              title={t("stageAll")}
            >
              +
            </button>
          )}
        </div>
      </div>
      <div className="git-file-list__items">
        {files.map((f) => (
          <div className="git-file-list__row" key={`${f.path}-${f.staged}`}>
            <span
              className="git-file-list__status"
              style={{ color: statusColor(f.status) }}
            >
              {f.status}
            </span>
            <span className="git-file-list__path" title={f.path}>
              {f.path.split("/").pop()}
              <span className="git-file-list__dir">
                {f.path.includes("/")
                  ? f.path.slice(0, f.path.lastIndexOf("/"))
                  : ""}
              </span>
            </span>
            <div className="git-file-list__row-actions">
              {staged && onUnstage && (
                <button
                  className="git-file-list__action-btn"
                  onClick={() => onUnstage([f.path])}
                  title={t("unstageFile")}
                >
                  −
                </button>
              )}
              {!staged && onStage && (
                <button
                  className="git-file-list__action-btn"
                  onClick={() => onStage([f.path])}
                  title={t("stageFile")}
                >
                  +
                </button>
              )}
              {!staged && onDiscard && (
                <button
                  className="git-file-list__action-btn"
                  onClick={() => onDiscard([f.path])}
                  title={t("discardChanges")}
                >
                  ↩
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { structuredPatch } from "diff";
import { UnifiedDiffView } from "@/shared/components/UnifiedDiffView";
import "./ExternalChangeDialog.css";

interface ExternalChangeDialogProps {
  filePath: string;
  currentContent: string;
  externalContent: string;
  onAcceptExternal: () => void;
  onKeepCurrent: () => void;
  onClose: () => void;
}

export function ExternalChangeDialog({
  filePath,
  currentContent,
  externalContent,
  onAcceptExternal,
  onKeepCurrent,
  onClose,
}: ExternalChangeDialogProps) {
  const { t } = useTranslation("editor");
  const [showDiff, setShowDiff] = useState(false);

  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  const diffText = showDiff
    ? computeDiffText(currentContent, externalContent)
    : "";

  return (
    <div className="external-change-overlay" onClick={onClose}>
      <div
        className="external-change-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <h3 className="external-change-dialog__title">
          {t("externalChangeTitle")}
        </h3>
        <p className="external-change-dialog__message">
          {t("externalChangeMessage", { fileName })}
        </p>

        {showDiff && (
          <div className="external-change-dialog__diff">
            <UnifiedDiffView diff={diffText} />
          </div>
        )}

        <div className="external-change-dialog__actions">
          <button
            className="external-change-dialog__btn external-change-dialog__btn--secondary"
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? t("externalChangeHideDiff") : t("externalChangeShowDiff")}
          </button>
          <button
            className="external-change-dialog__btn external-change-dialog__btn--secondary"
            onClick={onKeepCurrent}
          >
            {t("externalChangeKeep")}
          </button>
          <button
            className="external-change-dialog__btn external-change-dialog__btn--primary"
            onClick={onAcceptExternal}
          >
            {t("externalChangeAccept")}
          </button>
        </div>
      </div>
    </div>
  );
}

function computeDiffText(oldText: string, newText: string): string {
  const patch = structuredPatch("file", "file", oldText, newText, "", "", {
    context: 3,
  });
  const lines: string[] = [];
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

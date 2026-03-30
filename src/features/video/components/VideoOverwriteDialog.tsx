import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import "./VideoOverwriteDialog.css";

export type OverwriteChoice = "overwrite" | "new" | "cancel";

interface VideoOverwriteDialogProps {
  fileName: string;
  onChoice: (choice: OverwriteChoice) => void;
}

export function VideoOverwriteDialog({
  fileName,
  onChoice,
}: VideoOverwriteDialogProps) {
  const { t } = useTranslation("video");

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onChoice("cancel");
    },
    [onChoice],
  );

  return (
    <div className="video-overwrite-overlay" onClick={() => onChoice("cancel")}>
      <div
        className="video-overwrite-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <h3 className="video-overwrite-dialog__title">
          {t("overwriteDialogTitle")}
        </h3>
        <p className="video-overwrite-dialog__message">
          {t("overwriteDialogMessage", { fileName })}
        </p>
        <div className="video-overwrite-dialog__actions">
          <button
            className="video-overwrite-dialog__btn"
            onClick={() => onChoice("cancel")}
          >
            {t("overwriteDialogCancel")}
          </button>
          <button
            className="video-overwrite-dialog__btn"
            onClick={() => onChoice("new")}
          >
            {t("overwriteDialogNo")}
          </button>
          <button
            className="video-overwrite-dialog__btn video-overwrite-dialog__btn--primary"
            onClick={() => onChoice("overwrite")}
          >
            {t("overwriteDialogYes")}
          </button>
        </div>
      </div>
    </div>
  );
}

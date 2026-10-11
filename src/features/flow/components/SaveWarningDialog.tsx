import { useTranslation } from "react-i18next";
import { DialogShell } from "@/features/workflow/components/DialogShell";

interface SaveWarningDialogProps {
  /** The warning shown above the buttons (already translated; one paragraph per line). */
  message: string;
  onContinue(): void;
  onCancel(): void;
}

/** Asks whether to go on with a save despite a warning (validation errors, comment loss). */
export function SaveWarningDialog({ message, onContinue, onCancel }: SaveWarningDialogProps) {
  const { t } = useTranslation("flow");
  return (
    <DialogShell overlayClassName="flow-dialog-overlay" className="flow-dialog" labelledBy="flow-save-warning-title" onClose={onCancel}>
      <h2 id="flow-save-warning-title" className="flow-dialog__title">
        {t("editor.saveTitle")}
      </h2>
      {message.split("\n").map((line, i) => (
        <p key={i} className="flow-dialog__message">
          {line}
        </p>
      ))}
      <div className="flow-dialog__footer">
        <button type="button" className="flow-dialog__button" onClick={onCancel}>
          {t("editor.cancel")}
        </button>
        <button type="button" className="flow-dialog__button flow-dialog__button--primary" onClick={onContinue}>
          {t("editor.continue")}
        </button>
      </div>
    </DialogShell>
  );
}

import { useTranslation } from "react-i18next";

interface ExternalChangeNoticeProps {
  /** Disables the buttons while a reload / overwrite is in flight. */
  busy?: boolean;
  onReload(): void;
  onOverwrite(): void;
}

/** Bar shown when the file on disk no longer matches the one the editor loaded. */
export function ExternalChangeNotice({ busy = false, onReload, onOverwrite }: ExternalChangeNoticeProps) {
  const { t } = useTranslation("flow");
  return (
    <div className="flow-notice" role="alert">
      <span className="flow-notice__text">{t("editor.changedOutside")}</span>
      <button type="button" className="flow-notice__button" disabled={busy} onClick={onReload}>
        {t("editor.reload")}
      </button>
      <button type="button" className="flow-notice__button" disabled={busy} onClick={onOverwrite}>
        {t("editor.overwrite")}
      </button>
    </div>
  );
}

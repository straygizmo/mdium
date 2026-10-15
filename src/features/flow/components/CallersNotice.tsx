import { useTranslation } from "react-i18next";

interface CallersNoticeProps {
  /** Project-relative paths of the flows that have validation errors. */
  paths: string[];
  onOpen(path: string): void;
  onDismiss(): void;
}

/** Bar listing the flows with errors after a part was saved (they may call the part). */
export function CallersNotice({ paths, onOpen, onDismiss }: CallersNoticeProps) {
  const { t } = useTranslation("flow");
  return (
    <div className="flow-notice" role="alert">
      <span className="flow-notice__text">{t("editor.callersWithErrors")}</span>
      {paths.map((path) => (
        <button key={path} type="button" className="flow-notice__button" onClick={() => onOpen(path)}>
          {path}
        </button>
      ))}
      <button type="button" className="flow-notice__button" onClick={onDismiss}>
        {t("editor.dismiss")}
      </button>
    </div>
  );
}

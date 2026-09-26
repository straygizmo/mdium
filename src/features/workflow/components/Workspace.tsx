import { useTranslation } from "react-i18next";

/** Main-area workspace of the workflows panel. Placeholder until the board lands. */
export function Workspace() {
  const { t } = useTranslation("workflow");
  return (
    <div className="workflow-workspace">
      <h2 className="workflow-workspace__title">{t("title")}</h2>
    </div>
  );
}

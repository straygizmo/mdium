import { useTranslation } from "react-i18next";

interface GitGraphHeaderProps {
  onRefresh: () => void;
  loading: boolean;
}

export function GitGraphHeader({ onRefresh, loading }: GitGraphHeaderProps) {
  const { t } = useTranslation("git");

  return (
    <div className="git-graph-header">
      <span className="git-graph-header__title">{t("graph")}</span>
      <div className="git-graph-header__actions">
        <button
          className="git-graph-header__btn"
          onClick={onRefresh}
          disabled={loading}
          title={t("graphRefresh")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={loading ? "git-graph-header__spin" : ""}
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
    </div>
  );
}

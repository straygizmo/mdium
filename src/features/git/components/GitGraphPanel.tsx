import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useGitStore } from "@/stores/git-store";
import { useTabStore } from "@/stores/tab-store";
import { GitGraphHeader } from "./GitGraphHeader";
import { GitGraphRow } from "./GitGraphRow";
import { GitGraphCommitFiles } from "./GitGraphCommitFiles";
import { getMaxLaneCount } from "@/features/git/lib/graph-lanes";
import "./GitGraphPanel.css";

export function GitGraphPanel() {
  const { t } = useTranslation("git");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);

  const graphCommits = useGitStore((s) => s.graphCommits);
  const graphOutgoing = useGitStore((s) => s.graphOutgoing);
  const graphLoading = useGitStore((s) => s.graphLoading);
  const graphHasMore = useGitStore((s) => s.graphHasMore);
  const expandedCommit = useGitStore((s) => s.expandedCommit);
  const expandedFiles = useGitStore((s) => s.expandedFiles);
  const refreshGraph = useGitStore((s) => s.refreshGraph);
  const loadMoreGraph = useGitStore((s) => s.loadMoreGraph);
  const toggleCommitExpand = useGitStore((s) => s.toggleCommitExpand);

  const [outgoingCollapsed, setOutgoingCollapsed] = useState(false);

  const allCommits = useMemo(
    () => [...graphOutgoing, ...graphCommits],
    [graphOutgoing, graphCommits],
  );
  const maxLanes = useMemo(() => getMaxLaneCount(allCommits), [allCommits]);

  const handleRefresh = useCallback(() => {
    if (activeFolderPath) refreshGraph(activeFolderPath);
  }, [activeFolderPath, refreshGraph]);

  const handleLoadMore = useCallback(() => {
    if (activeFolderPath) loadMoreGraph(activeFolderPath);
  }, [activeFolderPath, loadMoreGraph]);

  const handleCommitClick = useCallback(
    (hash: string) => {
      if (activeFolderPath) toggleCommitExpand(activeFolderPath, hash);
    },
    [activeFolderPath, toggleCommitExpand],
  );

  const noCommits = graphOutgoing.length === 0 && graphCommits.length === 0 && !graphLoading;

  return (
    <div className="git-graph-panel">
      <GitGraphHeader onRefresh={handleRefresh} loading={graphLoading} />
      <div className="git-graph-panel__content">
        {noCommits && (
          <div className="git-graph-panel__empty">{t("graphNoCommits")}</div>
        )}

        {graphOutgoing.length > 0 && (
          <div className="git-graph-panel__section">
            <button
              className="git-graph-panel__section-header"
              onClick={() => setOutgoingCollapsed((v) => !v)}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                className={`git-graph-panel__chevron ${outgoingCollapsed ? "" : "git-graph-panel__chevron--open"}`}
              >
                <path d="M3 2 L7 5 L3 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <span>{t("graphOutgoing")}</span>
              <span className="git-graph-panel__section-count">{graphOutgoing.length}</span>
            </button>
            {!outgoingCollapsed &&
              graphOutgoing.map((c, idx) => (
                <div key={c.hash}>
                  <GitGraphRow
                    commit={c}
                    maxLanes={maxLanes}
                    onClick={() => handleCommitClick(c.hash)}
                    expanded={expandedCommit === c.hash}
                    isFirst={idx === 0}
                  />
                  {expandedCommit === c.hash && activeFolderPath && (
                    <GitGraphCommitFiles
                      files={expandedFiles}
                      folderPath={activeFolderPath}
                      commitHash={c.hash}
                    />
                  )}
                </div>
              ))}
          </div>
        )}

        {graphOutgoing.length > 0 && graphCommits.length > 0 && (
          <div className="git-graph-panel__separator" />
        )}

        {graphCommits.map((c, idx) => (
          <div key={c.hash}>
            <GitGraphRow
              commit={c}
              maxLanes={maxLanes}
              onClick={() => handleCommitClick(c.hash)}
              expanded={expandedCommit === c.hash}
              isFirst={idx === 0 && graphOutgoing.length === 0}
            />
            {expandedCommit === c.hash && activeFolderPath && (
              <GitGraphCommitFiles
                files={expandedFiles}
                folderPath={activeFolderPath}
                commitHash={c.hash}
              />
            )}
          </div>
        ))}

        {graphHasMore && (
          <button
            className="git-graph-panel__load-more"
            onClick={handleLoadMore}
            disabled={graphLoading}
          >
            {graphLoading ? "..." : t("graphLoadMore")}
          </button>
        )}
      </div>
    </div>
  );
}

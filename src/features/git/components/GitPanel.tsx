import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useGitStore } from "@/stores/git-store";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { GitBranchSelect } from "./GitBranchSelect";
import { GitFileList } from "./GitFileList";
import { showConfirm } from "@/stores/dialog-store";
import "./GitPanel.css";

export function GitPanel() {
  const { t } = useTranslation("git");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const { aiSettings, language } = useSettingsStore();

  const files = useGitStore((s) => s.files);
  const commitMessage = useGitStore((s) => s.commitMessage);
  const loading = useGitStore((s) => s.loading);
  const generating = useGitStore((s) => s.generating);
  const error = useGitStore((s) => s.error);
  const isRepo = useGitStore((s) => s.isRepo);
  const remoteUrl = useGitStore((s) => s.remoteUrl);
  const refresh = useGitStore((s) => s.refresh);
  const initRepo = useGitStore((s) => s.initRepo);
  const setRemoteUrlAction = useGitStore((s) => s.setRemoteUrl);
  const stageFiles = useGitStore((s) => s.stageFiles);
  const unstageFiles = useGitStore((s) => s.unstageFiles);
  const commitAction = useGitStore((s) => s.commit);
  const pushAction = useGitStore((s) => s.push);
  const discardFiles = useGitStore((s) => s.discardFiles);
  const generateCommitMessage = useGitStore((s) => s.generateCommitMessage);
  const setCommitMessage = useGitStore((s) => s.setCommitMessage);
  const clearError = useGitStore((s) => s.clearError);

  const [editingRemote, setEditingRemote] = useState(false);
  const [remoteInput, setRemoteInput] = useState("");

  useEffect(() => {
    if (activeFolderPath) {
      refresh(activeFolderPath);
    }
  }, [activeFolderPath, refresh]);

  const stagedFiles = useMemo(() => files.filter((f) => f.staged), [files]);
  const unstagedFiles = useMemo(() => files.filter((f) => !f.staged), [files]);
  const hasUncommitted = files.length > 0;

  const handleStage = useCallback(
    (paths: string[]) => {
      if (activeFolderPath) stageFiles(activeFolderPath, paths);
    },
    [activeFolderPath, stageFiles],
  );

  const handleUnstage = useCallback(
    (paths: string[]) => {
      if (activeFolderPath) unstageFiles(activeFolderPath, paths);
    },
    [activeFolderPath, unstageFiles],
  );

  const handleDiscard = useCallback(
    async (paths: string[]) => {
      const ok = await showConfirm(t("discardConfirmMessage"), {
        title: t("discardConfirmTitle"),
        kind: "warning",
      });
      if (!ok || !activeFolderPath) return;

      // Separate tracked and untracked files
      const trackedPaths: string[] = [];
      const untrackedPaths: string[] = [];
      for (const p of paths) {
        const entry = unstagedFiles.find((f) => f.path === p);
        if (entry?.status === "??") {
          untrackedPaths.push(p);
        } else {
          trackedPaths.push(p);
        }
      }
      discardFiles(activeFolderPath, trackedPaths, untrackedPaths);
    },
    [activeFolderPath, unstagedFiles, discardFiles, t],
  );

  const handleCommit = useCallback(() => {
    if (activeFolderPath) commitAction(activeFolderPath);
  }, [activeFolderPath, commitAction]);

  const handlePush = useCallback(() => {
    if (activeFolderPath) pushAction(activeFolderPath);
  }, [activeFolderPath, pushAction]);

  const handleGenerate = useCallback(() => {
    if (activeFolderPath) {
      generateCommitMessage(activeFolderPath, aiSettings, language);
    }
  }, [activeFolderPath, aiSettings, language, generateCommitMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleCommit();
      }
    },
    [handleCommit],
  );

  const handleInitRepo = useCallback(() => {
    if (activeFolderPath) initRepo(activeFolderPath);
  }, [activeFolderPath, initRepo]);

  const handleRemoteSave = useCallback(() => {
    if (activeFolderPath && remoteInput.trim()) {
      setRemoteUrlAction(activeFolderPath, remoteInput.trim());
      setEditingRemote(false);
    }
  }, [activeFolderPath, remoteInput, setRemoteUrlAction]);

  if (!activeFolderPath) {
    return (
      <div className="git-panel git-panel--empty">
        <span className="git-panel__placeholder">{t("notGitRepo")}</span>
      </div>
    );
  }

  if (!isRepo) {
    // Show loading while refreshing (avoid incorrectly showing "Not a Git repository")
    if (loading) {
      return (
        <div className="git-panel git-panel--empty">
          <span className="git-panel__placeholder">{t("loading", { defaultValue: "Loading..." })}</span>
        </div>
      );
    }
    return (
      <div className="git-panel git-panel--empty">
        <span className="git-panel__placeholder">{t("notGitRepo")}</span>
        <p className="git-panel__init-desc">{t("initRepoDesc")}</p>
        <button
          className="git-panel__init-btn"
          onClick={handleInitRepo}
          disabled={loading}
        >
          {t("initRepo")}
        </button>
        {error && (
          <div className="git-panel__error">{t(error, { defaultValue: error })}</div>
        )}
      </div>
    );
  }

  // Translate error keys from the store (they can be i18n keys or raw messages)
  const errorMessage = error
    ? t(error, { defaultValue: error })
    : null;

  return (
    <div className="git-panel">
      <GitBranchSelect
        folderPath={activeFolderPath}
        hasUncommitted={hasUncommitted}
      />

      <div className="git-panel__remote">
        {editingRemote ? (
          <div className="git-panel__remote-edit">
            <input
              className="git-panel__remote-input"
              type="text"
              value={remoteInput}
              onChange={(e) => setRemoteInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRemoteSave();
                if (e.key === "Escape") setEditingRemote(false);
              }}
              placeholder={t("remoteUrlPlaceholder")}
              autoFocus
            />
            <button
              className="git-panel__remote-save"
              onClick={handleRemoteSave}
              disabled={!remoteInput.trim()}
            >
              {t("remoteUrlSet")}
            </button>
          </div>
        ) : (
          <button
            className="git-panel__remote-display"
            onClick={() => { setRemoteInput(remoteUrl); setEditingRemote(true); }}
            title={remoteUrl || t("remoteUrlNone")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <span className="git-panel__remote-url">
              {remoteUrl || t("remoteUrlNone")}
            </span>
          </button>
        )}
      </div>

      <div className="git-panel__commit-area">
        <div className="git-panel__message-wrap">
          <textarea
            className="git-panel__message-input"
            placeholder={t("commitMessagePlaceholder")}
            value={commitMessage}
            onChange={(e) => {
              setCommitMessage(e.target.value);
              if (error) clearError();
            }}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            className={`git-panel__ai-btn ${generating ? "git-panel__ai-btn--generating" : ""}`}
            onClick={handleGenerate}
            disabled={generating || stagedFiles.length === 0}
            title={t("generateAI")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="2">
              <path d="M15 19c1.2-3.678 2.526-5.005 6-6c-3.474-.995-4.8-2.322-6-6c-1.2 3.678-2.526 5.005-6 6c3.474.995 4.8 2.322 6 6Zm-8-9c.6-1.84 1.263-2.503 3-3c-1.737-.497-2.4-1.16-3-3c-.6 1.84-1.263 2.503-3 3c1.737.497 2.4 1.16 3 3Zm1.5 10c.3-.92.631-1.251 1.5-1.5c-.869-.249-1.2-.58-1.5-1.5c-.3.92-.631 1.251-1.5 1.5c.869.249 1.2.58 1.5 1.5Z" />
            </svg>
          </button>
        </div>
        <div className="git-panel__actions">
          <button
            className="git-panel__action-btn git-panel__action-btn--commit"
            onClick={handleCommit}
            disabled={loading || !commitMessage.trim() || stagedFiles.length === 0}
            title={t("commit")}
          >
            {t("commit")}
          </button>
          <button
            className="git-panel__action-btn git-panel__action-btn--push"
            onClick={handlePush}
            disabled={loading}
            title={t("push")}
          >
            {t("push")}
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="git-panel__error">{errorMessage}</div>
      )}

      <div className="git-panel__file-lists">
        <GitFileList
          title={t("stagedChanges")}
          files={stagedFiles}
          staged={true}
          folderPath={activeFolderPath ?? ""}
          onUnstage={handleUnstage}
        />
        <GitFileList
          title={t("changes")}
          files={unstagedFiles}
          staged={false}
          folderPath={activeFolderPath ?? ""}
          onStage={handleStage}
          onDiscard={handleDiscard}
        />
        {files.length === 0 && !loading && (
          <div className="git-panel__no-changes">{t("noChanges")}</div>
        )}
      </div>
    </div>
  );
}

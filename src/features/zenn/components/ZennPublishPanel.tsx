import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import "./ZennPublishPanel.css";

interface ZennPublishPanelProps {
  folderPath: string;
  onRefresh: () => void;
}

export function ZennPublishPanel({ folderPath, onRefresh }: ZennPublishPanelProps) {
  const { t } = useTranslation("common");
  const [gitStatus, setGitStatus] = useState<string>("");
  const [commitMsg, setCommitMsg] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [editingRemote, setEditingRemote] = useState(false);
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const status = await invoke<string>("git_status", { path: folderPath });
      setGitStatus(status);
      const remote = await invoke<string>("git_get_remote_url", { path: folderPath });
      setRemoteUrl(remote);
    } catch {
      setGitStatus("Not a git repository");
    }
  }, [folderPath]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleCommitAndPush = useCallback(async () => {
    if (!commitMsg.trim()) return;
    setLoading(true);
    try {
      await invoke("git_add_all", { path: folderPath });
      await invoke("git_commit", { path: folderPath, message: commitMsg });
      await invoke("git_push", { path: folderPath });
      setCommitMsg("");
      await fetchStatus();
      onRefresh();
    } catch (e) {
      console.error("Git operation failed:", e);
    } finally {
      setLoading(false);
    }
  }, [folderPath, commitMsg, fetchStatus, onRefresh]);

  const handleSaveRemote = useCallback(async () => {
    try {
      await invoke("git_set_remote_url", { path: folderPath, url: remoteUrl });
      setEditingRemote(false);
    } catch (e) {
      console.error("Failed to set remote:", e);
    }
  }, [folderPath, remoteUrl]);

  return (
    <div className="zenn-publish">
      <div className="zenn-publish__status">
        <pre className="zenn-publish__status-text">{gitStatus || "Loading..."}</pre>
      </div>

      <div className="zenn-publish__remote">
        {editingRemote ? (
          <div className="zenn-publish__remote-edit">
            <input
              className="zenn-publish__input"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://github.com/..."
            />
            <button className="zenn-publish__btn" onClick={handleSaveRemote}>{t("save")}</button>
            <button className="zenn-publish__btn" onClick={() => setEditingRemote(false)}>{t("cancel")}</button>
          </div>
        ) : (
          <div className="zenn-publish__remote-display">
            <span className="zenn-publish__remote-url">{remoteUrl || "No remote"}</span>
            <button className="zenn-publish__btn" onClick={() => setEditingRemote(true)}>Edit</button>
          </div>
        )}
      </div>

      <div className="zenn-publish__commit">
        <input
          className="zenn-publish__input"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="Commit message"
          onKeyDown={(e) => e.key === "Enter" && handleCommitAndPush()}
        />
        <button
          className="zenn-publish__btn zenn-publish__btn--primary"
          onClick={handleCommitAndPush}
          disabled={loading || !commitMsg.trim()}
        >
          {loading ? "..." : "Commit & Push"}
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useFileStore } from "@/stores/file-store";
import { getFileIcon } from "@/features/file-tree/components/FileTree";
import { showConfirm, showMessage } from "@/stores/dialog-store";
import { useFtpMirrorStore, type MirrorPending } from "@/stores/ftp-mirror-store";
import "./TabBar.css";

/** Folder tabs (displayed at full width) */
export function FolderTabBar() {
  const { t } = useTranslation();
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const openFolders = useTabStore((s) => s.openFolderPaths);
  const switchFolder = useTabStore((s) => s.switchFolder);
  const closeFolder = useTabStore((s) => s.closeFolder);
  const removeFileTree = useFileStore((s) => s.removeFileTree);
  const mirrors = useFtpMirrorStore((s) => s.mirrors);

  const handleCloseFolder = async (folder: string) => {
    // Read tabs from store directly to avoid subscribing to all tab changes
    const folderTabs = useTabStore.getState().tabs.filter((tab) => tab.folderPath === folder);
    const hasDirty = folderTabs.some((tab) => tab.dirty);
    if (hasDirty && !(await showConfirm(t("unsavedChanges"), { kind: "warning" }))) return;

    // FTP mirror: check what has not reached the server while it still syncs.
    const mirrors = useFtpMirrorStore.getState();
    const uri = mirrors.mirrors[folder];
    let pending: MirrorPending | null = null;
    let pendingError: string | null = null;
    if (uri) {
      try {
        pending = await mirrors.pending(folder);
      } catch (e) {
        pendingError = String(e);
      }
    }

    closeFolder(folder);
    removeFileTree(folder);

    if (uri) await offerMirrorDeletion(folder, uri, pending, pendingError);
  };

  /** Offer to delete a closed mirror's local copy, unless changes are unsynced. */
  const offerMirrorDeletion = async (
    folder: string,
    uri: string,
    pending: MirrorPending | null,
    pendingError: string | null,
  ) => {
    if (!pending) {
      await showMessage(t("remote:keepMirrorUnknown", { uri, error: pendingError ?? "" }), { kind: "warning" });
      return;
    }
    if (pending.uploads + pending.deletes + pending.conflicts > 0) {
      await showMessage(t("remote:keepMirrorUnsynced", { uri, ...pending }), { kind: "warning" });
      return;
    }
    if (!(await showConfirm(t("remote:deleteMirrorConfirm", { uri }), { kind: "info" }))) return;
    try {
      await useFtpMirrorStore.getState().remove(folder);
    } catch (e) {
      await showMessage(t("remote:deleteMirrorFailed", { error: String(e) }), { kind: "error" });
    }
  };

  const getFolderName = (path: string) => {
    return path.split(/[\\/]/).pop() ?? path;
  };

  if (openFolders.length === 0) return null;

  return (
    <div className="tab-bar tab-bar--folder">
      {openFolders.map((folder) => (
        <div
          key={folder}
          className={`tab-bar__tab tab-bar__tab--folder ${folder === activeFolderPath ? "tab-bar__tab--active" : ""}`}
          onClick={() => switchFolder(folder)}
          title={mirrors[folder] ? `${t("remote:ftpFolderTab", { uri: mirrors[folder] })}\n${folder}` : folder}
        >
          {mirrors[folder] ? (
            <span className="tab-bar__ftp-badge" aria-label={t("remote:panelTitle")}>FTP</span>
          ) : (
            <span className="tab-bar__folder-icon">📁</span>
          )}
          <span className="tab-bar__name">{getFolderName(folder)}</span>
          <button
            className="tab-bar__close"
            onClick={(e) => {
              e.stopPropagation();
              handleCloseFolder(folder);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** File tabs (displayed at top of workspace) */
export function TabBar() {
  const { t } = useTranslation();
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const closeTab = useTabStore((s) => s.closeTab);

  // File tabs belonging to the current folder (saved + new files)
  const fileTabs = tabs.filter(
    (tab) => tab.folderPath === activeFolderPath && (tab.filePath || tab.fileName)
  );

  // Untitled tab (empty placeholder for initial folder display)
  const untitledTab = tabs.find(
    (tab) => tab.folderPath === activeFolderPath && !tab.filePath && !tab.fileName
  );

  // Auto-scroll to active tab
  const activeTabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  // Don't show tab bar when no folder is open
  if (!activeFolderPath) return null;

  return (
    <div className="tab-bar-container">
      <div className="tab-bar tab-bar--file">
        {fileTabs.length === 0 && untitledTab ? (
          <div className="tab-bar__tab tab-bar__tab--active">
            <span className="tab-bar__name">{t("untitled")}</span>
            <button
              className="tab-bar__close"
              onClick={() => closeTab(untitledTab.id)}
            >
              ×
            </button>
          </div>
        ) : (
          fileTabs.map((tab) => (
            <div
              key={tab.id}
              ref={tab.id === activeTabId ? activeTabRef : undefined}
              className={`tab-bar__tab ${tab.id === activeTabId ? "tab-bar__tab--active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              title={tab.filePath || tab.fileName}
            >
              <span className="tab-bar__name">
                {tab.isDiffTab && tab.diffStatus && (
                  <span className="tab-bar__diff-status" data-status={tab.diffStatus}>
                    {tab.diffStatus}
                  </span>
                )}
                <span className="tab-bar__file-icon">{getFileIcon(tab.fileName)}</span>
                {tab.isDiffTab ? t("diffTab", { ns: "git", fileName: tab.fileName }) : tab.fileName}
                {!tab.isDiffTab && tab.dirty && <span className="tab-bar__dirty">*</span>}
              </span>
              <button
                className="tab-bar__close"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!tab.isDiffTab && tab.dirty && !(await showConfirm(t("unsavedChanges"), { kind: "warning" }))) return;
                  closeTab(tab.id);
                }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

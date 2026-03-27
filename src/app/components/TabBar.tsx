import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { useFileStore } from "@/stores/file-store";
import { getFileIcon } from "@/features/file-tree/components/FileTree";
import { ask } from "@tauri-apps/plugin-dialog";
import "./TabBar.css";

/** フォルダタブ（フル幅で表示） */
export function FolderTabBar() {
  const { t } = useTranslation();
  const tabs = useTabStore((s) => s.tabs);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const openFolders = useTabStore((s) => s.openFolderPaths);
  const switchFolder = useTabStore((s) => s.switchFolder);
  const closeFolder = useTabStore((s) => s.closeFolder);
  const removeFileTree = useFileStore((s) => s.removeFileTree);

  const handleCloseFolder = async (folder: string) => {
    const folderTabs = tabs.filter((tab) => tab.folderPath === folder);
    const hasDirty = folderTabs.some((tab) => tab.dirty);
    if (hasDirty && !(await ask(t("unsavedChanges"), { kind: "warning" }))) return;
    closeFolder(folder);
    removeFileTree(folder);
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
          title={folder}
        >
          <span className="tab-bar__folder-icon">📁</span>
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

/** ファイルタブ（ワークスペース上部に表示） */
export function TabBar() {
  const { t } = useTranslation();
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const closeTab = useTabStore((s) => s.closeTab);

  // 現在のフォルダに属するファイルタブ（保存済み＋新規ファイル）
  const fileTabs = tabs.filter(
    (tab) => tab.folderPath === activeFolderPath && (tab.filePath || tab.fileName)
  );

  // 無題タブ（フォルダ初期表示用の空プレースホルダー）
  const untitledTab = tabs.find(
    (tab) => tab.folderPath === activeFolderPath && !tab.filePath && !tab.fileName
  );

  // フォルダが開かれていないときはタブバーを表示しない
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
              className={`tab-bar__tab ${tab.id === activeTabId ? "tab-bar__tab--active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              title={tab.filePath || tab.fileName}
            >
              <span className="tab-bar__name">
                <span className="tab-bar__file-icon">{getFileIcon(tab.fileName)}</span>
                {tab.fileName}
                {tab.dirty && <span className="tab-bar__dirty">*</span>}
              </span>
              <button
                className="tab-bar__close"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (tab.dirty && !(await ask(t("unsavedChanges"), { kind: "warning" }))) return;
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

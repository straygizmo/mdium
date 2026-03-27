import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useUiStore } from "@/stores/ui-store";
import type { RecentFile, RecentFolder } from "@/shared/types";
import "./Toolbar.css";

interface ToolbarProps {
  activeFolderPath: string | null;
  onSave: () => void;
  onSaveAs: () => void;
  onOpenFolder: () => void;
  onOpenFile: (path: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  recentFiles: RecentFile[];
  recentFolders: RecentFolder[];
  onOpenRecentFolder: (path: string) => void;
}

export function Toolbar({
  activeFolderPath,
  onSave,
  onSaveAs,
  onOpenFolder,
  onOpenFile: _onOpenFile,
  onUndo,
  onRedo,
  recentFiles: _recentFiles,
  recentFolders,
  onOpenRecentFolder,
}: ToolbarProps) {
  const { t } = useTranslation("toolbar");

  const toggleEditor = useUiStore((s) => s.toggleEditor);
  const setShowSearch = useUiStore((s) => s.setShowSearch);
  const showSearch = useUiStore((s) => s.showSearch);
  const bottomTerminalVisible = useUiStore((s) => s.bottomTerminalVisible);
  const setBottomTerminalVisible = useUiStore((s) => s.setBottomTerminalVisible);

  const [showRecentFiles, setShowRecentFiles] = useState(false);
  const [showRecentFolders, setShowRecentFolders] = useState(false);

  const handleMinimize = () => getCurrentWindow().minimize();
  const handleMaximize = () => getCurrentWindow().toggleMaximize();
  const handleClose = () => getCurrentWindow().destroy();

  return (
    <header className="toolbar">
      <div className="toolbar__app-title">MDium</div>
      <span className="toolbar__separator" />
      <div className="toolbar__left">
        <div className="toolbar__dropdown-wrapper">
          <button
            className="toolbar__btn"
            onClick={onOpenFolder}
            onContextMenu={(e) => {
              e.preventDefault();
              setShowRecentFolders((v) => !v);
            }}
            title={t("openFolder")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          {showRecentFolders && recentFolders.length > 0 && (
            <div className="toolbar__dropdown" onMouseLeave={() => setShowRecentFolders(false)}>
              {recentFolders.map((f) => (
                <div
                  key={f.path}
                  className="toolbar__dropdown-item"
                  title={f.path}
                  onClick={() => {
                    onOpenRecentFolder(f.path);
                    setShowRecentFolders(false);
                  }}
                >
                  {f.name}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="toolbar__dropdown-wrapper">
          <button
            className="toolbar__btn"
            onClick={() => setShowRecentFiles((v) => !v)}
            onContextMenu={(e) => {
              e.preventDefault();
              setShowRecentFiles((v) => !v);
            }}
            title="Recent"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </button>
          {showRecentFiles && recentFolders.length > 0 && (
            <div className="toolbar__dropdown" onMouseLeave={() => setShowRecentFiles(false)}>
              {recentFolders.map((f) => (
                <div
                  key={f.path}
                  className="toolbar__dropdown-item"
                  title={f.path}
                  onClick={() => {
                    onOpenRecentFolder(f.path);
                    setShowRecentFiles(false);
                  }}
                >
                  {f.name}
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="toolbar__separator" />
        <button className="toolbar__btn" onClick={onSave} title={t("save")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
        </button>
        <button className="toolbar__btn" onClick={onSaveAs} title={t("saveAs")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l4 4v14z" />
            <polyline points="14 21 14 14 7 14 7 21" />
            <polyline points="7 3 7 8 13 8" />
            <line x1="17" y1="3" x2="23" y2="3" strokeWidth="2.5" />
            <line x1="20" y1="0" x2="20" y2="6" strokeWidth="2.5" />
          </svg>
        </button>
        <button className="toolbar__btn" onClick={onUndo} title="Undo">
          ↩
        </button>
        <button className="toolbar__btn" onClick={onRedo} title="Redo">
          ↪
        </button>
        <button
          className="toolbar__btn"
          onClick={() => setShowSearch(!showSearch)}
          title={t("search", { ns: "common" })}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
        {activeFolderPath && (
          <>
            <span className="toolbar__separator" />
            <span className="toolbar__folder-path">{activeFolderPath}</span>
          </>
        )}
      </div>

      <div className="toolbar__right">
        <button className="toolbar__btn" onClick={toggleEditor} title={t("togglePreview")}>
          ◧
        </button>
        <button
          className={`toolbar__btn${bottomTerminalVisible ? " toolbar__btn--active" : ""}`}
          onClick={() => setBottomTerminalVisible(!bottomTerminalVisible)}
          title={t("terminal", { ns: "leftPanel" }) || "Terminal"}
        >
⬒
        </button>
        <span className="toolbar__separator" />
        <div className="toolbar__window-controls">
          <button className="toolbar__window-btn" onClick={handleMinimize} title="Minimize">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor" /></svg>
          </button>
          <button className="toolbar__window-btn" onClick={handleMaximize} title="Maximize">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button className="toolbar__window-btn toolbar__window-btn--close" onClick={handleClose} title="Close">
            <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" /><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.5" /></svg>
          </button>
        </div>
      </div>
    </header>
  );
}

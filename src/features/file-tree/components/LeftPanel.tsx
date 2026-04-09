import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useUiStore } from "@/stores/ui-store";
import { useFileStore } from "@/stores/file-store";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { FileTree } from "./FileTree";
import { OutlinePanel } from "./OutlinePanel";
import { RagPanel } from "@/features/rag/components/RagPanel";
import { OpencodeConfigPanel } from "@/features/opencode-config/components/OpencodeConfigPanel";
import { GitPanel } from "@/features/git/components/GitPanel";
import { useGitStore } from "@/stores/git-store";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { useChatUIStore } from "@/features/opencode-config/hooks/useOpencodeChat";
import { collectConvertibleFiles, buildConvertibleTree } from "@/features/export/lib/collectConvertibleFiles";
import { BatchConvertModal } from "@/features/export/components/BatchConvertModal";
import "./LeftPanel.css";

export interface FileFilterProps {
  showAll: boolean;
  activateShowAll: () => void;
  filterDocx: boolean;
  filterXls: boolean;
  filterKm: boolean;
  filterImages: boolean;
  filterPdf: boolean;
  toggleFilterDocx: () => void;
  toggleFilterXls: () => void;
  toggleFilterKm: () => void;
  toggleFilterImages: () => void;
  toggleFilterPdf: () => void;
  showDocxBtn: boolean;
  showXlsBtn: boolean;
  showKmBtn: boolean;
  showPdfBtn: boolean;
}

interface LeftPanelProps extends FileFilterProps {
  onFileSelect: (path: string) => void;
  onRefresh: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  previewRef: React.RefObject<HTMLDivElement | null>;
  onImageDragStart?: (path: string) => void;
}

export function LeftPanel({
  onFileSelect, onRefresh, onNewFile, onNewFolder, previewRef, onImageDragStart,
  showAll, activateShowAll,
  filterDocx, filterXls, filterKm, filterImages, filterPdf,
  toggleFilterDocx, toggleFilterXls, toggleFilterKm, toggleFilterImages, toggleFilterPdf,
  showDocxBtn, showXlsBtn, showKmBtn, showPdfBtn,
}: LeftPanelProps) {
  const { t } = useTranslation("toolbar");
  const leftPanel = useUiStore((s) => s.leftPanel);
  const setLeftPanel = useUiStore((s) => s.setLeftPanel);
  const setFolderLeftPanel = useTabStore((s) => s.setFolderLeftPanel);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const fileTree = useFileStore((s) =>
    activeFolderPath ? s.fileTrees[activeFolderPath] : undefined
  ) ?? [];
  const activeFile = useFileStore((s) => s.activeFile);
  const activeTab = useTabStore((s) => s.getActiveTab());
  const { aiSettings } = useSettingsStore();
  const setShowSettings = useSettingsStore((s) => s.setShowSettings);
  const collapseAllDirs = useFileStore((s) => s.collapseAllDirs);
  const ocConfigAgents = useOpencodeConfigStore((s) => s.config.agents);
  const ocSelectedAgent = useChatUIStore((s) => s.selectedAgent);
  const ocModel = useMemo(() => {
    const agentModel = ocSelectedAgent && ocConfigAgents?.[ocSelectedAgent]?.model;
    if (agentModel) return agentModel;
    return `${aiSettings.provider}/${aiSettings.model}`;
  }, [ocSelectedAgent, ocConfigAgents, aiSettings.provider, aiSettings.model]);
  const gitFileCount = useGitStore((s) => s.files.length);
  const [showBatchConvert, setShowBatchConvert] = useState(false);
  const convertibleFiles = useMemo(() => collectConvertibleFiles(fileTree), [fileTree]);
  const convertibleTree = useMemo(() => buildConvertibleTree(fileTree), [fileTree]);

  return (
    <div className="left-panel">
      <div className="left-panel__activity-bar">
        <div className="left-panel__activity-bar-top">
          <button
            className={`left-panel__activity-btn ${leftPanel === "folder" ? "left-panel__activity-btn--active" : ""}`}
            onClick={() => { setLeftPanel("folder"); setFolderLeftPanel("folder"); }}
            title={t("files")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <polyline points="13 2 13 9 20 9" />
            </svg>
          </button>
          <button
            className={`left-panel__activity-btn ${leftPanel === "outline" ? "left-panel__activity-btn--active" : ""}`}
            onClick={() => { setLeftPanel("outline"); setFolderLeftPanel("outline"); }}
            title={t("outline")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
          <button
            className={`left-panel__activity-btn ${leftPanel === "git" ? "left-panel__activity-btn--active" : ""}`}
            onClick={() => { setLeftPanel("git"); setFolderLeftPanel("git"); }}
            title={t("sourceControl", { ns: "git" })}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <path d="M6 21V9a9 9 0 0 0 9 9" />
            </svg>
            {gitFileCount > 0 && (
              <span className="left-panel__badge">
                {gitFileCount > 99 ? "99+" : gitFileCount}
              </span>
            )}
          </button>
          <button
            className={`left-panel__activity-btn ${leftPanel === "rag" ? "left-panel__activity-btn--active" : ""}`}
            onClick={() => { setLeftPanel("rag"); setFolderLeftPanel("rag"); }}
            title="RAG"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            className={`left-panel__activity-btn ${leftPanel === "opencode-config" ? "left-panel__activity-btn--active" : ""}`}
            onClick={() => { setLeftPanel("opencode-config"); setFolderLeftPanel("opencode-config"); }}
            title="opencode"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="2" width="16" height="20" />
              <rect x="8" y="6" width="8" height="12" />
            </svg>
          </button>
        </div>
        <div className="left-panel__activity-bar-bottom">
          {activeFolderPath && (
            <>
              <button
                className="left-panel__activity-btn"
                onClick={() => invoke("open_in_vscode", { path: activeFolderPath })}
                title={t("openInVSCode")}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M17.5 2L9.5 9.5L4.5 5.5L2 7L7.5 12L2 17L4.5 18.5L9.5 14.5L17.5 22L22 20V4L17.5 2ZM17.5 17.5L11 12L17.5 6.5V17.5Z" fill="currentColor" />
                </svg>
              </button>
              <button
                className="left-panel__activity-btn"
                onClick={() => invoke("open_external_url", { url: activeFolderPath })}
                title={t("openInExplorer")}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </>
          )}
          <button
            className="left-panel__activity-btn"
            onClick={() => setShowSettings(true)}
            title={t("settings") || "Settings"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      <div className="left-panel__content">
        <div className="left-panel__section-header">
          <span className="left-panel__section-header-title">
            {leftPanel === "folder" && t("explorer").toUpperCase()}
            {leftPanel === "outline" && t("outline").toUpperCase()}
            {leftPanel === "rag" && (
              <>
                RAG
                <span className="left-panel__section-header-model">
                  ({aiSettings.provider} / {aiSettings.model})
                </span>
              </>
            )}
            {leftPanel === "opencode-config" && (
              <>
                OPENCODE
                {ocModel && (
                  <span className="left-panel__section-header-model">
                    ({ocModel.includes("/")
                      ? `${ocModel.split("/")[0]} / ${ocModel.split("/").slice(1).join("/")}`
                      : ocModel})
                  </span>
                )}
              </>
            )}
            {leftPanel === "git" && t("sourceControl", { ns: "git" }).toUpperCase()}
          </span>
          {leftPanel === "folder" && !!activeFolderPath && (
            <div className="left-panel__section-header-actions">
              <button className="left-panel__header-action" onClick={onNewFile} title={t("newFile", { ns: "fileTree" })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="12" y1="18" x2="12" y2="12" />
                  <line x1="9" y1="15" x2="15" y2="15" />
                </svg>
              </button>
              <button className="left-panel__header-action" onClick={onNewFolder} title={t("newFolder", { ns: "fileTree" })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  <line x1="12" y1="11" x2="12" y2="17" />
                  <line x1="9" y1="14" x2="15" y2="14" />
                </svg>
              </button>
              <button className="left-panel__header-action" onClick={onRefresh} title={t("refresh", { ns: "fileTree" })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
              <button className="left-panel__header-action" onClick={collapseAllDirs} title={t("collapseAll", { ns: "fileTree" })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
              {convertibleFiles.length > 0 && (
                <button className="left-panel__header-action" onClick={() => setShowBatchConvert(true)} title={t("batchConvert", { ns: "common" })}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <path d="M12 18v-6" />
                    <path d="M9 15l3 3 3-3" />
                  </svg>
                </button>
              )}
            </div>
          )}
          {leftPanel === "git" && (
            <div className="left-panel__section-header-actions">
              <button
                className="left-panel__header-action"
                onClick={() => {
                  if (activeFolderPath) {
                    useGitStore.getState().refresh(activeFolderPath);
                  }
                }}
                title={t("refresh", { ns: "fileTree" })}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            </div>
          )}
        </div>
        {leftPanel === "folder" && !!activeFolderPath && (
          <div className="file-tree__header">
            <div className="file-tree__filters">
              <button
                className={`file-tree__filter-btn ${showAll ? "file-tree__filter-btn--active" : ""}`}
                onClick={activateShowAll}
                title={t("filterAll", { ns: "fileTree" })}
              >
                📁
              </button>
              <button
                className={`file-tree__filter-btn ${!showAll && filterImages ? "file-tree__filter-btn--active" : ""}`}
                onClick={toggleFilterImages}
                title={t("filterImages", { ns: "fileTree" })}
              >
                🖼️
              </button>
              {showDocxBtn && (
                <button
                  className={`file-tree__filter-btn ${!showAll && filterDocx ? "file-tree__filter-btn--active" : ""}`}
                  onClick={toggleFilterDocx}
                  title={t("filterDocx", { ns: "fileTree" })}
                >
                  .docx
                </button>
              )}
              {showXlsBtn && (
                <button
                  className={`file-tree__filter-btn ${!showAll && filterXls ? "file-tree__filter-btn--active" : ""}`}
                  onClick={toggleFilterXls}
                  title={t("filterXls", { ns: "fileTree" })}
                >
                  .xls*
                </button>
              )}
              {showKmBtn && (
                <button
                  className={`file-tree__filter-btn ${!showAll && filterKm ? "file-tree__filter-btn--active" : ""}`}
                  onClick={toggleFilterKm}
                  title={t("filterKm", { ns: "fileTree" })}
                >
                  .km
                </button>
              )}
              {showPdfBtn && (
                <button
                  className={`file-tree__filter-btn ${!showAll && filterPdf ? "file-tree__filter-btn--active" : ""}`}
                  onClick={toggleFilterPdf}
                  title={t("filterPdf", { ns: "fileTree" })}
                >
                  .pdf
                </button>
              )}
            </div>
          </div>
        )}
        {leftPanel === "folder" && (
          <FileTree
            tree={fileTree}
            activeFile={activeFile}
            onFileSelect={onFileSelect}
            onRefresh={onRefresh}
            hasFolderOpen={!!activeFolderPath}
            onImageDragStart={onImageDragStart}
          />
        )}
        {leftPanel === "outline" && (
          <OutlinePanel
            content={activeTab?.content ?? ""}
            previewRef={previewRef}
          />
        )}
        <div style={{ display: leftPanel === "rag" ? "contents" : "none" }}>
          <RagPanel
            folderPath={activeFolderPath}
            aiSettings={aiSettings}
            onOpenFile={onFileSelect}
          />
        </div>
        {leftPanel === "opencode-config" && (
          <OpencodeConfigPanel />
        )}
        {leftPanel === "git" && <GitPanel />}
      </div>
      {showBatchConvert && (
        <BatchConvertModal
          files={convertibleFiles}
          tree={convertibleTree}
          onClose={() => setShowBatchConvert(false)}
          onComplete={onRefresh}
        />
      )}
    </div>
  );
}

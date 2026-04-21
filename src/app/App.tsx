import { useEffect, useRef, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "@/stores/settings-store";
import { useTabStore } from "@/stores/tab-store";
import { useGitStore } from "@/stores/git-store";
import { useOpencodeServerStore } from "@/stores/opencode-server-store";
import { getOfficeExt, getMindmapExt, getImageExt, getPdfExt, getCsvExt, isCodeFile } from "@/shared/lib/constants";
import { useFileStore } from "@/stores/file-store";
import { useUiStore } from "@/stores/ui-store";
import { useRecentItems } from "@/shared/hooks/useRecentItems";
import { useFileFilters } from "@/shared/hooks/useFileFilters";
import { useScrollSync } from "@/shared/hooks/useScrollSync";
import { useDividerDrag } from "@/shared/hooks/useDividerDrag";
import { useFileWatcher } from "@/shared/hooks/useFileWatcher";
import { getThemeById } from "@/shared/themes";
import { Toolbar } from "./components/Toolbar";
import { FolderTabBar, TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { LeftPanel } from "@/features/file-tree/components/LeftPanel";
import { EditorPanel } from "@/features/editor/components/EditorPanel";
import { PreviewPanel } from "@/features/preview/components/PreviewPanel";
import { SearchReplace } from "@/features/search/components/SearchReplace";
import { SettingsDialog } from "@/features/settings/components/SettingsDialog";
import { Terminal } from "@/features/terminal/components/Terminal";
import { RagPanel } from "@/features/rag/components/RagPanel";
import MindmapEditor from "@/features/mindmap/components/MindmapEditor";
import { ImageCanvas } from "@/features/image/components/ImageCanvas";
import { CodeEditorPanel } from "@/features/code-editor/components/CodeEditorPanel";
import { GitDiffViewer } from "@/features/git/components/GitDiffViewer";
import { CloneDialog } from "@/features/git/components/CloneDialog";
import { ExternalChangeDialog } from "@/features/editor/components/ExternalChangeDialog";
import { AppDialog } from "@/shared/components/AppDialog";
import { showMessage, showConfirm, showPrompt } from "@/stores/dialog-store";
import type { ImageCanvasHandle } from "@/features/image/components/ImageCanvas";
import type { MindmapEditorHandle } from "@/features/mindmap/components/MindmapEditor";
import type { KityMinderJson } from "@/features/mindmap/lib/types";
import appIconUrl from "../../app-icon.svg";
import "./App.css";

const APP_TITLE = "MDium";

export function App() {
  const { t } = useTranslation();
  const initializeTheme = useSettingsStore((s) => s.initializeTheme);
  const activeTab = useTabStore((s) => s.getActiveTab());
  const openTab = useTabStore((s) => s.openTab);
  const markClean = useTabStore((s) => s.markClean);
  const updateTabFilePath = useTabStore((s) => s.updateTabFilePath);
  const openFolder = useTabStore((s) => s.openFolder);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const openFolderPaths = useTabStore((s) => s.openFolderPaths);
  const setFolderPath = useFileStore((s) => s.setFolderPath);
  const setActiveFile = useFileStore((s) => s.setActiveFile);
  const setFileTree = useFileStore((s) => s.setFileTree);
  const editorVisible = useUiStore((s) => s.editorVisible);
  const showSearch = useUiStore((s) => s.showSearch);
  const setShowSearch = useUiStore((s) => s.setShowSearch);
  const folderPanelVisible = useUiStore((s) => s.folderPanelVisible);
  const folderPanelTab = useUiStore((s) => s.folderPanelTab);
  const setFolderPanelTab = useUiStore((s) => s.setFolderPanelTab);
  const editorRatio = useUiStore((s) => s.editorRatio);
  const setEditorRatio = useUiStore((s) => s.setEditorRatio);
  const folderPanelRatio = useUiStore((s) => s.folderPanelRatio);
  const bottomTerminalVisible = useUiStore((s) => s.bottomTerminalVisible);
  const bottomTerminalTab = useUiStore((s) => s.bottomTerminalTab);
  const bottomTerminalOpenTabs = useUiStore((s) => s.bottomTerminalOpenTabs);
  const setBottomTerminalTab = useUiStore((s) => s.setBottomTerminalTab);
  const closeBottomTerminalTab = useUiStore((s) => s.closeBottomTerminalTab);
  const isZennMode = useUiStore((s) => s.isZennMode);
  const { autoSave, themeId, aiSettings } = useSettingsStore();
  const themeType = getThemeById(themeId).type;

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const mindmapEditorRef = useRef<MindmapEditorHandle>(null);
  const imageCanvasRef = useRef<ImageCanvasHandle>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);

  const [externalChange, setExternalChange] = useState<{
    tabId: string;
    filePath: string;
    currentContent: string;
    externalContent: string;
  } | null>(null);
  const [showCloneDialog, setShowCloneDialog] = useState(false);

  useScrollSync(editorRef, previewRef, editorVisible, activeTab?.id ?? "");
  const handleEditorDividerMouseDown = useDividerDrag(editorAreaRef, editorRatio, setEditorRatio);

  // Watch active tab file for external changes (e.g., opencode edits)
  useFileWatcher(activeTab?.filePath ?? null, useCallback(async (changedPath: string) => {
    if (!activeTab || activeTab.filePath !== changedPath) return;
    // Skip for .video.json — managed by the video panel's auto-save
    if (changedPath.toLowerCase().endsWith(".video.json")) return;
    try {
      const newContent = await invoke<string>("read_text_file", { path: changedPath });
      if (newContent === activeTab.content) return;

      if (activeTab.dirty) {
        setExternalChange({
          tabId: activeTab.id,
          filePath: changedPath,
          currentContent: activeTab.content,
          externalContent: newContent,
        });
      } else {
        useTabStore.getState().updateTabContent(activeTab.id, newContent);
        useTabStore.getState().markClean(activeTab.id);
      }
    } catch (e) {
      console.error("Failed to reload file after external change:", e);
    }
  }, [activeTab]));

  // Dismiss external change dialog if the associated tab is closed or switched away
  useEffect(() => {
    if (externalChange && (!activeTab || activeTab.id !== externalChange.tabId)) {
      setExternalChange(null);
    }
  }, [activeTab, externalChange]);

  // Sidebar resizing
  const [sidebarWidth, setSidebarWidth] = useState(340);
  const sidebarDragging = useRef(false);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDragging.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(600, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      sidebarDragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [sidebarWidth]);

  // Bottom terminal resizing
  const [terminalHeight, setTerminalHeight] = useState(250);
  const terminalDragging = useRef(false);

  const handleTerminalMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    terminalDragging.current = true;
    const startY = e.clientY;
    const startHeight = terminalHeight;

    const onMouseMove = (ev: MouseEvent) => {
      const newHeight = Math.max(80, Math.min(600, startHeight - (ev.clientY - startY)));
      setTerminalHeight(newHeight);
    };
    const onMouseUp = () => {
      terminalDragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [terminalHeight]);

  const {
    recentFiles,
    addRecentFile,
    recentFolders,
    addRecentFolder,
    removeRecentFolder,
  } = useRecentItems();

  const {
    showAll, activateShowAll,
    filterDocx, filterXls, filterKm, filterImages, filterPdf,
    toggleFilterDocx, toggleFilterXls, toggleFilterKm, toggleFilterImages, toggleFilterPdf,
    showDocxBtn, showXlsBtn, showKmBtn, showImagesBtn, showPdfBtn,
    handleSaveFilterVisibility,
    refreshFileTree: loadFileTree,
  } = useFileFilters(activeFolderPath, setFileTree, isZennMode);

  // Auto-save timer
  const autoSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    initializeTheme();
  }, [initializeTheme]);

  // Restore last folders on startup
  useEffect(() => {
    const restoreLastFolders = useSettingsStore.getState().restoreLastFolders;
    if (!restoreLastFolders) {
      localStorage.removeItem("mdium-tab-folders");
      return;
    }

    let persisted: any = null;
    try {
      persisted = JSON.parse(localStorage.getItem("mdium-tab-folders") ?? "null");
    } catch {
      localStorage.removeItem("mdium-tab-folders");
      return;
    }
    const folderPaths: string[] = persisted?.state?.openFolderPaths ?? [];
    const lastActiveFolderPath: string | null = persisted?.state?.activeFolderPath ?? null;

    if (folderPaths.length === 0) return;

    (async () => {
      for (const path of folderPaths) {
        try {
          const exists = await invoke<boolean>("folder_exists", { path });
          if (exists) {
            useTabStore.getState().openFolder(path);
          }
        } catch {
          // Skip this folder on IPC error
        }
      }
      // Restore active folder
      if (lastActiveFolderPath) {
        const currentFolders = useTabStore.getState().openFolderPaths;
        if (currentFolders.includes(lastActiveFolderPath)) {
          useTabStore.getState().switchFolder(lastActiveFolderPath);
        }
      }
    })();
  }, []);

  // Check for unsaved changes on app exit & stop all opencode servers
  useEffect(() => {
    const handleBeforeUnload = () => {
      useOpencodeServerStore.getState().removeAllServers();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    let unlisten: (() => void) | null = null;
    getCurrentWindow().onCloseRequested(async (e) => {
      const hasDirty = useTabStore.getState().tabs.some((tab) => tab.dirty);
      if (hasDirty) {
        const yes = await showConfirm(t("unsavedChanges"), { kind: "warning" });
        if (!yes) {
          e.preventDefault();
          return;
        }
      }
      await useOpencodeServerStore.getState().removeAllServers();
    }).then((fn) => { unlisten = fn; });

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (unlisten) unlisten();
    };
  }, []);

  // Force-hide editor for non-editable file types; normal files use per-tab state
  useEffect(() => {
    if (activeTab) {
      const isSpecialFile = activeTab.mindmapFileType || activeTab.imageFileType || activeTab.officeFileType || activeTab.isDiffTab;
      const isVideoJson = activeTab.filePath?.toLowerCase().endsWith(".video.json");
      const isCode = activeTab.isCodeFile;
      if (isSpecialFile || isVideoJson || isCode) {
        useUiStore.getState().setEditorVisible(false);
      }
      if (isVideoJson) {
        useUiStore.getState().setActiveViewTab("video");
      }
    }
  }, [activeTab?.id]);

  // Sync window title with folder path
  useEffect(() => {
    const title = activeFolderPath
      ? `${APP_TITLE} : ${activeFolderPath}`
      : APP_TITLE;
    getCurrentWindow().setTitle(title).catch(() => {});
  }, [activeFolderPath]);

  // Sync file store when switching folder tabs
  useEffect(() => {
    setFolderPath(activeFolderPath);
  }, [activeFolderPath, setFolderPath]);

  // Prefetch git state on folder change (deferred to avoid render storm)
  useEffect(() => {
    if (!activeFolderPath) return;
    const timer = setTimeout(() => {
      useGitStore.getState().refresh(activeFolderPath);
    }, 300);
    return () => clearTimeout(timer);
  }, [activeFolderPath]);

  // Detect Zenn project when folder changes
  useEffect(() => {
    if (!activeFolderPath) {
      useUiStore.getState().setZennMode(false);
      return;
    }
    invoke<{ is_zenn_project: boolean }>("detect_zenn_project", { dirPath: activeFolderPath })
      .then((info) => useUiStore.getState().setZennMode(info.is_zenn_project))
      .catch(() => useUiStore.getState().setZennMode(false));
  }, [activeFolderPath]);

  // Open folder
  const handleOpenFolder = useCallback(async () => {
    const selected = await open({ directory: true });
    if (selected && typeof selected === "string") {
      addRecentFolder(selected);
      openFolder(selected);
    }
  }, [addRecentFolder, openFolder]);

  const handleCloned = useCallback(
    (clonedPath: string) => {
      addRecentFolder(clonedPath);
      openFolder(clonedPath);
    },
    [addRecentFolder, openFolder],
  );

  const handleOpenRecentFolder = useCallback(
    async (path: string) => {
      const exists = await invoke<boolean>("folder_exists", { path });
      if (!exists) {
        await showMessage(
          t("folderNotFound", { path }),
          { title: t("error"), kind: "error" }
        );
        removeRecentFolder(path);
        return;
      }
      addRecentFolder(path);
      openFolder(path);
    },
    [addRecentFolder, removeRecentFolder, openFolder, t]
  );

  // Open file
  const handleFileSelect = useCallback(
    async (filePath: string) => {
      try {
        const fileName = filePath.split(/[\\/]/).pop() ?? "untitled";
        const officeExt = getOfficeExt(filePath);
        const mindmapExt = getMindmapExt(filePath);

        const imageExt = getImageExt(filePath);
        const pdfExt = getPdfExt(filePath);
        const csvExt = getCsvExt(filePath);

        if (pdfExt) {
          // Read PDF file as binary
          const bytes = await invoke<number[]>("read_binary_file", { path: filePath });
          const binaryData = new Uint8Array(bytes);
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content: "",
            binaryData,
            officeFileType: pdfExt,
          });
        } else if (officeExt) {
          // Read Office file as binary
          const bytes = await invoke<number[]>("read_binary_file", { path: filePath });
          const binaryData = new Uint8Array(bytes);
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content: "",
            binaryData,
            officeFileType: officeExt,
          });
        } else if (mindmapExt) {
          // Read mindmap file as binary
          const bytes = await invoke<number[]>("read_binary_file", { path: filePath });
          const binaryData = new Uint8Array(bytes);
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content: "",
            binaryData,
            mindmapFileType: mindmapExt,
          });
        } else if (imageExt) {
          // Read image file as binary and create blob URL
          const { readFile } = await import("@tauri-apps/plugin-fs");
          const bytes = await readFile(filePath);
          const mimeMap: Record<string, string> = {
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".webp": "image/webp",
          };
          const blob = new Blob([bytes], { type: mimeMap[imageExt] ?? "application/octet-stream" });
          const blobUrl = URL.createObjectURL(blob);
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content: "",
            imageFileType: imageExt,
            imageBlobUrl: blobUrl,
          });
        } else {
          const content = await invoke<string>("read_text_file", { path: filePath });
          openTab({
            filePath,
            folderPath: activeFolderPath ?? "",
            fileName,
            content,
            isCodeFile: isCodeFile(filePath),
            csvFileType: (csvExt as ".csv" | ".tsv" | null) ?? undefined,
          });
        }
        setActiveFile(filePath);
        addRecentFile(filePath);

        // Hide editor panel for non-.md files
        const isMd = filePath.toLowerCase().endsWith(".md");
        const isVideoJson = filePath.toLowerCase().endsWith(".video.json");
        useUiStore.getState().setEditorVisible((isMd || !!csvExt) && !imageExt && !isVideoJson);
        if (isVideoJson) {
          useUiStore.getState().setActiveViewTab("video");
        }
      } catch (e) {
        console.error("Failed to open file:", e);
      }
    },
    [openTab, activeFolderPath, setActiveFile, addRecentFile]
  );

  // Mindmap save callback
  const handleMindmapSave = useCallback(async (json: KityMinderJson) => {
    if (!activeTab?.filePath) return;
    try {
      const jsonStr = JSON.stringify(json, null, 2);
      await invoke("write_text_file", {
        path: activeTab.filePath,
        content: jsonStr,
      });
      markClean(activeTab.id);
    } catch (e) {
      console.error("Failed to save mindmap:", e);
    }
  }, [activeTab, markClean]);

  const handleMindmapDirtyChange = useCallback((dirty: boolean) => {
    if (!activeTab) return;
    if (dirty) {
      useTabStore.getState().updateTabContent(activeTab.id, activeTab.content);
    }
  }, [activeTab]);

  const handleImageCanvasModified = useCallback(() => {
    if (!activeTab) return;
    const json = imageCanvasRef.current?.serializeCanvas();
    if (json) {
      useTabStore.getState().updateImageCanvasState(activeTab.id, json);
    }
  }, [activeTab]);

  // Save As
  const handleSaveAs = useCallback(async () => {
    if (!activeTab) return;
    try {
      const isMindmap = !!activeTab.mindmapFileType;
      const isCode = !!activeTab.isCodeFile;
      const ext = activeTab.filePath
        ? (activeTab.filePath.split(".").pop() ?? "txt")
        : "txt";
      const defaultPath = activeTab.filePath
        ? activeTab.filePath
        : activeFolderPath ?? undefined;
      const selected = await save({
        defaultPath,
        filters: isMindmap
          ? [{ name: "Mindmap", extensions: ["km"] }]
          : isCode
            ? [{ name: "Code", extensions: [ext] }, { name: "All", extensions: ["*"] }]
            : [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!selected) return;

      let text: string;
      if (isMindmap) {
        const json = mindmapEditorRef.current?.getJson();
        if (!json) return;
        text = JSON.stringify(json, null, 2);
      } else {
        text = activeTab.content;
      }

      await invoke("write_text_file", { path: selected, content: text });
      const fileName = selected.split(/[\\/]/).pop() ?? "untitled";
      updateTabFilePath(activeTab.id, selected, fileName);
      setActiveFile(selected);
      addRecentFile(selected);
      loadFileTree();
    } catch (e) {
      console.error("Failed to save as:", e);
    }
  }, [activeTab, activeFolderPath, updateTabFilePath, setActiveFile, addRecentFile, loadFileTree]);

  // Save
  const handleSave = useCallback(async () => {
    if (!activeTab) return;
    // If untitled tab (empty filePath), redirect to "Save As"
    if (!activeTab.filePath) {
      handleSaveAs();
      return;
    }
    try {
      // For mindmaps, save via MindmapEditor
      if (activeTab.mindmapFileType) {
        const json = mindmapEditorRef.current?.getJson();
        if (json) {
          const jsonStr = JSON.stringify(json, null, 2);
          await invoke("write_text_file", {
            path: activeTab.filePath,
            content: jsonStr,
          });
        }
      } else if (activeTab.imageFileType) {
        // Image tab: save canvas as PNG to file
        const dataUrl = imageCanvasRef.current?.getCanvasDataUrl();
        if (dataUrl) {
          const base64 = dataUrl.split(",")[1];
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const { writeFile } = await import("@tauri-apps/plugin-fs");
          await writeFile(activeTab.filePath, bytes);
        }
      } else {
        await invoke("write_text_file", {
          path: activeTab.filePath,
          content: activeTab.content,
        });
      }
      markClean(activeTab.id);
      loadFileTree();
    } catch (e) {
      console.error("Failed to save:", e);
    }
  }, [activeTab, markClean, handleSaveAs, loadFileTree]);

  // New file
  const handleNewFile = useCallback(() => {
    const folderPath = activeFolderPath ?? "";
    const baseName = t("untitled");
    const state = useTabStore.getState();
    const folderTabs = state.tabs.filter((tab) => tab.folderPath === folderPath);

    // Detect placeholder tab (empty fileName)
    const placeholder = folderTabs.find((tab) => !tab.filePath && !tab.fileName);

    // If placeholder is unedited, close it (replace with a new untitled tab)
    if (placeholder && !placeholder.dirty) {
      state.closeTab(placeholder.id);
    }
    // If placeholder is being edited, name it "Untitled" and promote to a regular tab
    if (placeholder && placeholder.dirty) {
      state.updateTabFileName(placeholder.id, baseName);
    }

    // Collect used numbers from existing "Untitled", "Untitled 2", ... tabs
    const usedNumbers: number[] = [];
    // Re-fetch tabs including renamed placeholders
    const currentTabs = useTabStore.getState().tabs.filter((tab) => tab.folderPath === folderPath);
    for (const tab of currentTabs) {
      if (tab.fileName === baseName) {
        usedNumbers.push(1);
      } else if (tab.fileName.startsWith(baseName + " ")) {
        const num = parseInt(tab.fileName.slice(baseName.length + 1), 10);
        if (!isNaN(num)) usedNumbers.push(num);
      }
    }

    // Determine next available number
    let nextNumber = 1;
    while (usedNumbers.includes(nextNumber)) {
      nextNumber++;
    }
    const fileName = nextNumber === 1 ? baseName : `${baseName} ${nextNumber}`;

    openTab({
      filePath: "",
      folderPath,
      fileName,
      content: "",
    });
  }, [openTab, activeFolderPath, t]);


  // Undo/Redo (content level)
  const undoContent = useTabStore((s) => s.undoContent);
  const redoContent = useTabStore((s) => s.redoContent);

  const handleUndo = useCallback(() => {
    if (activeTab) undoContent(activeTab.id);
  }, [activeTab, undoContent]);

  const handleRedo = useCallback(() => {
    if (activeTab) redoContent(activeTab.id);
  }, [activeTab, redoContent]);

  // Refresh file tree
  const handleRefresh = useCallback(() => {
    loadFileTree();
  }, [loadFileTree]);

  // New folder
  const handleNewFolder = useCallback(async () => {
    if (!activeFolderPath) return;
    const name = await showPrompt(t("newFolder", { ns: "fileTree" }));
    if (!name?.trim()) return;
    const separator = activeFolderPath.includes("\\") ? "\\" : "/";
    const newPath = activeFolderPath + separator + name.trim();
    try {
      await invoke("create_folder", { path: newPath });
      handleRefresh();
    } catch (err) {
      console.error("Create folder failed:", err);
    }
  }, [activeFolderPath, t, handleRefresh]);

  // Image drag from file tree to editor
  const handleImageDragStart = useCallback((path: string) => {
    const ghost = document.createElement("div");
    ghost.textContent = "\uD83D\uDDBC\uFE0F " + (path.split(/[\\/]/).pop() ?? "");
    ghost.style.cssText =
      "position:fixed;pointer-events:none;z-index:9999;background:var(--bg-overlay,#333);color:var(--text,#fff);padding:4px 8px;border-radius:4px;font-size:12px;opacity:0.9;white-space:nowrap;";
    document.body.appendChild(ghost);

    const onMove = (e: MouseEvent) => {
      ghost.style.left = e.clientX + 12 + "px";
      ghost.style.top = e.clientY + 12 + "px";
    };

    const onUp = (e: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      ghost.remove();

      const textarea = editorRef.current;
      if (!textarea) return;
      const rect = textarea.getBoundingClientRect();
      if (
        e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top || e.clientY > rect.bottom
      ) return;

      try {
        const tab = useTabStore.getState().getActiveTab();
        const activeFilePath = tab?.filePath;
        let imageSrc: string;
        if (activeFilePath) {
          const activeDir = activeFilePath.replace(/[\\/][^\\/]+$/, "");
          const from = activeDir.replace(/\\/g, "/").split("/");
          const to = path.replace(/\\/g, "/").split("/");
          let common = 0;
          while (common < from.length && common < to.length && from[common] === to[common]) {
            common++;
          }
          const ups = from.length - common;
          imageSrc = [...Array(ups).fill(".."), ...to.slice(common)].join("/");
        } else {
          imageSrc = path.replace(/\\/g, "/");
        }
        const altText = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "image";
        const insertText = `![${altText}](${imageSrc})`;

        const pos = textarea.selectionStart;
        const currentContent = tab?.content ?? "";
        const newContent = currentContent.substring(0, pos) + insertText + currentContent.substring(pos);
        if (tab) {
          useTabStore.getState().updateTabContent(tab.id, newContent);
        }
      } catch {
        // ignore
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // Native OS drag-and-drop: handle image files dropped from Windows Explorer etc.
  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent(async (event) => {
      const { type } = event.payload;
      const scaleFactor = window.devicePixelRatio || 1;

      if (type === "over") {
        const payload = event.payload;
        // Highlight file tree folder on hover
        const treeListEl = document.querySelector(".file-tree__list");
        if (treeListEl) {
          const rect = treeListEl.getBoundingClientRect();
          const x = payload.position.x / scaleFactor;
          const y = payload.position.y / scaleFactor;

          // Remove previous highlights
          document.querySelectorAll(".file-tree__node--drag-over").forEach((el) => {
            el.classList.remove("file-tree__node--drag-over");
          });

          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            const elements = document.elementsFromPoint(x, y);
            for (const el of elements) {
              const nodeEl = (el as HTMLElement).closest(".file-tree__node") as HTMLElement | null;
              if (nodeEl && nodeEl.dataset.isDir === "true") {
                nodeEl.classList.add("file-tree__node--drag-over");
                break;
              }
            }
          }
        }
        return;
      }

      if (type === "leave") {
        document.querySelectorAll(".file-tree__node--drag-over").forEach((el) => {
          el.classList.remove("file-tree__node--drag-over");
        });
        return;
      }

      if (type !== "drop") return;

      const payload = event.payload;
      const { paths, position } = payload;

      // Clean up drag-over highlights
      document.querySelectorAll(".file-tree__node--drag-over").forEach((el) => {
        el.classList.remove("file-tree__node--drag-over");
      });

      // Check if drop is over the file tree
      const treeListEl = document.querySelector(".file-tree__list");
      if (treeListEl) {
        const rect = treeListEl.getBoundingClientRect();
        const x = position.x / scaleFactor;
        const y = position.y / scaleFactor;
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          // Find the tree node element under the cursor
          const elements = document.elementsFromPoint(x, y);
          let targetDir = activeFolderPath;
          for (const el of elements) {
            const nodeEl = (el as HTMLElement).closest(".file-tree__node") as HTMLElement | null;
            if (nodeEl) {
              const nodePath = nodeEl.dataset.path;
              if (nodePath) {
                const isDir = nodeEl.dataset.isDir === "true";
                const sep = nodePath.includes("\\") ? "\\" : "/";
                targetDir = isDir ? nodePath : nodePath.substring(0, nodePath.lastIndexOf(sep));
              }
              break;
            }
          }

          if (targetDir) {
            for (const filePath of paths) {
              const sep = filePath.includes("\\") ? "\\" : "/";
              const fileName = filePath.split(sep).pop()!;
              const destPath = targetDir + (targetDir.includes("\\") ? "\\" : "/") + fileName;
              try {
                await invoke("copy_file", { src: filePath, dest: destPath });
              } catch (err) {
                console.error("OS D&D copy failed:", err);
              }
            }
            handleRefresh();
          }
          return;  // Don't process as editor drop
        }
      }

      // Editor textarea drop logic
      const textarea = editorRef.current;
      if (!textarea) return;

      // Check if drop position is inside the editor textarea
      const rect = textarea.getBoundingClientRect();
      const x = position.x / scaleFactor;
      const y = position.y / scaleFactor;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;

      // Filter image files
      const imageExts = /\.(png|jpe?g|gif|bmp|svg|webp)$/i;
      const imagePaths = paths.filter((p) => imageExts.test(p));
      if (imagePaths.length === 0) return;

      try {
        const tab = useTabStore.getState().getActiveTab();
        const activeFilePath = tab?.filePath;
        const insertTexts: string[] = [];
        for (const imgPath of imagePaths) {
          let imageSrc: string;
          if (activeFilePath) {
            const activeDir = activeFilePath.replace(/[\\/][^\\/]+$/, "");
            const from = activeDir.replace(/\\/g, "/").split("/");
            const to = imgPath.replace(/\\/g, "/").split("/");
            let common = 0;
            while (common < from.length && common < to.length && from[common] === to[common]) {
              common++;
            }
            const ups = from.length - common;
            imageSrc = [...Array(ups).fill(".."), ...to.slice(common)].join("/");
          } else {
            imageSrc = imgPath.replace(/\\/g, "/");
          }
          const altText = imgPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "image";
          insertTexts.push(`![${altText}](${imageSrc})`);
        }
        const insertText = insertTexts.join("\n");
        const pos = textarea.selectionStart;
        const currentContent = tab?.content ?? "";
        const newContent = currentContent.substring(0, pos) + insertText + currentContent.substring(pos);
        if (tab) {
          useTabStore.getState().updateTabContent(tab.id, newContent);
        }
      } catch {
        // ignore
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [activeFolderPath, handleRefresh]);

  // Auto-save
  useEffect(() => {
    if (autoSaveTimerRef.current) {
      clearInterval(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (autoSave) {
      autoSaveTimerRef.current = setInterval(() => {
        const tab = useTabStore.getState().tabs.find(
          (t) => t.id === useTabStore.getState().activeTabId
        );
        // Skip untitled or unchanged tabs
        if (tab && tab.filePath && tab.dirty) {
          handleSave();
        }
      }, 30000);
    }
    return () => {
      if (autoSaveTimerRef.current) clearInterval(autoSaveTimerRef.current);
    };
  }, [autoSave, handleSave]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "z") {
        if (activeTab?.isCodeFile) return;
        if ((e.target as HTMLElement).closest?.(".oc-chat__input")) return;
        if ((e.target as HTMLElement).closest?.(".oc-rules__editor-textarea, .oc-section__textarea--agent")) return;
        e.preventDefault();
        handleUndo();
      } else if (e.ctrlKey && e.key === "y") {
        if (activeTab?.isCodeFile) return;
        if ((e.target as HTMLElement).closest?.(".oc-chat__input")) return;
        if ((e.target as HTMLElement).closest?.(".oc-rules__editor-textarea, .oc-section__textarea--agent")) return;
        e.preventDefault();
        handleRedo();
      } else if (e.ctrlKey && e.shiftKey && e.key === "S") {
        e.preventDefault();
        handleSaveAs();
      } else if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        handleSave();
      } else if (e.ctrlKey && e.key === "f") {
        if (activeTab?.isCodeFile) return;
        e.preventDefault();
        if (!showSearch) {
          useUiStore.getState().setSearchMode("search");
          setShowSearch(true);
        } else {
          setShowSearch(false);
        }
      } else if (e.ctrlKey && e.key === "h") {
        if (activeTab?.isCodeFile) return;
        e.preventDefault();
        if (!showSearch) {
          useUiStore.getState().setSearchMode("replace");
          setShowSearch(true);
        } else {
          const currentMode = useUiStore.getState().searchMode;
          if (currentMode === "search") {
            useUiStore.getState().setSearchMode("replace");
          } else {
            setShowSearch(false);
          }
        }
      } else if (e.ctrlKey && e.key === "\\") {
        e.preventDefault();
        useTabStore.getState().toggleTabEditor();
      } else if (e.ctrlKey && e.key === "t") {
        e.preventDefault();
        const ui = useUiStore.getState();
        ui.setBottomTerminalVisible(!ui.bottomTerminalVisible);
      } else if (e.ctrlKey && e.key === "d") {
        e.preventDefault();
        handleOpenFolder();
      } else if (e.ctrlKey && e.key === "o") {
        e.preventDefault();
        useUiStore.getState().setLeftPanel("opencode-config");
        useTabStore.getState().setFolderLeftPanel("opencode-config");
      } else if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        const ui = useUiStore.getState();
        ui.setBottomTerminalVisible(!ui.bottomTerminalVisible);
      } else if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        const ui = useUiStore.getState();
        if (!ui.folderPanelVisible) {
          ui.setFolderPanelVisible(true);
          ui.setFolderPanelTab("rag");
        } else if (ui.folderPanelTab !== "rag") {
          ui.setFolderPanelTab("rag");
        } else {
          ui.setFolderPanelVisible(false);
        }
      } else if (e.ctrlKey && e.key === "w") {
        e.preventDefault();
        if (activeTab) {
          if (activeTab.dirty) {
            showConfirm(t("unsavedChanges"), { kind: "warning" }).then((yes) => {
              if (yes) useTabStore.getState().closeTab(activeTab.id);
            });
            return;
          }
          useTabStore.getState().closeTab(activeTab.id);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave, handleSaveAs, handleUndo, handleRedo, showSearch, setShowSearch, handleNewFile, handleOpenFolder, activeTab, t]);


  return (
    <div className="app">
      <Toolbar
        activeFolderPath={activeFolderPath}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onOpenFolder={handleOpenFolder}
        onOpenFile={handleFileSelect}
        onUndo={handleUndo}
        onRedo={handleRedo}
        recentFiles={recentFiles}
        recentFolders={recentFolders}
        onOpenRecentFolder={handleOpenRecentFolder}
      />

      <FolderTabBar />

      <div className="app__body">
        <aside className="app__sidebar" style={{ width: sidebarWidth }}>
          <LeftPanel
            onFileSelect={handleFileSelect}
            onRefresh={handleRefresh}
            onNewFile={handleNewFile}
            onNewFolder={handleNewFolder}
            previewRef={previewRef}
            onImageDragStart={handleImageDragStart}
            showAll={showAll}
            activateShowAll={activateShowAll}
            filterDocx={filterDocx}
            filterXls={filterXls}
            filterKm={filterKm}
            filterImages={filterImages}
            filterPdf={filterPdf}
            toggleFilterDocx={toggleFilterDocx}
            toggleFilterXls={toggleFilterXls}
            toggleFilterKm={toggleFilterKm}
            toggleFilterImages={toggleFilterImages}
            toggleFilterPdf={toggleFilterPdf}
            showDocxBtn={showDocxBtn}
            showXlsBtn={showXlsBtn}
            showKmBtn={showKmBtn}
            showPdfBtn={showPdfBtn}
          />
        </aside>
        <div
          className="app__sidebar-splitter"
          onMouseDown={handleSidebarMouseDown}
        />

        <div className="app__workspace">
          <TabBar />
          <div className="app__editor-area" ref={editorAreaRef}>
            {showSearch && (
              <SearchReplace
                onClose={() => setShowSearch(false)}
              />
            )}

            {activeTab ? (
              activeTab.isDiffTab ? (
                <GitDiffViewer />
              ) : activeTab.mindmapFileType && activeTab.binaryData ? (
                <MindmapEditor
                  ref={mindmapEditorRef}
                  fileData={activeTab.binaryData}
                  fileType={activeTab.mindmapFileType}
                  filePath={activeTab.filePath}
                  theme={themeType}
                  onSave={handleMindmapSave}
                  onDirtyChange={handleMindmapDirtyChange}
                />
              ) : activeTab.imageFileType && activeTab.imageBlobUrl ? (
                <div className="app__image-area">
                  <ImageCanvas
                    ref={imageCanvasRef}
                    imageSrc={activeTab.imageBlobUrl}
                    canvasJson={activeTab.imageCanvasJson}
                    onCanvasModified={handleImageCanvasModified}
                    imageFileType={activeTab.imageFileType}
                  />
                </div>
              ) : activeTab.isCodeFile ? (
                <CodeEditorPanel />
              ) : activeTab.officeFileType ? (
                <div className="app__preview-pane">
                  <PreviewPanel
                    previewRef={previewRef}
                    onOpenFile={handleFileSelect}
                    onRefreshFileTree={loadFileTree}
                  />
                </div>
              ) : (
                <>
                  {editorVisible && (
                    <div className="app__editor-pane" style={{ flex: `0 0 ${editorRatio}%` }}>
                      <EditorPanel editorRef={editorRef} />
                    </div>
                  )}
                  {editorVisible && (
                    <div
                      className="app__divider"
                      onMouseDown={handleEditorDividerMouseDown}
                    />
                  )}
                  <div className="app__preview-pane" style={editorVisible ? { flex: 1 } : undefined}>
                    <PreviewPanel
                      previewRef={previewRef}
                      onOpenFile={handleFileSelect}
                      onRefreshFileTree={loadFileTree}
                    />
                  </div>
                </>
              )
            ) : activeFolderPath ? (
              <div className="app__welcome">
                <img src={appIconUrl} alt="MDium" className="app__welcome-icon" />
                <h1 className="app__welcome-title">MDium</h1>
                <div className="app__welcome-actions">
                  <button className="app__welcome-btn" onClick={handleNewFile}>
                    {t("createNewMdFile")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="app__welcome">
                <img src={appIconUrl} alt="MDium" className="app__welcome-icon" />
                <h1 className="app__welcome-title">MDium</h1>
                <p className="app__welcome-sub">{t("noFolderOpen")}</p>
                <div className="app__welcome-actions">
                  <button className="app__welcome-btn" onClick={handleOpenFolder}>
                    {t("openFolder")}
                  </button>
                  <button className="app__welcome-btn" onClick={() => setShowCloneDialog(true)}>
                    {t("cloneRepository")}
                  </button>
                </div>
              </div>
            )}
          </div>
          {bottomTerminalVisible && (
            <>
              <div
                className="app__bottom-terminal-divider"
                onMouseDown={handleTerminalMouseDown}
              />
              <div
                className="app__bottom-terminal"
                style={{ height: terminalHeight }}
              >
                <div className="app__bottom-terminal-toolbar">
                  <div className="app__bottom-terminal-tabs">
                    {bottomTerminalOpenTabs.map((tab) => (
                      <button
                        key={tab}
                        className={`app__bottom-terminal-tab${bottomTerminalTab === tab ? " active" : ""}`}
                        onClick={() => setBottomTerminalTab(tab)}
                      >
                        <span className="app__bottom-terminal-tab-label">
                          {tab === "terminal" ? t("terminal") : "Claude Code"}
                        </span>
                        {tab !== "terminal" && (
                          <span
                            className="app__bottom-terminal-tab-close"
                            onClick={(e) => {
                              e.stopPropagation();
                              closeBottomTerminalTab(tab);
                            }}
                          >
                            ×
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="app__bottom-terminal-actions">
                  </div>
                </div>
                <div className="app__bottom-terminal-body">
                  {bottomTerminalOpenTabs.flatMap((tab) => {
                    const folders = openFolderPaths.length > 0 ? openFolderPaths : [""];
                    return folders.map((folder) => {
                      const isActive = bottomTerminalTab === tab && (activeFolderPath ?? "") === folder;
                      const folderId = folder ? folder.replace(/[^a-zA-Z0-9]/g, "_") : "nofolder";
                      return (
                        <div
                          key={`${tab}-${folderId}`}
                          className="app__bottom-terminal-pane"
                          style={{
                            visibility: isActive ? "visible" : "hidden",
                            zIndex: isActive ? 1 : 0,
                          }}
                        >
                          <Terminal
                            id={`bottom-${tab}-${folderId}`}
                            folderPath={folder}
                            themeType={themeType}
                            active={isActive}
                            command={
                              tab === "claude-code"
                                ? "claude"
                                : undefined
                            }
                          />
                        </div>
                      );
                    });
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {folderPanelVisible && (
          <>
            <div className="app__folder-divider" />
            <div
              className="app__folder-panel"
              style={{ flex: `0 0 ${folderPanelRatio * 100}%` }}
            >
              <div className="app__folder-panel-tabs">
                <button
                  className={`app__folder-panel-tab${folderPanelTab === "rag" ? " active" : ""}`}
                  onClick={() => setFolderPanelTab("rag")}
                >
                  RAG
                  <span className="app__folder-panel-tab-model">
                    ({aiSettings.provider} / {aiSettings.model})
                  </span>
                </button>
                <button
                  className={`app__folder-panel-tab${folderPanelTab === "terminal" ? " active" : ""}`}
                  onClick={() => setFolderPanelTab("terminal")}
                >
                  {t("terminal")}
                </button>
              </div>
              <div
                className="app__folder-panel-body"
                style={{ display: folderPanelTab === "terminal" ? "flex" : "none" }}
              >
                {openFolderPaths.map((folder) => {
                  const isActive = activeFolderPath === folder;
                  const folderId = folder.replace(/[^a-zA-Z0-9]/g, "_");
                  return (
                    <div
                      key={folder}
                      style={{
                        display: isActive ? "flex" : "none",
                        width: "100%",
                        height: "100%",
                      }}
                    >
                      <Terminal
                        id={`folder-panel-${folderId}`}
                        folderPath={folder}
                        themeType={themeType}
                        active={isActive && folderPanelTab === "terminal"}
                      />
                    </div>
                  );
                })}
              </div>
              <div
                className="app__folder-panel-body"
                style={{ display: folderPanelTab === "rag" ? "flex" : "none" }}
              >
                <RagPanel
                  folderPath={activeFolderPath}
                  aiSettings={aiSettings}
                  onOpenFile={handleFileSelect}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <StatusBar />
      <SettingsDialog
        filterVisibility={{
          showDocx: showDocxBtn,
          showXls: showXlsBtn,
          showKm: showKmBtn,
          showImages: showImagesBtn,
          showPdf: showPdfBtn,
        }}
        onSaveFilterVisibility={handleSaveFilterVisibility}
      />
      {externalChange && (
        <ExternalChangeDialog
          filePath={externalChange.filePath}
          currentContent={externalChange.currentContent}
          externalContent={externalChange.externalContent}
          onAcceptExternal={() => {
            useTabStore.getState().updateTabContent(
              externalChange.tabId,
              externalChange.externalContent,
            );
            useTabStore.getState().markClean(externalChange.tabId);
            setExternalChange(null);
          }}
          onKeepCurrent={() => setExternalChange(null)}
          onClose={() => setExternalChange(null)}
        />
      )}
      <CloneDialog
        open={showCloneDialog}
        onClose={() => setShowCloneDialog(false)}
        onCloned={handleCloned}
      />
      <AppDialog />
    </div>
  );
}

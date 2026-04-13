import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { showConfirm } from "@/stores/dialog-store";
import type { FileEntry } from "@/shared/types";
import { useFileStore } from "@/stores/file-store";
import { useTabStore } from "@/stores/tab-store";
import "./FileTree.css";
import "../../table/components/ContextMenu.css";

/** Drag threshold in pixels before a mousedown becomes a drag */
const DRAG_THRESHOLD = 5;

interface FileTreeProps {
  tree: FileEntry[];
  activeFile: string | null;
  onFileSelect: (path: string) => void;
  onRefresh?: () => void;
  hasFolderOpen?: boolean;
  onImageDragStart?: (path: string) => void;
}

interface TreeNodeProps {
  entry: FileEntry;
  depth: number;
  selectedPath: string | null;
  onFileSelect: (path: string) => void;
  onNodePointerDown: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  renamingPath: string | null;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onImageDragStart?: (path: string) => void;
  onRefresh?: () => void;
  onTreeDragStart?: (entry: FileEntry, startX: number, startY: number) => void;
  dragSourcePath: string | null;
  dragOverPath: string | null;
}

interface ContextMenuInfo {
  x: number;
  y: number;
  entry: FileEntry;
}

export function getFileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".video.json")) return "🎬";
  if (lower.endsWith(".md")) return "📄";
  if (lower.endsWith(".docx")) return "📘";
  if (lower.match(/\.xls.?$/)) return "📗";
  if (lower.endsWith(".km")) return "💡";
  if (lower.endsWith(".xmind")) return "📕";
  if (lower.match(/\.(png|jpe?g|gif|bmp|svg|webp)$/)) return "🖼️";
  if (lower.endsWith(".pdf")) return "📕";
  return "📄";
}

function TreeNode({
  entry, depth, selectedPath, onFileSelect, onNodePointerDown, onContextMenu,
  renamingPath, renameValue, onRenameChange, onRenameSubmit, onRenameCancel,
  onImageDragStart, onRefresh, onTreeDragStart, dragSourcePath, dragOverPath,
}: TreeNodeProps) {
  const expanded = useFileStore((s) => s.isDirExpanded(entry.path, true));
  const toggleDir = useFileStore((s) => s.toggleDir);
  const inputRef = useRef<HTMLInputElement>(null);

  const defaultExpanded = true;

  const handleClick = useCallback(() => {
    if (renamingPath === entry.path) return;
    if (entry.is_dir) {
      toggleDir(entry.path, defaultExpanded);
    } else {
      onFileSelect(entry.path);
    }
  }, [entry, onFileSelect, toggleDir, defaultExpanded, renamingPath]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e, entry);
  }, [entry, onContextMenu]);

  const isActive = entry.path === selectedPath;
  const icon = entry.is_dir ? (expanded ? "−" : "+") : getFileIcon(entry.name);
  const isRenaming = renamingPath === entry.path;
  const isImage = !entry.is_dir && /\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(entry.name);
  const isCutTarget = useFileStore((s) => s.clipboardEntry?.mode === "cut" && s.clipboardEntry.path === entry.path);

  const isDragOver = dragOverPath === entry.path && entry.is_dir;
  const isDragging = dragSourcePath === entry.path;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isRenaming) return;
    onNodePointerDown(entry);
    if (e.button !== 0) return;
    // Image files: use existing image-to-editor drag
    if (isImage && onImageDragStart) {
      e.preventDefault();
      onImageDragStart(entry.path);
      return;
    }
    // All other items: initiate tree drag tracking
    if (onTreeDragStart) {
      onTreeDragStart(entry, e.clientX, e.clientY);
    }
  }, [isImage, isRenaming, onImageDragStart, onTreeDragStart, onNodePointerDown, entry]);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      const name = inputRef.current.value;
      const dotIndex = name.lastIndexOf(".");
      if (dotIndex > 0 && !entry.is_dir) {
        inputRef.current.setSelectionRange(0, dotIndex);
      } else {
        inputRef.current.select();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRenaming]);

  return (
    <>
      <div
        className={`file-tree__node ${isActive ? "file-tree__node--active" : ""} ${isDragOver ? "file-tree__node--drag-over" : ""} ${isDragging ? "file-tree__node--dragging" : ""}`}
        data-path={entry.path}
        data-is-dir={entry.is_dir}
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
          ...(isCutTarget ? { opacity: 0.4 } : {}),
        }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onMouseDown={handleMouseDown}
      >
        <span className="file-tree__icon">{icon}</span>
        {isRenaming ? (
          <input
            ref={inputRef}
            className="file-tree__rename-input"
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") onRenameSubmit();
              if (e.key === "Escape") onRenameCancel();
            }}
            onBlur={onRenameCancel}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="file-tree__name">{entry.name}</span>
        )}
      </div>
      {entry.is_dir && expanded && entry.children && (
        <div className="file-tree__children">
          {entry.children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onFileSelect={onFileSelect}
              onNodePointerDown={onNodePointerDown}
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              renameValue={renameValue}
              onRenameChange={onRenameChange}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              onImageDragStart={onImageDragStart}
              onRefresh={onRefresh}
              onTreeDragStart={onTreeDragStart}
              dragSourcePath={dragSourcePath}
              dragOverPath={dragOverPath}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function FileTree({
  tree, activeFile, onFileSelect, onRefresh, hasFolderOpen, onImageDragStart,
}: FileTreeProps) {
  const { t } = useTranslation("fileTree");
  const [contextMenu, setContextMenu] = useState<ContextMenuInfo | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(activeFile);

  useEffect(() => {
    setSelectedPath(activeFile);
  }, [activeFile]);

  const handleNodePointerDown = useCallback((entry: FileEntry) => {
    setSelectedPath(entry.path);
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  const clipboardEntry = useFileStore((s) => s.clipboardEntry);
  const setClipboard = useFileStore((s) => s.setClipboard);
  const clearClipboard = useFileStore((s) => s.clearClipboard);

  const handleCut = useCallback((entry: FileEntry) => {
    setClipboard(entry.path, "cut");
    setContextMenu(null);
  }, [setClipboard]);

  const handleCopy = useCallback((entry: FileEntry) => {
    setClipboard(entry.path, "copy");
    setContextMenu(null);
  }, [setClipboard]);

  const handleCopyPath = useCallback((entry: FileEntry) => {
    navigator.clipboard.writeText(entry.path);
    setContextMenu(null);
  }, []);

  const handlePaste = useCallback(async (targetEntry: FileEntry) => {
    setContextMenu(null);
    if (!clipboardEntry) return;

    const sep = clipboardEntry.path.includes("\\") ? "\\" : "/";
    const fileName = clipboardEntry.path.split(sep).pop()!;
    const targetDir = targetEntry.is_dir ? targetEntry.path : targetEntry.path.substring(0, targetEntry.path.lastIndexOf(sep));
    const destPath = targetDir + sep + fileName;

    if (destPath !== clipboardEntry.path) {
      try {
        if (clipboardEntry.mode === "cut") {
          await invoke("move_file", { src: clipboardEntry.path, dest: destPath });
          const { tabs, closeTab } = useTabStore.getState();
          for (const tab of tabs) {
            if (tab.filePath === clipboardEntry.path || tab.filePath.startsWith(clipboardEntry.path + sep)) {
              closeTab(tab.id);
            }
          }
          clearClipboard();
        } else {
          await invoke("copy_file", { src: clipboardEntry.path, dest: destPath });
        }
        onRefresh?.();
      } catch (err: unknown) {
        const msg = String(err);
        if (msg.includes("already exists")) {
          const overwrite = await showConfirm(t("overwriteConfirm", { name: fileName }), { kind: "warning" });
          if (overwrite) {
            try {
              await invoke("delete_file", { path: destPath });
              if (clipboardEntry.mode === "cut") {
                await invoke("move_file", { src: clipboardEntry.path, dest: destPath });
                clearClipboard();
                const { tabs, closeTab } = useTabStore.getState();
                for (const tab of tabs) {
                  if (tab.filePath === clipboardEntry.path || tab.filePath.startsWith(clipboardEntry.path + sep)) {
                    closeTab(tab.id);
                  }
                }
              } else {
                await invoke("copy_file", { src: clipboardEntry.path, dest: destPath });
              }
              onRefresh?.();
            } catch (e2) {
              console.error("Paste (overwrite) failed:", e2);
            }
          }
        } else {
          console.error("Paste failed:", err);
        }
      }
    }
  }, [clipboardEntry, clearClipboard, onRefresh, t]);

  const handleOpenInDefaultApp = useCallback(async (entry: FileEntry) => {
    setContextMenu(null);
    try {
      await invoke("open_in_default_app", { path: entry.path });
    } catch (err) {
      console.error("Open in default app failed:", err);
    }
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    if (contextMenu) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [contextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  const startRename = useCallback((entry: FileEntry) => {
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
    setContextMenu(null);
  }, []);

  const handleRename = useCallback(() => {
    if (!contextMenu) return;
    startRename(contextMenu.entry);
  }, [contextMenu, startRename]);

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingPath || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    const oldPath = renamingPath;
    const separator = oldPath.includes("\\") ? "\\" : "/";
    const parentDir = oldPath.substring(0, oldPath.lastIndexOf(separator));
    const newPath = parentDir + separator + renameValue.trim();

    if (newPath === oldPath) {
      setRenamingPath(null);
      return;
    }

    try {
      await invoke("rename_file", { oldPath, newPath });
      setRenamingPath(null);
      onRefresh?.();
    } catch (err) {
      console.error("Rename failed:", err);
      setRenamingPath(null);
    }
  }, [renamingPath, renameValue, onRefresh]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const deleteEntry = useCallback(async (entry: FileEntry) => {
    setContextMenu(null);

    const confirmed = await showConfirm(t("deleteConfirm", { name: entry.name }), { kind: "warning" });
    if (!confirmed) return;

    try {
      await invoke("delete_file", { path: entry.path });

      // Close tabs associated with the deleted file/folder
      const { tabs, closeTab } = useTabStore.getState();
      const separator = entry.path.includes("\\") ? "\\" : "/";
      for (const tab of tabs) {
        if (
          tab.filePath === entry.path ||
          (entry.is_dir && tab.filePath.startsWith(entry.path + separator))
        ) {
          closeTab(tab.id);
        }
      }

      onRefresh?.();
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }, [t, onRefresh]);

  const handleDelete = useCallback(async () => {
    if (!contextMenu) return;
    await deleteEntry(contextMenu.entry);
  }, [contextMenu, deleteEntry]);

  const handleOpenInNewTab = useCallback(() => {
    if (!contextMenu || !contextMenu.entry.is_dir) return;
    const { openFolder } = useTabStore.getState();
    openFolder(contextMenu.entry.path);
    setContextMenu(null);
  }, [contextMenu]);

  // Find entry by path in tree
  const findEntry = useCallback((entries: FileEntry[], path: string): FileEntry | null => {
    for (const e of entries) {
      if (e.path === path) return e;
      if (e.children) {
        const found = findEntry(e.children, path);
        if (found) return found;
      }
    }
    return null;
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (renamingPath) return;
    if (!selectedPath) return;

    const entry = findEntry(tree, selectedPath);
    if (!entry) return;

    if (e.key === "Delete") {
      e.preventDefault();
      deleteEntry(entry);
    } else if (e.key === "F2") {
      e.preventDefault();
      startRename(entry);
    } else if (e.ctrlKey && e.key === "x") {
      e.preventDefault();
      setClipboard(entry.path, "cut");
    } else if (e.ctrlKey && e.key === "c") {
      e.preventDefault();
      setClipboard(entry.path, "copy");
    } else if (e.ctrlKey && e.key === "v") {
      e.preventDefault();
      handlePaste(entry);
    }
  }, [renamingPath, selectedPath, tree, findEntry, deleteEntry, startRename, setClipboard, handlePaste]);

  // Custom mouse-based drag-and-drop (replaces HTML5 DnD for Tauri/WebView2 compatibility)
  const dragRef = useRef<{
    entry: FileEntry;
    startX: number;
    startY: number;
    dragging: boolean;
    ghost: HTMLDivElement | null;
    suppressClick: boolean;
  } | null>(null);
  const [dragSourcePath, setDragSourcePath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  const performDrop = useCallback(async (sourcePath: string, targetDir: string, isCopy: boolean) => {
    const sep = sourcePath.includes("\\") ? "\\" : "/";
    const fileName = sourcePath.split(sep).pop()!;
    const destPath = targetDir + sep + fileName;

    if (destPath === sourcePath) return;

    try {
      if (isCopy) {
        await invoke("copy_file", { src: sourcePath, dest: destPath });
      } else {
        await invoke("move_file", { src: sourcePath, dest: destPath });
        const { tabs, closeTab } = useTabStore.getState();
        for (const tab of tabs) {
          if (tab.filePath === sourcePath || tab.filePath.startsWith(sourcePath + sep)) {
            closeTab(tab.id);
          }
        }
      }
      onRefresh?.();
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes("already exists")) {
        const overwrite = await showConfirm(t("overwriteConfirm", { name: fileName }), { kind: "warning" });
        if (overwrite) {
          try {
            await invoke("delete_file", { path: destPath });
            if (isCopy) {
              await invoke("copy_file", { src: sourcePath, dest: destPath });
            } else {
              await invoke("move_file", { src: sourcePath, dest: destPath });
            }
            onRefresh?.();
          } catch (e2) {
            console.error("D&D overwrite failed:", e2);
          }
        }
      } else {
        console.error("D&D failed:", err);
      }
    }
  }, [onRefresh, t]);

  const handleTreeDragStart = useCallback((entry: FileEntry, startX: number, startY: number) => {
    dragRef.current = { entry, startX, startY, dragging: false, ghost: null, suppressClick: false };

    const onMove = (e: MouseEvent) => {
      const state = dragRef.current;
      if (!state) return;

      if (!state.dragging) {
        const dx = e.clientX - state.startX;
        const dy = e.clientY - state.startY;
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        // Threshold crossed — start drag
        state.dragging = true;
        state.suppressClick = true;
        // Prevent text selection during drag
        document.body.style.userSelect = "none";
        window.getSelection()?.removeAllRanges();
        setDragSourcePath(state.entry.path);
        const ghost = document.createElement("div");
        const icon = state.entry.is_dir ? "📁" : getFileIcon(state.entry.name);
        ghost.textContent = `${icon} ${state.entry.name}`;
        ghost.style.cssText =
          "position:fixed;pointer-events:none;z-index:9999;background:#2a2a3e;color:#e0e0e0;padding:4px 10px;border-radius:4px;font-size:12px;opacity:0.92;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:1px solid rgba(74,158,255,0.4);";
        ghost.style.left = e.clientX + 14 + "px";
        ghost.style.top = e.clientY + 14 + "px";
        document.body.appendChild(ghost);
        state.ghost = ghost;
      }

      // Update ghost position
      if (state.ghost) {
        state.ghost.style.left = e.clientX + 12 + "px";
        state.ghost.style.top = e.clientY + 12 + "px";
      }

      // Find drop target under cursor
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      let newDragOver: string | null = null;
      for (const el of elements) {
        const nodeEl = (el as HTMLElement).closest(".file-tree__node") as HTMLElement | null;
        if (nodeEl?.dataset.isDir === "true" && nodeEl.dataset.path) {
          const targetPath = nodeEl.dataset.path;
          const sep = state.entry.path.includes("\\") ? "\\" : "/";
          // Prevent dropping on self or descendant
          if (targetPath !== state.entry.path && !targetPath.startsWith(state.entry.path + sep)) {
            newDragOver = targetPath;
          }
          break;
        }
      }
      setDragOverPath(newDragOver);
    };

    const onUp = (e: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      const state = dragRef.current;
      if (!state) return;

      if (state.ghost) state.ghost.remove();
      // Restore text selection
      document.body.style.userSelect = "";

      if (state.dragging) {
        const isCopy = e.ctrlKey;
        const sourcePath = state.entry.path;
        const sep = sourcePath.includes("\\") ? "\\" : "/";

        // Find drop target
        const elements = document.elementsFromPoint(e.clientX, e.clientY);
        let targetDir: string | null = null;
        for (const el of elements) {
          const nodeEl = (el as HTMLElement).closest(".file-tree__node") as HTMLElement | null;
          if (nodeEl?.dataset.path) {
            const nodePath = nodeEl.dataset.path;
            const isDir = nodeEl.dataset.isDir === "true";
            if (nodePath === sourcePath || nodePath.startsWith(sourcePath + sep)) break;
            targetDir = isDir ? nodePath : nodePath.substring(0, nodePath.lastIndexOf(sep));
            break;
          }
        }

        // If dropped on the list but not on a specific node, use root
        if (!targetDir) {
          const treeListEl = document.querySelector(".file-tree__list");
          if (treeListEl) {
            const rect = treeListEl.getBoundingClientRect();
            if (e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom && tree.length > 0) {
              targetDir = tree[0].path.substring(0, tree[0].path.lastIndexOf(sep));
            }
          }
        }

        if (targetDir) {
          performDrop(sourcePath, targetDir, isCopy);
        }

        // Suppress the click that follows mouseup
        const onClick = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        document.addEventListener("click", onClick, { capture: true, once: true });
      }

      setDragSourcePath(null);
      setDragOverPath(null);
      dragRef.current = null;
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [tree, performDrop]);

  if (tree.length === 0) {
    return (
      <div className="file-tree__empty">
        {hasFolderOpen ? t("noFilesWithFilter") : t("noFolder")}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="file-tree" onKeyDown={handleKeyDown} tabIndex={0}>
      <div className="file-tree__list">
        {tree.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            selectedPath={selectedPath}
            onFileSelect={onFileSelect}
            onNodePointerDown={handleNodePointerDown}
            onContextMenu={handleContextMenu}
            renamingPath={renamingPath}
            renameValue={renameValue}
            onRenameChange={setRenameValue}
            onRenameSubmit={handleRenameSubmit}
            onRenameCancel={handleRenameCancel}
            onImageDragStart={onImageDragStart}
            onRefresh={onRefresh}
            onTreeDragStart={handleTreeDragStart}
            dragSourcePath={dragSourcePath}
            dragOverPath={dragOverPath}
          />
        ))}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.entry.is_dir && (
            <div className="ctx-group">
              <button onClick={handleOpenInNewTab}>
                <span className="ctx-label">{t("openInNewTab")}</span>
              </button>
            </div>
          )}
          <div className="ctx-group">
            <button onClick={() => handleOpenInDefaultApp(contextMenu.entry)}>
              <span className="ctx-label">{t("openInDefaultApp")}</span>
            </button>
          </div>
          <div className="ctx-group">
            <button onClick={() => handleCopyPath(contextMenu.entry)}>
              <span className="ctx-label">{t("copyPath")}</span>
            </button>
          </div>
          <div className="ctx-group">
            <button onClick={() => handleCut(contextMenu.entry)}>
              <span className="ctx-label">{t("cut")}</span>
              <span className="ctx-shortcut">Ctrl+X</span>
            </button>
            <button onClick={() => handleCopy(contextMenu.entry)}>
              <span className="ctx-label">{t("copy")}</span>
              <span className="ctx-shortcut">Ctrl+C</span>
            </button>
            <button
              onClick={() => handlePaste(contextMenu.entry)}
              disabled={!clipboardEntry}
              style={!clipboardEntry ? { opacity: 0.4 } : undefined}
            >
              <span className="ctx-label">{t("paste")}</span>
              <span className="ctx-shortcut">Ctrl+V</span>
            </button>
          </div>
          <div className="ctx-group">
            <button onClick={handleRename}>
              <span className="ctx-label">{t("rename")}</span>
              <span className="ctx-shortcut">F2</span>
            </button>
            <button onClick={handleDelete}>
              <span className="ctx-label">{t("delete")}</span>
              <span className="ctx-shortcut">Del</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

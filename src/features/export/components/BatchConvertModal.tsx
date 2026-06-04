import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { ConvertibleFile } from "../lib/collectConvertibleFiles";
import type { ConvertibleTreeNode } from "../lib/collectConvertibleFiles";
import {
  pruneTreeByFilter,
  pruneTreeByHasMd,
  collectFilePaths,
} from "../lib/collectConvertibleFiles";
import { useBatchConvert } from "../hooks/useBatchConvert";
import { useBatchDeleteMd } from "../hooks/useBatchDeleteMd";
import { BatchConvertTree } from "./BatchConvertTree";
import "./BatchConvertModal.css";

type FilterTab = "all" | "docx" | "pdf" | "xlsx";
type BatchMode = "convert" | "delete";

interface BatchConvertModalProps {
  files: ConvertibleFile[];
  tree: ConvertibleTreeNode[];
  onClose: () => void;
  onComplete: () => void;
}

function patchTreeWithMdiumFlags(
  nodes: ConvertibleTreeNode[],
  existsMap: Record<string, boolean>
): ConvertibleTreeNode[] {
  return nodes.map((node) => {
    if (node.isDir) {
      return {
        ...node,
        children: node.children
          ? patchTreeWithMdiumFlags(node.children, existsMap)
          : node.children,
      };
    }
    return {
      ...node,
      hasExistingMdInMdium: existsMap[node.path] ?? false,
    };
  });
}

export function BatchConvertModal({ files: propFiles, tree: propTree, onClose, onComplete }: BatchConvertModalProps) {
  const { t } = useTranslation("common");
  const { isConverting, progress, summary, convert, reset } = useBatchConvert();
  const {
    isDeleting,
    summary: deleteSummary,
    deleteMd,
    reset: resetDelete,
  } = useBatchDeleteMd();

  const [files, setFiles] = useState<ConvertibleFile[]>(() => propFiles);
  const [tree, setTree] = useState<ConvertibleTreeNode[]>(() => propTree);

  const [mode, setMode] = useState<BatchMode>("convert");
  const [filter, setFilter] = useState<FilterTab>("all");
  const [skipExisting, setSkipExisting] = useState(true);
  const [saveToMdium, setSaveToMdium] = useState(false);
  const [deleteInMdium, setDeleteInMdium] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const effectiveHasExistingMd = useCallback(
    (f: ConvertibleFile) =>
      saveToMdium ? f.hasExistingMdInMdium : f.hasExistingMdSibling,
    [saveToMdium]
  );
  const hasMdInLocation = useCallback(
    (f: ConvertibleFile) =>
      deleteInMdium ? f.hasExistingMdInMdium : f.hasExistingMdSibling,
    [deleteInMdium]
  );

  const [selected, setSelected] = useState<Set<string>>(() => {
    // Initially select all files that don't have existing .md (convert mode).
    const set = new Set<string>();
    for (const f of propFiles) {
      if (!f.hasExistingMdSibling) {
        set.add(f.path);
      }
    }
    return set;
  });

  // Fetch .mdium existence flags once when the dialog mounts.
  // propFiles is intentionally not a dep — the parent is expected to provide
  // a stable snapshot for the dialog's lifetime; patching state with flags
  // keyed to a changed propFiles would corrupt local state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    const paths = propFiles.map((f) => f.path);
    if (paths.length === 0) return;
    (async () => {
      try {
        const existsMap = await invoke<Record<string, boolean>>(
          "check_mdium_md_exists",
          { paths }
        );
        if (cancelled) return;
        setFiles((prev) =>
          prev.map((f) => ({
            ...f,
            hasExistingMdInMdium: existsMap[f.path] ?? false,
          }))
        );
        setTree((prev) => patchTreeWithMdiumFlags(prev, existsMap));
      } catch (e) {
        console.error("check_mdium_md_exists failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredTree = useMemo(() => {
    if (mode === "delete") {
      return pruneTreeByFilter(pruneTreeByHasMd(tree, deleteInMdium), filter);
    }
    return pruneTreeByFilter(tree, filter);
  }, [tree, filter, mode, deleteInMdium]);

  const totalSelected = useMemo(() => {
    if (mode === "delete") {
      return files.filter((f) => selected.has(f.path) && hasMdInLocation(f)).length;
    }
    return files.filter((f) => selected.has(f.path)).length;
  }, [files, selected, mode, hasMdInLocation]);

  const handleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const paths = collectFilePaths(filteredTree);
      for (const p of paths) {
        if (mode === "convert" && skipExisting) {
          const file = files.find((f) => f.path === p);
          if (file && effectiveHasExistingMd(file)) continue;
        }
        next.add(p);
      }
      return next;
    });
  }, [filteredTree, mode, skipExisting, files, effectiveHasExistingMd]);

  const handleDeselectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const paths = collectFilePaths(filteredTree);
      for (const p of paths) {
        next.delete(p);
      }
      return next;
    });
  }, [filteredTree]);

  const handleToggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleToggleFolder = useCallback(
    (paths: string[], select: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of paths) {
          if (mode === "convert" && skipExisting) {
            const file = files.find((f) => f.path === p);
            if (file && effectiveHasExistingMd(file)) continue;
          }
          if (select) {
            next.add(p);
          } else {
            next.delete(p);
          }
        }
        return next;
      });
    },
    [mode, skipExisting, files, effectiveHasExistingMd]
  );

  const handleConvert = useCallback(async () => {
    const selectedFiles = files.filter((f) => selected.has(f.path));
    if (selectedFiles.length === 0) return;
    await convert(selectedFiles, skipExisting, saveToMdium);
  }, [files, selected, skipExisting, saveToMdium, convert]);

  const handleDelete = useCallback(async () => {
    const selectedFiles = files.filter(
      (f) => selected.has(f.path) && hasMdInLocation(f)
    );
    setConfirmOpen(false);
    if (selectedFiles.length === 0) return;
    await deleteMd(selectedFiles, deleteInMdium);
  }, [files, selected, hasMdInLocation, deleteMd, deleteInMdium]);

  const handleClose = useCallback(() => {
    if (summary || deleteSummary) {
      onComplete();
    }
    reset();
    resetDelete();
    onClose();
  }, [summary, deleteSummary, onComplete, reset, resetDelete, onClose]);

  // Update selection when skipExisting / saveToMdium changes (convert mode).
  useEffect(() => {
    if (mode !== "convert" || !skipExisting) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of files) {
        if (effectiveHasExistingMd(f)) {
          next.delete(f.path);
        }
      }
      return next;
    });
  }, [mode, skipExisting, saveToMdium, files, effectiveHasExistingMd]);

  // Reset selection when switching modes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const set = new Set<string>();
    if (mode === "delete") {
      for (const f of files) if (hasMdInLocation(f)) set.add(f.path);
    } else {
      for (const f of files) if (!effectiveHasExistingMd(f)) set.add(f.path);
    }
    setSelected(set);
  }, [mode]);

  // Reselect all matching files when delete location toggles (delete mode).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (mode !== "delete") return;
    const set = new Set<string>();
    for (const f of files) if (hasMdInLocation(f)) set.add(f.path);
    setSelected(set);
  }, [deleteInMdium]);

  const activeSummary = mode === "delete" ? deleteSummary : summary;

  // --- Result view ---
  if (activeSummary) {
    return (
      <div className="batch-convert__overlay" onClick={handleClose}>
        <div className="batch-convert__dialog" onClick={(e) => e.stopPropagation()}>
          <div className="batch-convert__header">
            <span>{mode === "delete" ? t("batchDeleteTitle") : t("batchConvertTitle")}</span>
            <button className="batch-convert__close" onClick={handleClose}>×</button>
          </div>
          <div className="batch-convert__result-summary">
            {mode === "delete"
              ? t("batchDeleteComplete", {
                  deleted: activeSummary.success,
                  failed: activeSummary.failed,
                  skipped: activeSummary.skipped,
                })
              : t("batchConvertComplete", {
                  success: activeSummary.success,
                  failed: activeSummary.failed,
                  skipped: activeSummary.skipped,
                })}
          </div>
          <ul className="batch-convert__list">
            {activeSummary.results.map((r) => (
              <li key={r.file.path} className="batch-convert__result-item">
                <span className={`batch-convert__result-icon batch-convert__result-icon--${r.status}`}>
                  {r.status === "success" ? "✓" : r.status === "failed" ? "✗" : "–"}
                </span>
                <span className="batch-convert__result-name" title={r.mdPath || r.file.path}>
                  {r.file.name}
                </span>
                {r.error && (
                  <span className="batch-convert__result-error" title={r.error}>
                    {r.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="batch-convert__footer">
            <button className="batch-convert__btn-cancel" onClick={handleClose}>
              {t("close")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Converting view ---
  if (isConverting && progress) {
    const pct = (progress.current / progress.total) * 100;
    return (
      <div className="batch-convert__overlay">
        <div className="batch-convert__dialog" onClick={(e) => e.stopPropagation()}>
          <div className="batch-convert__header">
            <span>{t("batchConvertTitle")}</span>
          </div>
          <div className="batch-convert__progress">
            <div className="batch-convert__progress-bar">
              <div className="batch-convert__progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="batch-convert__progress-text">
              {t("batchConvertProgress", { current: progress.current, total: progress.total })}
            </div>
            <div className="batch-convert__progress-file">
              {t("batchConvertCurrentFile", { file: progress.currentFile })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Deleting view ---
  if (isDeleting) {
    return (
      <div className="batch-convert__overlay">
        <div className="batch-convert__dialog" onClick={(e) => e.stopPropagation()}>
          <div className="batch-convert__header">
            <span>{t("batchDeleteTitle")}</span>
          </div>
          <div className="batch-convert__progress">
            <div className="batch-convert__progress-text">
              {t("batchDeleteDeleting")}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Selection view ---
  return (
    <div className="batch-convert__overlay" onClick={handleClose}>
      <div className="batch-convert__dialog" onClick={(e) => e.stopPropagation()}>
        <div className="batch-convert__header">
          <span>{mode === "delete" ? t("batchDeleteTitle") : t("batchConvertTitle")}</span>
          <button className="batch-convert__close" onClick={handleClose}>×</button>
        </div>
        <div className="batch-convert__mode-switch">
          <button
            className={`batch-convert__mode-btn ${mode === "convert" ? "batch-convert__mode-btn--active" : ""}`}
            onClick={() => setMode("convert")}
          >
            {t("batchConvertModeConvert")}
          </button>
          <button
            className={`batch-convert__mode-btn ${mode === "delete" ? "batch-convert__mode-btn--active" : ""}`}
            onClick={() => setMode("delete")}
          >
            {t("batchConvertModeDelete")}
          </button>
        </div>
        <div className="batch-convert__toolbar">
          {(["all", "docx", "xlsx", "pdf"] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              className={`batch-convert__filter-btn ${filter === tab ? "batch-convert__filter-btn--active" : ""}`}
              onClick={() => setFilter(tab)}
            >
              {tab === "all" ? t("batchConvertFilterAll") : tab === "docx" ? t("batchConvertFilterDocx") : tab === "xlsx" ? t("batchConvertFilterXlsx") : t("batchConvertFilterPdf")}
            </button>
          ))}
          <span className="batch-convert__toolbar-sep" />
          <div className="batch-convert__action-btns">
            <button className="batch-convert__action-btn" onClick={handleSelectAll}>
              {t("batchConvertSelectAll")}
            </button>
            <button className="batch-convert__action-btn" onClick={handleDeselectAll}>
              {t("batchConvertDeselectAll")}
            </button>
          </div>
          {mode === "convert" ? (
            <>
              <label className="batch-convert__skip-label">
                <input
                  type="checkbox"
                  checked={saveToMdium}
                  onChange={(e) => setSaveToMdium(e.target.checked)}
                />
                {t("batchConvertSaveToMdium")}
              </label>
              <label className="batch-convert__skip-label">
                <input
                  type="checkbox"
                  checked={skipExisting}
                  onChange={(e) => setSkipExisting(e.target.checked)}
                />
                {t("batchConvertSkipExisting")}
              </label>
            </>
          ) : (
            <label className="batch-convert__skip-label">
              <input
                type="checkbox"
                checked={deleteInMdium}
                onChange={(e) => setDeleteInMdium(e.target.checked)}
              />
              {t("batchDeleteLocationMdium")}
            </label>
          )}
        </div>
        {filteredTree.length === 0 ? (
          <div className="batch-convert__empty">
            {mode === "delete" ? t("batchDeleteNoFiles") : t("batchConvertNoFiles")}
          </div>
        ) : (
          <div className="batch-convert__list">
            <BatchConvertTree
              tree={filteredTree}
              selected={selected}
              onToggleFile={handleToggle}
              onToggleFolder={handleToggleFolder}
              skipExisting={mode === "convert" ? skipExisting : false}
              saveToMdium={mode === "convert" ? saveToMdium : deleteInMdium}
            />
          </div>
        )}
        <div className="batch-convert__footer">
          <button className="batch-convert__btn-cancel" onClick={handleClose}>
            {t("cancel")}
          </button>
          {mode === "delete" ? (
            <button
              className="batch-convert__btn-delete"
              disabled={totalSelected === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {t("batchDeleteStart")} ({totalSelected})
            </button>
          ) : (
            <button
              className="batch-convert__btn-convert"
              disabled={totalSelected === 0}
              onClick={handleConvert}
            >
              {t("batchConvertStart")} ({totalSelected})
            </button>
          )}
        </div>
      </div>

      {confirmOpen && (
        <div
          className="batch-convert__overlay batch-convert__overlay--confirm"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmOpen(false);
          }}
        >
          <div
            className="batch-convert__confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="batch-convert__header">
              <span>{t("batchDeleteConfirmTitle")}</span>
            </div>
            <div className="batch-convert__confirm-message">
              {t("batchDeleteConfirmMessage", { count: totalSelected })}
            </div>
            <div className="batch-convert__footer">
              <button
                className="batch-convert__btn-cancel"
                onClick={() => setConfirmOpen(false)}
              >
                {t("cancel")}
              </button>
              <button className="batch-convert__btn-delete" onClick={handleDelete}>
                {t("batchDeleteConfirmButton")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

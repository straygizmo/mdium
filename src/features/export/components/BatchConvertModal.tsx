import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { ConvertibleFile } from "../lib/collectConvertibleFiles";
import type { ConvertibleTreeNode } from "../lib/collectConvertibleFiles";
import {
  pruneTreeByFilter,
  collectFilePaths,
} from "../lib/collectConvertibleFiles";
import { useBatchConvert } from "../hooks/useBatchConvert";
import { BatchConvertTree } from "./BatchConvertTree";
import "./BatchConvertModal.css";

type FilterTab = "all" | "docx" | "pdf" | "xlsx";

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

  const [files, setFiles] = useState<ConvertibleFile[]>(() => propFiles);
  const [tree, setTree] = useState<ConvertibleTreeNode[]>(() => propTree);

  const [filter, setFilter] = useState<FilterTab>("all");
  const [skipExisting, setSkipExisting] = useState(true);
  const [saveToMdium, setSaveToMdium] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => {
    // Initially select all files that don't have existing .md
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

  const filteredTree = useMemo(
    () => pruneTreeByFilter(tree, filter),
    [tree, filter]
  );

  const totalSelected = useMemo(() => {
    return files.filter((f) => selected.has(f.path)).length;
  }, [files, selected]);

  const handleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const paths = collectFilePaths(filteredTree);
      for (const p of paths) {
        if (skipExisting) {
          const file = files.find((f) => f.path === p);
          if (file?.hasExistingMdSibling) continue;
        }
        next.add(p);
      }
      return next;
    });
  }, [filteredTree, skipExisting, files]);

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
          if (skipExisting) {
            const file = files.find((f) => f.path === p);
            if (file?.hasExistingMdSibling) continue;
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
    [skipExisting, files]
  );

  const handleConvert = useCallback(async () => {
    const selectedFiles = files.filter((f) => selected.has(f.path));
    if (selectedFiles.length === 0) return;
    await convert(selectedFiles, skipExisting);
  }, [files, selected, skipExisting, convert]);

  const handleClose = useCallback(() => {
    if (summary) {
      onComplete();
    }
    reset();
    onClose();
  }, [summary, onComplete, reset, onClose]);

  // Update selection when skipExisting changes
  useEffect(() => {
    if (skipExisting) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const f of files) {
          if (f.hasExistingMdSibling) {
            next.delete(f.path);
          }
        }
        return next;
      });
    }
  }, [skipExisting, files]);

  // --- Result view ---
  if (summary) {
    return (
      <div className="batch-convert__overlay" onClick={handleClose}>
        <div className="batch-convert__dialog" onClick={(e) => e.stopPropagation()}>
          <div className="batch-convert__header">
            <span>{t("batchConvertTitle")}</span>
            <button className="batch-convert__close" onClick={handleClose}>×</button>
          </div>
          <div className="batch-convert__result-summary">
            {t("batchConvertComplete", {
              success: summary.success,
              failed: summary.failed,
              skipped: summary.skipped,
            })}
          </div>
          <ul className="batch-convert__list">
            {summary.results.map((r) => (
              <li key={r.file.path} className="batch-convert__result-item">
                <span className={`batch-convert__result-icon batch-convert__result-icon--${r.status}`}>
                  {r.status === "success" ? "✓" : r.status === "failed" ? "✗" : "–"}
                </span>
                <span className="batch-convert__result-name" title={r.file.path}>
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

  // --- Selection view ---
  return (
    <div className="batch-convert__overlay" onClick={handleClose}>
      <div className="batch-convert__dialog" onClick={(e) => e.stopPropagation()}>
        <div className="batch-convert__header">
          <span>{t("batchConvertTitle")}</span>
          <button className="batch-convert__close" onClick={handleClose}>×</button>
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
        </div>
        {filteredTree.length === 0 ? (
          <div className="batch-convert__empty">{t("batchConvertNoFiles")}</div>
        ) : (
          <div className="batch-convert__list">
            <BatchConvertTree
              tree={filteredTree}
              selected={selected}
              onToggleFile={handleToggle}
              onToggleFolder={handleToggleFolder}
              skipExisting={skipExisting}
            />
          </div>
        )}
        <div className="batch-convert__footer">
          <button className="batch-convert__btn-cancel" onClick={handleClose}>
            {t("cancel")}
          </button>
          <button
            className="batch-convert__btn-convert"
            disabled={totalSelected === 0}
            onClick={handleConvert}
          >
            {t("batchConvertStart")} ({totalSelected})
          </button>
        </div>
      </div>
    </div>
  );
}

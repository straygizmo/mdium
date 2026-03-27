import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ConvertibleFile } from "../lib/collectConvertibleFiles";
import { useBatchConvert } from "../hooks/useBatchConvert";
import "./BatchConvertModal.css";

type FilterTab = "all" | "docx" | "pdf";

interface BatchConvertModalProps {
  files: ConvertibleFile[];
  onClose: () => void;
  onComplete: () => void;
}

export function BatchConvertModal({ files, onClose, onComplete }: BatchConvertModalProps) {
  const { t } = useTranslation("common");
  const { isConverting, progress, summary, convert, reset } = useBatchConvert();

  const [filter, setFilter] = useState<FilterTab>("all");
  const [skipExisting, setSkipExisting] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => {
    // Initially select all files that don't have existing .md
    const set = new Set<string>();
    for (const f of files) {
      if (!f.hasExistingMd) {
        set.add(f.path);
      }
    }
    return set;
  });

  const filteredFiles = useMemo(() => {
    if (filter === "all") return files;
    return files.filter((f) => f.type === filter);
  }, [files, filter]);

  const totalSelected = useMemo(() => {
    return files.filter((f) => selected.has(f.path)).length;
  }, [files, selected]);

  const handleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of filteredFiles) {
        next.add(f.path);
      }
      return next;
    });
  }, [filteredFiles]);

  const handleDeselectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of filteredFiles) {
        next.delete(f.path);
      }
      return next;
    });
  }, [filteredFiles]);

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
          if (f.hasExistingMd) {
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
          {(["all", "docx", "pdf"] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              className={`batch-convert__filter-btn ${filter === tab ? "batch-convert__filter-btn--active" : ""}`}
              onClick={() => setFilter(tab)}
            >
              {tab === "all" ? t("batchConvertFilterAll") : tab === "docx" ? t("batchConvertFilterDocx") : t("batchConvertFilterPdf")}
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
              checked={skipExisting}
              onChange={(e) => setSkipExisting(e.target.checked)}
            />
            {t("batchConvertSkipExisting")}
          </label>
        </div>
        {filteredFiles.length === 0 ? (
          <div className="batch-convert__empty">{t("batchConvertNoFiles")}</div>
        ) : (
          <ul className="batch-convert__list">
            {filteredFiles.map((file) => (
              <li key={file.path} className="batch-convert__item">
                <input
                  type="checkbox"
                  checked={selected.has(file.path)}
                  onChange={() => handleToggle(file.path)}
                  disabled={skipExisting && file.hasExistingMd}
                />
                <span className="batch-convert__item-name" title={file.path}>
                  {file.name}
                </span>
                {file.hasExistingMd && (
                  <span className="batch-convert__item-badge">.md exists</span>
                )}
              </li>
            ))}
          </ul>
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

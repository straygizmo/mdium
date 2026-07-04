import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/stores/settings-store";
import { findDuplicateTos } from "@/shared/lib/replacement";
import type { ReplacementRule } from "@/shared/types";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { showMessage, showConfirm } from "@/stores/dialog-store";
import { useTabStore } from "@/stores/tab-store";
import { useFileStore } from "@/stores/file-store";
import { collectMdPaths, runBulkReplace } from "../lib/bulk-replace";
import { parseRulesCsv, mergeRules, exportRulesCsv } from "../lib/rules-csv";
import "./ReplacementPanel.css";

export function ReplacementPanel() {
  const { t } = useTranslation("replacement");
  const replacement = useSettingsStore((s) => s.replacement);
  const setReplacement = useSettingsStore((s) => s.setReplacement);
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const [bulkRunning, setBulkRunning] = useState(false);

  const duplicateTos = findDuplicateTos(replacement.rules);

  const hasActiveRules = replacement.enabled &&
    replacement.rules.some((r) => r.enabled && r.from && r.to);

  const updateRule = (id: string, patch: Partial<ReplacementRule>) => {
    setReplacement({
      ...replacement,
      rules: replacement.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  };

  const addRule = () => {
    setReplacement({
      ...replacement,
      rules: [
        ...replacement.rules,
        { id: crypto.randomUUID(), from: "", to: "", enabled: true },
      ],
    });
  };

  const deleteRule = (id: string) => {
    setReplacement({
      ...replacement,
      rules: replacement.rules.filter((r) => r.id !== id),
    });
  };

  const handleImportCsv = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const raw = await invoke<string>("read_text_file_auto_encoding", { path: selected });
      const { rows, errors } = parseRulesCsv(raw);
      const { rules, added, updated } = mergeRules(replacement.rules, rows);
      setReplacement({ ...replacement, rules });
      let msg = t("importResult", { added, updated, errors: errors.length });
      if (errors.length > 0) {
        const lines = errors.slice(0, 10).map((err) =>
          t("importErrorLine", {
            line: err.line,
            reason: t(err.reason === "columnCount" ? "reasonColumnCount" : "reasonBoolValue"),
          }),
        );
        msg += "\n" + lines.join("\n");
      }
      await showMessage(msg, { kind: errors.length > 0 ? "warning" : "info" });
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  };

  const handleExportCsv = async () => {
    const path = await save({
      defaultPath: "replacement-rules.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    try {
      // BOM so Excel opens the UTF-8 file with correct Japanese text.
      await invoke("write_text_file", { path, content: "\uFEFF" + exportRulesCsv(replacement.rules) });
      await showMessage(t("exportDone"));
    } catch (e) {
      await showMessage(String(e), { kind: "error" });
    }
  };

  const handleBulk = async (direction: "forward" | "reverse") => {
    if (!activeFolderPath) {
      await showMessage(t("noFolder"), { kind: "warning" });
      return;
    }
    const tree = useFileStore.getState().fileTrees[activeFolderPath] ?? [];
    const allPaths = collectMdPaths(tree);
    // Files with unsaved editor changes are excluded: rewriting them on disk
    // would silently lose the user's in-memory edits on the next save.
    const dirtyPaths = new Set(
      useTabStore.getState().tabs
        .filter((tab) => tab.dirty && tab.filePath)
        .map((tab) => tab.filePath as string),
    );
    const paths = allPaths.filter((p) => !dirtyPaths.has(p));
    const skippedDirty = allPaths.length - paths.length;
    if (paths.length === 0) {
      await showMessage(t("bulkNoTargets"), { kind: "warning" });
      return;
    }
    const ok = await showConfirm(
      t("bulkConfirm", { folder: activeFolderPath, count: paths.length }),
      { kind: "warning" },
    );
    if (!ok) return;

    setBulkRunning(true);
    try {
      const summary = await runBulkReplace(paths, replacement, direction);

      // Reload clean tabs whose file was rewritten so the editor shows the
      // new on-disk content.
      const changed = new Set(summary.changedPaths);
      for (const tab of useTabStore.getState().tabs) {
        if (tab.filePath && changed.has(tab.filePath) && !tab.dirty) {
          try {
            const content = await invoke<string>("read_text_file", { path: tab.filePath });
            useTabStore.getState().updateTabContent(tab.id, content);
            useTabStore.getState().markClean(tab.id);
          } catch {
            // Tab reload is best-effort; the file itself was already rewritten.
          }
        }
      }

      const lines = [
        t("bulkDone", {
          files: summary.changedPaths.length,
          replacements: summary.totalReplacements,
        }),
      ];
      if (skippedDirty > 0) lines.push(t("bulkSkippedDirty", { count: skippedDirty }));
      if (summary.failed.length > 0) lines.push(t("bulkFailed", { count: summary.failed.length }));
      lines.push(t("ragReindexNote"));
      await showMessage(lines.join("\n"));
    } finally {
      setBulkRunning(false);
    }
  };

  return (
    <div className="replacement-panel">
      <p className="replacement-panel__guidance">{t("guidance")}</p>

      <div className="replacement-panel__header">
        <label className="replacement-panel__toggle">
          <input
            type="checkbox"
            checked={replacement.enabled}
            onChange={(e) => setReplacement({ ...replacement, enabled: e.target.checked })}
          />
          {t("enabled")}
        </label>
        <button className="replacement-panel__btn" onClick={addRule}>
          + {t("addRule")}
        </button>
      </div>

      <div className="replacement-panel__rules">
        {replacement.rules.map((rule) => (
          <div className="replacement-panel__rule" key={rule.id}>
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
            />
            <input
              type="text"
              className={`replacement-panel__input${rule.from === "" ? " replacement-panel__input--invalid" : ""}`}
              value={rule.from}
              placeholder={t("fromPlaceholder")}
              onChange={(e) => updateRule(rule.id, { from: e.target.value })}
            />
            <span className="replacement-panel__arrow">→</span>
            <input
              type="text"
              className="replacement-panel__input"
              value={rule.to}
              placeholder={t("toPlaceholder")}
              onChange={(e) => updateRule(rule.id, { to: e.target.value })}
            />
            <button
              className="replacement-panel__icon-btn"
              onClick={() => deleteRule(rule.id)}
              title={t("deleteRule")}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {duplicateTos.map((to) => (
        <p className="replacement-panel__warning" key={to}>
          ⚠ {t("duplicateToWarning", { value: to })}
        </p>
      ))}

      <div className="replacement-panel__section">
        <span className="replacement-panel__section-title">{t("sectionCsv")}</span>
        <div className="replacement-panel__row">
          <button className="replacement-panel__btn" onClick={handleImportCsv}>
            {t("importCsv")}
          </button>
          <button className="replacement-panel__btn" onClick={handleExportCsv}>
            {t("exportCsv")}
          </button>
        </div>
      </div>

      <div className="replacement-panel__section">
        <span className="replacement-panel__section-title">{t("sectionBulk")}</span>
        <div className="replacement-panel__row">
          <button
            className="replacement-panel__btn"
            disabled={bulkRunning || !hasActiveRules}
            onClick={() => handleBulk("forward")}
          >
            {t("bulkForward")}
          </button>
          <button
            className="replacement-panel__btn"
            disabled={bulkRunning || !hasActiveRules}
            onClick={() => handleBulk("reverse")}
          >
            {t("bulkReverse")}
          </button>
        </div>
        <p className="replacement-panel__note">{t("ragReindexNote")}</p>
      </div>
    </div>
  );
}

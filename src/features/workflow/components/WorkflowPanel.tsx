import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/stores/tab-store";
import { showConfirm, showMessage, showPrompt } from "@/stores/dialog-store";
import type { Provider, StoreWarning, Workflow, WorkflowInput } from "@/shared/types/workflow";
import { formatCode, formatCommandError } from "../lib/format";
import { workflowApi } from "../lib/workflow-api";
import { useWorkflowStore } from "../workflow-store";
import { CreateTaskDialog } from "./CreateTaskDialog";
import { useSafetyConfirm } from "./SafetyNoticeDialog";
import { WorkflowEditDialog } from "./WorkflowEditDialog";
import "./WorkflowPanel.css";

const PROVIDERS: readonly Provider[] = ["codex", "copilot", "opencode", "claude"];

/** Schema version of the workflows file written by the UI. */
const WORKFLOWS_SCHEMA_VERSION = 1;

interface WorkflowPanelProps {
  /** Replaces the built-in task creation dialog. */
  onCreateTask?: () => void;
  /** Replaces the built-in workflow edit dialog. */
  onEditWorkflow?: (workflow: Workflow) => void;
  /**
   * Asked before a workflow is enabled; resolves false to keep it disabled.
   * Defaults to the safety notice shown until the user accepts it once.
   */
  confirmEnable?: (workflow: Workflow) => Promise<boolean>;
}

/** Missing `.gitignore` lines reported for one project root. */
interface GitignoreNotice {
  root: string;
  missing: string[];
}

/** How long the copy button shows "copied". */
const COPIED_RESET_MS = 2000;

/** localStorage key remembering that the ignore suggestion was dismissed for a root. */
const gitignoreDismissedKey = (root: string) => `mdium-workflow-gitignore-dismissed:${root}`;

/** Whether the ignore suggestion was dismissed for `root`; unreadable storage counts as not dismissed. */
function isGitignoreDismissed(root: string): boolean {
  try {
    return localStorage.getItem(gitignoreDismissedKey(root)) === "1";
  } catch {
    return false;
  }
}

/** Remembers the dismissal; a storage failure only means the suggestion returns later. */
function rememberGitignoreDismissed(root: string): void {
  try {
    localStorage.setItem(gitignoreDismissedKey(root), "1");
  } catch {
    // The notice is still hidden for this session of the panel.
  }
}

/** Localizes a store warning (`STORE_*` code plus an optional `: detail`). */
function formatWarning(warning: StoreWarning): string {
  const match = /^([A-Z][A-Z0-9_]*)(?::\s*(.*))?$/s.exec(warning.message);
  if (!match) return warning.message;
  const [, code, detail] = match;
  return detail ? `${formatCode(code)} ${detail}` : formatCode(code);
}

/** Left panel of the workflows view: workflow list, warnings and board filters. */
export function WorkflowPanel({ onCreateTask, onEditWorkflow, confirmEnable: confirmEnableProp }: WorkflowPanelProps) {
  const { t } = useTranslation("workflow");
  const activeFolderPath = useTabStore((s) => s.activeFolderPath);
  const activeRoot = useWorkflowStore((s) => s.activeRoot);
  const attachError = useWorkflowStore((s) => s.attachError);
  const project = useWorkflowStore((s) => (s.activeRoot ? s.projects[s.activeRoot] : undefined));
  const filters = useWorkflowStore((s) => s.filters);
  const setFilters = useWorkflowStore((s) => s.setFilters);
  const [provider, setProvider] = useState<Provider>("codex");
  const [busy, setBusy] = useState(false);
  /** Workflow shown in the built-in edit dialog. */
  const [editing, setEditing] = useState<Workflow | null>(null);
  /** Whether the built-in task creation dialog is open. */
  const [creating, setCreating] = useState(false);
  /** Synchronous guard: only one workflow operation runs at a time. */
  const busyRef = useRef(false);
  const safety = useSafetyConfirm();
  const confirmEnable = confirmEnableProp ?? safety.confirmEnable;
  /** Ignore rules to suggest; cleared when dismissed. */
  const [gitignore, setGitignore] = useState<GitignoreNotice | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCopiedTimer = () => {
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = null;
  };

  useEffect(() => clearCopiedTimer, []);

  // Dialogs belong to the project they were opened for.
  const cancelSafety = safety.cancel;
  useEffect(() => {
    setEditing(null);
    setCreating(false);
    cancelSafety();
  }, [activeRoot, cancelSafety]);

  const workflows = project?.workflows ?? [];
  /** Ids of the enabled workflows; the ignore rules are checked whenever this set changes. */
  const enabledKey = workflows
    .filter((w) => w.enabled && !w.archived)
    .map((w) => w.id)
    .sort()
    .join("\n");

  // Suggest ignore rules for the run data while any workflow is enabled.
  useEffect(() => {
    setGitignore(null);
    setCopied(false);
    if (!activeRoot || !enabledKey || isGitignoreDismissed(activeRoot)) return;
    let cancelled = false;
    workflowApi
      .gitignoreStatus(activeRoot)
      .then(({ missing }) => {
        if (!cancelled && missing.length > 0) setGitignore({ root: activeRoot, missing });
      })
      // The suggestion is advisory: without a status nothing is shown.
      .catch((err: unknown) => console.warn("[workflow] gitignore status failed", err));
    return () => {
      cancelled = true;
    };
  }, [activeRoot, enabledKey]);

  /** Workflows listed in the panel and in the workflow filter. */
  const visibleWorkflows = workflows.filter((w) => filters.showArchived || !w.archived);
  const filterMissing =
    !!project?.loaded && filters.workflowId !== null && !visibleWorkflows.some((w) => w.id === filters.workflowId);

  // Keep the workflow filter valid: fall back to "all" when its workflow is no longer listed.
  useEffect(() => {
    if (filterMissing) setFilters({ workflowId: null });
  }, [filterMissing, setFilters]);

  if (!activeFolderPath) {
    return (
      <div className="workflow-panel">
        <p className="workflow-panel__message">{t("noFolder")}</p>
      </div>
    );
  }

  const warnings = [...(project?.workflowWarnings ?? []), ...(project?.taskWarnings ?? [])];

  /** Runs one workflow operation at a time so saves never start from a stale list. */
  const withBusy = async (fn: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /**
   * Saves the latest loaded workflows with the patch `change(latest)` returns
   * applied to the workflow (null removes it).
   */
  const saveChange = (id: string, change: (latest: Workflow) => Partial<Workflow> | null) =>
    useWorkflowStore.getState().run(
      t("panel.saveFailed"),
      (root) => {
        const current = useWorkflowStore.getState().projects[root]?.workflows ?? [];
        const next: WorkflowInput[] = current.flatMap((w) => {
          if (w.id !== id) return [w];
          const patch = change(w);
          return patch ? [{ ...w, ...patch }] : [];
        });
        return workflowApi.saveWorkflows(root, { schemaVersion: WORKFLOWS_SCHEMA_VERSION, workflows: next });
      },
      // Workflow file saves emit no change events.
      { refreshNow: true },
    );

  /** Confirmation text, with the number of runs in progress when there are any; null on failure. */
  const confirmText = async (workflow: Workflow, key: "panel.archiveConfirm" | "panel.deleteConfirm") => {
    const root = useWorkflowStore.getState().activeRoot;
    if (!root) return null;
    let count: number;
    try {
      count = await workflowApi.activeRunCount(root, workflow.id);
    } catch (err) {
      void showMessage(formatCommandError(err), { title: t("panel.runCountFailed"), kind: "error" });
      return null;
    }
    const text = t(key, { name: workflow.name });
    return count > 0 ? `${text}\n${t("panel.activeRuns", { count })}` : text;
  };

  const toggleEnabled = (workflow: Workflow) =>
    withBusy(async () => {
      if (!workflow.enabled && !(await confirmEnable(workflow))) return;
      await saveChange(workflow.id, (latest) => ({ enabled: !latest.enabled }));
    });

  const archive = (workflow: Workflow) =>
    withBusy(async () => {
      const text = await confirmText(workflow, "panel.archiveConfirm");
      if (text === null || !(await showConfirm(text, { kind: "warning" }))) return;
      await saveChange(workflow.id, () => ({ archived: true }));
    });

  const restore = (workflow: Workflow) => withBusy(() => saveChange(workflow.id, () => ({ archived: false })));

  const remove = (workflow: Workflow) =>
    withBusy(async () => {
      const text = await confirmText(workflow, "panel.deleteConfirm");
      if (text === null || !(await showConfirm(text, { kind: "warning" }))) return;
      await saveChange(workflow.id, () => null);
    });

  const addStandard = () =>
    withBusy(async () => {
      const name = await showPrompt(t("panel.addStandardPrompt"), {
        title: t("panel.addStandard"),
        defaultValue: t("template.standardName"),
      });
      if (!name?.trim()) return;
      await useWorkflowStore
        .getState()
        .run(t("panel.addFailed"), (root) => workflowApi.addStandard(root, name.trim(), provider), { refreshNow: true });
    });

  const copyGitignore = async (missing: string[]) => {
    try {
      await navigator.clipboard.writeText(`${missing.join("\n")}\n`);
      setCopied(true);
      clearCopiedTimer();
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, COPIED_RESET_MS);
    } catch {
      void showMessage(t("gitignore.copyFailed"), { kind: "error" });
    }
  };

  const dismissGitignore = (root: string) => {
    rememberGitignoreDismissed(root);
    setGitignore(null);
  };

  const openCreate = onCreateTask ?? (() => setCreating(true));
  const openEdit = onEditWorkflow ?? setEditing;

  return (
    <div className="workflow-panel">
      {editing && (
        <WorkflowEditDialog workflow={editing} confirmEnable={confirmEnable} onClose={() => setEditing(null)} />
      )}
      {safety.dialog}
      {creating && (
        <CreateTaskDialog
          onClose={() => setCreating(false)}
          onAddStandard={() => {
            setCreating(false);
            void addStandard();
          }}
        />
      )}
      {attachError && (
        <p className="workflow-panel__error" role="alert">
          {attachError}
        </p>
      )}
      {project?.error && (
        <p className="workflow-panel__error" role="alert">
          {project.error}
        </p>
      )}
      {activeRoot && (
        <>
          <button type="button" className="workflow-panel__btn workflow-panel__btn--primary" onClick={openCreate}>
            {t("panel.newTask")}
          </button>

          {gitignore?.root === activeRoot && (
            <section className="workflow-panel__gitignore" aria-labelledby="workflow-panel-gitignore-title">
              <h3 id="workflow-panel-gitignore-title" className="workflow-panel__heading">
                {t("gitignore.title")}
              </h3>
              <p className="workflow-panel__message">{t("gitignore.description")}</p>
              <pre className="workflow-panel__gitignore-lines">{gitignore.missing.join("\n")}</pre>
              <div className="workflow-panel__gitignore-actions">
                <button type="button" className="workflow-panel__btn" onClick={() => void copyGitignore(gitignore.missing)}>
                  {t(copied ? "gitignore.copied" : "gitignore.copy")}
                </button>
                <button type="button" className="workflow-panel__btn" onClick={() => dismissGitignore(gitignore.root)}>
                  {t("gitignore.dismiss")}
                </button>
              </div>
            </section>
          )}

          <section className="workflow-panel__section">
            <h3 className="workflow-panel__heading">{t("panel.workflows")}</h3>
            {project?.loading && <p className="workflow-panel__message">{t("loading")}</p>}
            {project?.loaded && visibleWorkflows.length === 0 && (
              <p className="workflow-panel__message">{t("panel.empty")}</p>
            )}
            <ul className="workflow-panel__list">
              {visibleWorkflows.map((w) => (
                <li
                  key={w.id}
                  className={`workflow-panel__workflow${w.archived ? " workflow-panel__workflow--archived" : ""}`}
                  data-workflow-id={w.id}
                >
                  <div className="workflow-panel__workflow-head">
                    <label className="workflow-panel__toggle">
                      <input
                        type="checkbox"
                        data-switch
                        checked={w.enabled}
                        disabled={busy || w.archived}
                        aria-label={t("panel.enabled")}
                        onChange={() => void toggleEnabled(w)}
                      />
                    </label>
                    <span className="workflow-panel__workflow-name" title={w.name}>
                      {w.name}
                    </span>
                    {w.archived && <span className="workflow-panel__badge">{t("panel.archived")}</span>}
                  </div>
                  <div
                    className="workflow-panel__providers"
                    title={w.stages.map((s) => `${t(`role.${s.role}`)}: ${t(`provider.${s.provider}`)}`).join("\n")}
                  >
                    {w.stages.map((s) => t(`provider.${s.provider}`)).join(" / ")}
                  </div>
                  <div className="workflow-panel__workflow-actions">
                    <button type="button" className="workflow-panel__btn" disabled={busy} onClick={() => openEdit(w)}>
                      {t("panel.edit")}
                    </button>
                    {w.archived ? (
                      <>
                        <button type="button" className="workflow-panel__btn" disabled={busy} onClick={() => void restore(w)}>
                          {t("panel.restore")}
                        </button>
                        <button type="button" className="workflow-panel__btn" disabled={busy} onClick={() => void remove(w)}>
                          {t("panel.delete")}
                        </button>
                      </>
                    ) : (
                      <button type="button" className="workflow-panel__btn" disabled={busy} onClick={() => void archive(w)}>
                        {t("panel.archive")}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="workflow-panel__add">
              <select
                className="workflow-panel__provider-select"
                aria-label={t("panel.provider")}
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {t(`provider.${p}`)}
                  </option>
                ))}
              </select>
              <button type="button" className="workflow-panel__btn" disabled={busy} onClick={() => void addStandard()}>
                {t("panel.addStandard")}
              </button>
            </div>
          </section>

          {warnings.length > 0 && (
            <details className="workflow-panel__warnings">
              <summary>{t("panel.warnings", { count: warnings.length })}</summary>
              <ul className="workflow-panel__warning-list">
                {warnings.map((w, i) => (
                  <li key={`${w.file}-${i}`} className="workflow-panel__warning">
                    <span className="workflow-panel__warning-file">{w.file}</span>
                    <span className="workflow-panel__warning-message">{formatWarning(w)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <section className="workflow-panel__section">
            <h3 className="workflow-panel__heading">{t("panel.filters")}</h3>
            <label className="workflow-panel__field">
              <span>{t("panel.filterWorkflow")}</span>
              <select
                className="workflow-panel__workflow-filter"
                value={filters.workflowId ?? ""}
                onChange={(e) => setFilters({ workflowId: e.target.value || null })}
              >
                <option value="">{t("panel.filterAll")}</option>
                {visibleWorkflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="workflow-panel__toggle">
              <input
                type="checkbox"
                data-switch
                name="showArchived"
                checked={filters.showArchived}
                onChange={(e) => setFilters({ showArchived: e.target.checked })}
              />
              <span>{t("panel.showArchived")}</span>
            </label>
            <label className="workflow-panel__toggle">
              <input
                type="checkbox"
                data-switch
                name="showCancelled"
                checked={filters.showCancelled}
                onChange={(e) => setFilters({ showCancelled: e.target.checked })}
              />
              <span>{t("panel.showCancelled")}</span>
            </label>
          </section>
        </>
      )}
    </div>
  );
}

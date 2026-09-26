import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CommandError,
  IssueTracking,
  Provider,
  ProviderProbe,
  Role,
  Stage,
  Workflow,
  WorkflowInput,
} from "@/shared/types/workflow";
import { trapTab, useDialogFocus } from "../lib/dialog-focus";
import { isCommandError, isRecord } from "../lib/errors";
import { formatCode, formatCommandError } from "../lib/format";
import { workflowApi } from "../lib/workflow-api";
import { useWorkflowStore } from "../workflow-store";
import "./WorkflowEditDialog.css";

const PROVIDERS: readonly Provider[] = ["codex", "copilot", "opencode", "claude"];
const ROLES: readonly Role[] = ["design", "implement", "review"];
const RETURN_TARGETS: readonly Role[] = ["design", "implement"];
const ISSUE_TRACKING: readonly IssueTracking[] = ["auto", "off"];
const AVAILABILITY_KINDS = new Set(["missing", "unauthenticated", "too_old", "error"]);

/** Schema version of the workflows file written by the UI. */
const WORKFLOWS_SCHEMA_VERSION = 1;

/** Path template filled in when saving the design document is switched on. */
export const DEFAULT_DESIGN_DOC_PATH = "docs/designs/{date}-{slug}-design.md";

const STORE_INVALID = "STORE_INVALID";
const WORKFLOW_NOT_FOUND = "WORKFLOW_NOT_FOUND";

/** Machine code shape used by the backend (`WORKFLOW_NAME_EMPTY`, ...). */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/;

export interface ValidationIssue {
  code: string;
  detail: string | null;
}

/**
 * Extracts the validation codes from a `STORE_INVALID` message, which the
 * backend formats as `STORE_INVALID: [CODE, CODE: detail, ...]`.
 */
export function parseValidationErrors(message: string): ValidationIssue[] {
  const list = /\[(.*)\]\s*$/s.exec(message);
  if (!list) return [];
  // Split only before the next code, so details containing ", " stay intact.
  return list[1]
    .split(/,\s(?=[A-Z][A-Z0-9_]+(?::\s|,\s|$))/)
    .map((part) => /^([A-Z][A-Z0-9_]+)(?::\s(.*))?$/s.exec(part.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(([, code, detail]) => ({ code, detail: detail ?? null }));
}

/** Localized reason a provider cannot be used, or null when it is available. */
function unavailableReason(result: unknown, t: (key: string) => string): string | null {
  if (!isRecord(result)) return t("edit.availability.error");
  const kind = typeof result.kind === "string" ? result.kind : "";
  if (kind === "available") return null;
  const detail = typeof result.detail === "string" ? result.detail : "";
  const label = AVAILABILITY_KINDS.has(kind) ? t(`edit.availability.${kind}`) : formatCode(kind);
  return CODE_PATTERN.test(detail) ? `${label}: ${formatCode(detail)}` : label;
}

/** Parses a number field; an empty or invalid value becomes 0 (rejected by validation). */
function toCount(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

interface WorkflowEditDialogProps {
  workflow: Workflow;
  /** Asked before a disabled workflow is enabled; resolves false to keep it disabled. */
  confirmEnable(workflow: Workflow): Promise<boolean>;
  onClose(): void;
}

/** Edits one workflow and saves it in place of the stored one. */
export function WorkflowEditDialog({ workflow, confirmEnable, onClose }: WorkflowEditDialogProps) {
  const { t } = useTranslation("workflow");
  const [draft, setDraft] = useState<Workflow>(workflow);
  const [availability, setAvailability] = useState<Partial<Record<Provider, string | null>>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const confirmingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogFocus(dialogRef, true);

  useEffect(() => {
    let cancelled = false;
    workflowApi
      .probeProviders()
      .then((probes: ProviderProbe[]) => {
        if (cancelled) return;
        const next: Partial<Record<Provider, string | null>> = {};
        for (const probe of probes) next[probe.provider] = unavailableReason(probe.result, t);
        setAvailability(next);
      })
      // Without a probe result the options are simply shown without availability.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [t]);

  const patch = (p: Partial<Workflow>) => setDraft((d) => ({ ...d, ...p }));
  const patchStage = (role: Role, p: Partial<Stage>) =>
    setDraft((d) => ({ ...d, stages: d.stages.map((s) => (s.role === role ? { ...s, ...p } : s)) }));

  const toggleEnabled = async (checked: boolean) => {
    if (!checked || workflow.enabled) {
      patch({ enabled: checked });
      return;
    }
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    try {
      if (await confirmEnable({ ...draft, enabled: true })) patch({ enabled: true });
    } finally {
      confirmingRef.current = false;
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setErrors([]);
    const saved: Workflow = {
      ...draft,
      stages: draft.stages.map((s) => ({ ...s, model: s.model?.trim() ? s.model.trim() : null })),
    };
    const ok = await useWorkflowStore.getState().run(t("panel.saveFailed"), async (root) => {
      const current = useWorkflowStore.getState().projects[root]?.workflows ?? [];
      if (!current.some((w) => w.id === saved.id)) {
        const missing: CommandError = { code: WORKFLOW_NOT_FOUND, message: saved.id };
        throw missing;
      }
      // Keep the latest archived flag: it is not edited here.
      const workflows: WorkflowInput[] = current.map((w) => (w.id === saved.id ? { ...saved, archived: w.archived } : w));
      try {
        await workflowApi.saveWorkflows(root, { schemaVersion: WORKFLOWS_SCHEMA_VERSION, workflows });
      } catch (err) {
        if (!isCommandError(err) || err.code !== STORE_INVALID) throw err;
        const issues = parseValidationErrors(err.message);
        setErrors(
          issues.length > 0
            ? issues.map((i) => (i.detail ? `${formatCode(i.code)} (${i.detail})` : formatCode(i.code)))
            : [formatCommandError(err)],
        );
        return false;
      }
      return true;
    });
    setSaving(false);
    if (ok) onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else trapTab(e, dialogRef.current);
  };

  const providerLabel = (provider: Provider) => {
    const name = t(`provider.${provider}`);
    const reason = availability[provider];
    return reason ? t("edit.unavailable", { provider: name, reason }) : name;
  };

  const stages = ROLES.flatMap((role) => draft.stages.filter((s) => s.role === role));

  return (
    <div
      className="workflow-edit-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="workflow-edit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-edit-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h3 id="workflow-edit-title" className="workflow-edit__title">
          {t("edit.title")}
        </h3>
        <div className="workflow-edit__body">
          <label className="workflow-edit__field">
            <span>{t("edit.name")}</span>
            <input type="text" name="name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="workflow-edit__toggle">
            <input
              type="checkbox"
              data-switch
              name="enabled"
              checked={draft.enabled}
              onChange={(e) => void toggleEnabled(e.target.checked)}
            />
            <span>{t("edit.enabled")}</span>
          </label>

          <h4 className="workflow-edit__heading">{t("edit.stages")}</h4>
          {stages.map((s) => (
            <fieldset key={s.role} className="workflow-edit__stage" data-stage-role={s.role}>
              <legend className="workflow-edit__legend">{t(`role.${s.role}`)}</legend>
              <label className="workflow-edit__field">
                <span>{t("edit.stageName")}</span>
                <input
                  type="text"
                  name={`${s.role}.name`}
                  value={s.name}
                  onChange={(e) => patchStage(s.role, { name: e.target.value })}
                />
              </label>
              <div className="workflow-edit__row">
                <label className="workflow-edit__field">
                  <span>{t("edit.provider")}</span>
                  <select
                    name={`${s.role}.provider`}
                    value={s.provider}
                    onChange={(e) => patchStage(s.role, { provider: e.target.value as Provider })}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {providerLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="workflow-edit__field">
                  <span>{t("edit.model")}</span>
                  <input
                    type="text"
                    name={`${s.role}.model`}
                    value={s.model ?? ""}
                    placeholder={t("edit.modelPlaceholder")}
                    onChange={(e) => patchStage(s.role, { model: e.target.value })}
                  />
                </label>
                <label className="workflow-edit__field workflow-edit__field--narrow">
                  <span>{t("edit.timeoutMinutes")}</span>
                  <input
                    type="number"
                    min={1}
                    name={`${s.role}.timeoutMinutes`}
                    value={String(s.timeoutMinutes)}
                    onChange={(e) => patchStage(s.role, { timeoutMinutes: toCount(e.target.value) })}
                  />
                </label>
              </div>
              {availability[s.provider] && (
                <p className="workflow-edit__warning">{providerLabel(s.provider)}</p>
              )}
              <label className="workflow-edit__field">
                <span>{t("edit.prompt")}</span>
                <textarea
                  name={`${s.role}.prompt`}
                  rows={4}
                  value={s.prompt}
                  onChange={(e) => patchStage(s.role, { prompt: e.target.value })}
                />
              </label>
              <label className="workflow-edit__field">
                <span>{t("edit.completionCriteria")}</span>
                <textarea
                  name={`${s.role}.completionCriteria`}
                  rows={2}
                  value={s.completionCriteria}
                  onChange={(e) => patchStage(s.role, { completionCriteria: e.target.value })}
                />
              </label>
              {s.role === "implement" && (
                <label className="workflow-edit__toggle">
                  <input
                    type="checkbox"
                    data-switch
                    name={`${s.role}.requiresApproval`}
                    checked={s.requiresApproval}
                    onChange={(e) => patchStage(s.role, { requiresApproval: e.target.checked })}
                  />
                  <span>{t("edit.requiresApproval")}</span>
                </label>
              )}
            </fieldset>
          ))}

          <h4 className="workflow-edit__heading">{t("edit.settings")}</h4>
          <div className="workflow-edit__row">
            <label className="workflow-edit__field">
              <span>{t("edit.reviewReturnTo")}</span>
              <select
                name="reviewReturnTo"
                value={draft.reviewReturnTo}
                onChange={(e) => patch({ reviewReturnTo: e.target.value as Role })}
              >
                {RETURN_TARGETS.map((role) => (
                  <option key={role} value={role}>
                    {t(`role.${role}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="workflow-edit__field workflow-edit__field--narrow">
              <span>{t("edit.maxReentryCount")}</span>
              <input
                type="number"
                min={1}
                name="maxReentryCount"
                value={String(draft.maxReentryCount)}
                onChange={(e) => patch({ maxReentryCount: toCount(e.target.value) })}
              />
            </label>
            <label className="workflow-edit__field workflow-edit__field--narrow">
              <span>{t("edit.maxConcurrentRuns")}</span>
              <input
                type="number"
                min={1}
                name="maxConcurrentRuns"
                value={String(draft.maxConcurrentRuns)}
                onChange={(e) => patch({ maxConcurrentRuns: toCount(e.target.value) })}
              />
            </label>
          </div>
          <label className="workflow-edit__toggle">
            <input
              type="checkbox"
              data-switch
              name="saveDesignDoc"
              checked={draft.designDocPath !== null}
              onChange={(e) => patch({ designDocPath: e.target.checked ? DEFAULT_DESIGN_DOC_PATH : null })}
            />
            <span>{t("edit.saveDesignDoc")}</span>
          </label>
          {draft.designDocPath !== null && (
            <label className="workflow-edit__field">
              <span>{t("edit.designDocPath")}</span>
              <input
                type="text"
                name="designDocPath"
                value={draft.designDocPath}
                onChange={(e) => patch({ designDocPath: e.target.value })}
              />
              <span className="workflow-edit__help">{t("edit.designDocPathHelp")}</span>
            </label>
          )}
          <label className="workflow-edit__field">
            <span>{t("edit.issueTracking")}</span>
            <select
              name="issueTracking"
              value={draft.issueTracking}
              onChange={(e) => patch({ issueTracking: e.target.value as IssueTracking })}
            >
              {ISSUE_TRACKING.map((value) => (
                <option key={value} value={value}>
                  {t(`edit.issueTrackingOption.${value}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {errors.length > 0 && (
          <div className="workflow-edit__errors" role="alert">
            <p className="workflow-edit__errors-title">{t("edit.errors")}</p>
            <ul>
              {errors.map((text, i) => (
                <li key={i}>{text}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="workflow-edit__buttons">
          <button type="button" className="workflow-edit__cancel" onClick={onClose}>
            {t("edit.cancel")}
          </button>
          <button type="button" className="workflow-edit__save" disabled={saving} onClick={() => void save()}>
            {t("edit.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

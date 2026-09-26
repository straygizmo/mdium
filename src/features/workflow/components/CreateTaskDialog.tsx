import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderMarkdownSafe } from "@/shared/lib/markdown/render-markdown-safe";
import type { Workflow } from "@/shared/types/workflow";
import { trapTab, useDialogFocus } from "../lib/dialog-focus";
import { workflowApi } from "../lib/workflow-api";
import { useWorkflowStore } from "../workflow-store";
import "./CreateTaskDialog.css";

const NO_WORKFLOWS: Workflow[] = [];

interface CreateTaskDialogProps {
  onClose(): void;
  /** Adds the standard workflow (offered when no workflow is usable). */
  onAddStandard(): void;
}

/** Sanitized Markdown preview of the task body. */
function BodyPreview({ body }: { body: string }) {
  const { t } = useTranslation("workflow");
  // User-entered Markdown: only ever rendered through the sanitizing renderer.
  const html = useMemo(() => renderMarkdownSafe(body), [body]);
  if (!body.trim()) return <p className="workflow-create__empty">{t("create.emptyPreview")}</p>;
  return <div className="workflow-create__preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Creates a task for one of the enabled workflows and opens its detail. */
export function CreateTaskDialog({ onClose, onAddStandard }: CreateTaskDialogProps) {
  const { t } = useTranslation("workflow");
  const workflows = useWorkflowStore((s) => (s.activeRoot ? s.projects[s.activeRoot]?.workflows : undefined) ?? NO_WORKFLOWS);
  const usable = useMemo(() => workflows.filter((w) => w.enabled && !w.archived), [workflows]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [creating, setCreating] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogFocus(dialogRef, true);

  // Fall back to the first usable workflow when none (or a vanished one) is selected.
  const selected = usable.find((w) => w.id === workflowId) ?? usable[0] ?? null;
  const canCreate = !creating && title.trim() !== "" && selected !== null;

  const create = async () => {
    if (!canCreate || !selected) return;
    setCreating(true);
    const task = await useWorkflowStore
      .getState()
      .run(t("create.failed"), (root) => workflowApi.createTask(root, title.trim(), body, selected.id));
    setCreating(false);
    if (!task) return;
    onClose();
    useWorkflowStore.getState().openTask(task.meta.id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else trapTab(e, dialogRef.current);
  };

  return (
    <div
      className="workflow-create-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="workflow-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-create-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h3 id="workflow-create-title" className="workflow-create__title">
          {t("create.title")}
        </h3>
        <label className="workflow-create__field">
          <span>{t("create.taskTitle")}</span>
          <input
            type="text"
            name="title"
            required
            aria-required="true"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="workflow-create__field">
          <div className="workflow-create__body-head">
            <span>{t("create.body")}</span>
            <button type="button" className="workflow-create__mode" onClick={() => setPreview((p) => !p)}>
              {preview ? t("create.write") : t("create.preview")}
            </button>
          </div>
          {preview ? (
            <BodyPreview body={body} />
          ) : (
            <textarea
              name="body"
              rows={10}
              aria-label={t("create.body")}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
        </div>
        {usable.length > 0 ? (
          <label className="workflow-create__field">
            <span>{t("create.workflow")}</span>
            <select name="workflow" value={selected?.id ?? ""} onChange={(e) => setWorkflowId(e.target.value)}>
              {usable.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="workflow-create__none">
            <p className="workflow-create__message">{t("create.noWorkflows")}</p>
            <button type="button" className="workflow-create__add" onClick={onAddStandard}>
              {t("panel.addStandard")}
            </button>
          </div>
        )}
        <div className="workflow-create__buttons">
          <button type="button" className="workflow-create__cancel" onClick={onClose}>
            {t("create.cancel")}
          </button>
          <button type="button" className="workflow-create__confirm" disabled={!canCreate} onClick={() => void create()}>
            {t("create.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

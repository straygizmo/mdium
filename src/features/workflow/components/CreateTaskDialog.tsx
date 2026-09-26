import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Workflow } from "@/shared/types/workflow";
import { workflowApi } from "../lib/workflow-api";
import { showConfirm } from "@/stores/dialog-store";
import { useWorkflowStore } from "../workflow-store";
import { DialogShell } from "./DialogShell";
import { SafeMarkdown } from "./SafeMarkdown";
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
  if (!body.trim()) return <p className="workflow-create__empty">{t("create.emptyPreview")}</p>;
  // User-entered Markdown: only ever rendered through the sanitizing renderer.
  return <SafeMarkdown source={body} className="workflow-create__preview" />;
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
  const closingRef = useRef(false);

  // Fall back to the first usable workflow when none (or a vanished one) is selected.
  const selected = usable.find((w) => w.id === workflowId) ?? usable[0] ?? null;
  const canCreate = !creating && title.trim() !== "" && selected !== null;

  const create = async () => {
    if (!canCreate || !selected) return;
    setCreating(true);
    const task = await useWorkflowStore
      .getState()
      // Refresh at once: the detail opened next needs the task in the list.
      .run(t("create.failed"), (root) => workflowApi.createTask(root, title.trim(), body, selected.id), {
        refreshNow: true,
      });
    setCreating(false);
    if (!task) return;
    onClose();
    useWorkflowStore.getState().openTask(task.meta.id);
  };

  /** Closes unless creating; asks before discarding a typed title or body. */
  const requestClose = async () => {
    if (creating || closingRef.current) return;
    if (!title.trim() && !body.trim()) {
      onClose();
      return;
    }
    closingRef.current = true;
    try {
      if (await showConfirm(t("create.discardConfirm"), { kind: "warning" })) onClose();
    } finally {
      closingRef.current = false;
    }
  };

  return (
    <DialogShell
      overlayClassName="workflow-create-overlay"
      className="workflow-create"
      labelledBy="workflow-create-title"
      onClose={() => void requestClose()}
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
        <button
          type="button"
          className="workflow-create__cancel"
          disabled={creating}
          onClick={() => void requestClose()}
        >
          {t("create.cancel")}
        </button>
        <button type="button" className="workflow-create__confirm" disabled={!canCreate} onClick={() => void create()}>
          {t("create.create")}
        </button>
      </div>
    </DialogShell>
  );
}

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { showConfirm } from "@/stores/dialog-store";
import type { Task } from "@/shared/types/workflow";
import { isCommandError } from "../lib/errors";
import { workflowApi } from "../lib/workflow-api";
import { useWorkflowStore } from "../workflow-store";
import { RetryDialog, type RetryOptions } from "./RetryDialog";
import "./TaskActions.css";

type Action =
  | "cancel"
  | "hold"
  | "resume"
  | "retry"
  | "markComplete"
  | "approve"
  | "requestRevision"
  | "answer"
  | "archive"
  | "delete";

const INTEGRITY_ACK_REQUIRED = "WORKFLOW_INTEGRITY_ACK_REQUIRED";

/** The operations offered for a task, in display order. */
function actionsFor(task: Task): Action[] {
  const { status, awaiting, archived } = task.meta;
  switch (status) {
    case "inbox":
      return ["cancel"];
    case "running":
      return ["hold", "cancel"];
    case "on_hold":
      return ["resume", "cancel"];
    case "attention":
      return ["retry", "markComplete", "cancel"];
    case "awaiting_user":
      return awaiting?.kind === "question" ? ["answer", "cancel"] : ["approve", "requestRevision", "cancel"];
    case "completed":
    case "cancelled":
      return archived ? ["delete"] : ["archive", "delete"];
    default:
      return [];
  }
}

/** State of the retry dialog while it is shown. */
interface RetryState {
  integrityAckRequired: boolean;
  options?: RetryOptions;
}

/** Buttons for the operations allowed in the task's current state. */
export function TaskActions({ task }: { task: Task }) {
  const { t } = useTranslation("workflow");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [retry, setRetry] = useState<RetryState | null>(null);
  const { id, title, status, awaiting } = task.meta;
  const actions = actionsFor(task);
  const needsText = status === "awaiting_user";
  const hasText = text.trim().length > 0;

  /** Runs one command through the store (errors are shown, conflicts refresh silently). */
  const execute = async <T,>(fn: (root: string) => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await useWorkflowStore.getState().run(t("actions.failed"), fn);
    } finally {
      setBusy(false);
    }
  };

  const retryWith = async (options: RetryOptions) => {
    setRetry(null);
    let ackRequired = false;
    await execute(async (root) => {
      try {
        return await workflowApi.retryTask(root, id, options);
      } catch (err) {
        // Not an error for the user: ask for the acknowledgement instead.
        if (isCommandError(err) && err.code === INTEGRITY_ACK_REQUIRED) {
          ackRequired = true;
          return undefined;
        }
        throw err;
      }
    });
    if (ackRequired) setRetry({ integrityAckRequired: true, options });
  };

  const onAction = async (action: Action) => {
    switch (action) {
      case "cancel": {
        const text = t(status === "running" ? "actions.cancelRunningConfirm" : "actions.cancelConfirm", { title });
        if (await showConfirm(text, { kind: "warning" })) {
          await execute((root) => workflowApi.cancelTask(root, id));
        }
        break;
      }
      case "hold":
        await execute((root) => workflowApi.holdTask(root, id));
        break;
      case "resume":
        await execute((root) => workflowApi.resumeTask(root, id));
        break;
      case "retry":
        setRetry({ integrityAckRequired: false });
        break;
      case "markComplete":
        if (await showConfirm(t("actions.markCompleteConfirm", { title }), { kind: "warning" })) {
          await execute((root) => workflowApi.markComplete(root, id));
        }
        break;
      case "approve":
        await execute((root) => workflowApi.approvePlan(root, id));
        break;
      case "requestRevision": {
        const instruction = text.trim();
        if (await execute((root) => workflowApi.requestRevision(root, id, instruction))) setText("");
        break;
      }
      case "answer": {
        const answer = text.trim();
        if (await execute((root) => workflowApi.answerQuestion(root, id, answer))) setText("");
        break;
      }
      case "archive":
        await execute((root) => workflowApi.archiveTask(root, id));
        break;
      case "delete":
        if (await showConfirm(t("actions.deleteConfirm", { title }), { kind: "warning" })) {
          let deleted = false;
          await execute(async (root) => {
            await workflowApi.deleteTask(root, id);
            deleted = true;
          });
          if (deleted) useWorkflowStore.getState().openTask(null);
        }
        break;
    }
  };

  const isQuestion = awaiting?.kind === "question";

  return (
    <div className="workflow-actions">
      {needsText && (
        <label className="workflow-actions__input">
          <span>{t(isQuestion ? "actions.answerLabel" : "actions.revisionLabel")}</span>
          <textarea
            value={text}
            rows={3}
            placeholder={t(isQuestion ? "actions.answerPlaceholder" : "actions.revisionPlaceholder")}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      )}
      <div className="workflow-actions__buttons" role="group" aria-label={t("actions.label")}>
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={`workflow-actions__btn${action === "delete" || action === "cancel" ? " workflow-actions__btn--danger" : ""}`}
            data-action={action}
            disabled={busy || ((action === "requestRevision" || action === "answer") && !hasText)}
            onClick={() => void onAction(action)}
          >
            {t(`actions.${action}`)}
          </button>
        ))}
      </div>
      {retry && (
        <RetryDialog
          reason={task.meta.attention}
          integrityAckRequired={retry.integrityAckRequired}
          initialOptions={retry.options}
          onConfirm={(options) => void retryWith(options)}
          onCancel={() => setRetry(null)}
        />
      )}
    </div>
  );
}

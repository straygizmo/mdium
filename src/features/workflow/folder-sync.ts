import { listen } from "@tauri-apps/api/event";
import { WORKFLOW_OPEN_TASK_EVENT, type OpenTaskEvent } from "@/shared/types/workflow";
import { useTabStore } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";
import { sameRoot } from "./lib/errors";
import { useWorkflowStore } from "./workflow-store";

/**
 * Keeps the workflow store on the active folder: activates it now and on
 * every folder change, whether or not a workflow view is mounted. The store
 * update runs inside the folder change itself, so no frame shows the previous
 * project's board or selected task. Returns the unsubscribe function.
 */
export function startWorkflowFolderSync(): () => void {
  void useWorkflowStore.getState().activate(useTabStore.getState().activeFolderPath);
  return useTabStore.subscribe((state, prev) => {
    if (state.activeFolderPath !== prev.activeFolderPath) {
      void useWorkflowStore.getState().activate(state.activeFolderPath);
    }
  });
}

/**
 * Opens a task created by an intake window: when the task belongs to the
 * active folder's project, switches the left panel to the workflows view and
 * shows the task detail. Tasks of other projects are ignored.
 */
async function openTaskFromIntake(e: OpenTaskEvent): Promise<void> {
  const folder = useTabStore.getState().activeFolderPath;
  if (!folder) return;
  // The active folder may still be attaching: join that attach (the root is compared normalized).
  await useWorkflowStore.getState().ensureActivated(folder);
  const root = useWorkflowStore.getState().activeRoot;
  if (!root || !sameRoot(root, e.projectRoot) || useTabStore.getState().activeFolderPath !== folder) return;
  useUiStore.getState().setLeftPanel("workflow");
  useTabStore.getState().setFolderLeftPanel("workflow");
  useWorkflowStore.getState().openTask(e.taskId);
  // List the new task at once rather than after its change event.
  await useWorkflowStore.getState().refresh(root);
}

/**
 * Listens to `workflow://open-task` (sent by intake windows after
 * finalizing); resolves to the unlisten function.
 */
export async function startWorkflowOpenTaskListener(): Promise<() => void> {
  return listen<OpenTaskEvent>(WORKFLOW_OPEN_TASK_EVENT, (e) => {
    openTaskFromIntake(e.payload).catch((err: unknown) => console.error("[workflow] open task failed", err));
  });
}

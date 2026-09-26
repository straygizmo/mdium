import { useTabStore } from "@/stores/tab-store";
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

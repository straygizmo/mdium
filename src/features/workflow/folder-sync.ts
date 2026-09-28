import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  WORKFLOW_OPEN_TASK_ACK_EVENT,
  WORKFLOW_OPEN_TASK_EVENT,
  type OpenTaskAck,
  type OpenTaskEvent,
} from "@/shared/types/workflow";
import { useTabStore } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";
import { isWindows, sameRoot } from "./lib/errors";
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
 * A path in a comparable form without touching the file system: `\\?\`
 * prefix removed, separators unified to `/`, trailing separators stripped,
 * and lowercased on Windows.
 */
export function comparablePath(path: string): string {
  let p = path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
  // Keep the root of a drive ("C:/") or of the file system ("/").
  while (p.length > 1 && p.endsWith("/") && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return isWindows() ? p.toLowerCase() : p;
}

/**
 * The open folder whose project is `projectRoot` (a normalized root): the
 * active folder when its attached root matches, else another open folder
 * whose path matches by `comparablePath`. Other folders are never attached
 * here (attaching starts their orchestrators); null when none matches.
 */
async function folderOfProject(projectRoot: string): Promise<string | null> {
  const { activeFolderPath, openFolderPaths } = useTabStore.getState();
  if (activeFolderPath) {
    // The active folder may still be attaching: join that attach.
    await useWorkflowStore.getState().ensureActivated(activeFolderPath);
    // The user switched folders meanwhile: do not switch back.
    if (useTabStore.getState().activeFolderPath !== activeFolderPath) return null;
    const root = useWorkflowStore.getState().activeRoot;
    if (root && sameRoot(root, projectRoot)) return activeFolderPath;
  }
  const wanted = comparablePath(projectRoot);
  return openFolderPaths.find((f) => f !== activeFolderPath && comparablePath(f) === wanted) ?? null;
}

/**
 * Opens a task created by an intake window: when the task's project is the
 * active folder, or another open folder (switched to first), switches the
 * left panel to the workflows view and shows the task detail. Resolves to
 * whether the task is shown; tasks of projects that are not open are not.
 */
async function openTaskFromIntake(e: OpenTaskEvent): Promise<boolean> {
  const folder = await folderOfProject(e.projectRoot);
  if (!folder) return false;
  if (useTabStore.getState().activeFolderPath !== folder) useTabStore.getState().switchFolder(folder);
  await useWorkflowStore.getState().ensureActivated(folder);
  const root = useWorkflowStore.getState().activeRoot;
  if (!root || !sameRoot(root, e.projectRoot) || useTabStore.getState().activeFolderPath !== folder) return false;
  useUiStore.getState().setLeftPanel("workflow");
  useTabStore.getState().setFolderLeftPanel("workflow");
  useWorkflowStore.getState().openTask(e.taskId);
  // List the new task at once rather than after its change event.
  await useWorkflowStore.getState().refresh(root);
  return true;
}

/**
 * Brings the main window to the front. The window may lack the permission
 * to do so; the task is shown either way.
 */
async function focusMainWindow(): Promise<void> {
  const win = getCurrentWindow();
  for (const step of [() => win.unminimize(), () => win.setFocus()]) {
    try {
      await step();
    } catch (err) {
      console.warn("[workflow] focusing the main window failed", err);
    }
  }
}

/** Opens the task and acknowledges it to the sending intake window. */
async function handleOpenTask(e: OpenTaskEvent): Promise<void> {
  let handled = false;
  try {
    handled = await openTaskFromIntake(e);
    if (handled) await focusMainWindow();
  } catch (err) {
    console.error("[workflow] open task failed", err);
  }
  const ack: OpenTaskAck = { taskId: e.taskId, handled };
  await emitTo(e.sender, WORKFLOW_OPEN_TASK_ACK_EVENT, ack);
}

/**
 * Listens to `workflow://open-task` (sent by intake windows after
 * finalizing) and answers each with `workflow://open-task-ack`; resolves
 * to the unlisten function.
 */
export async function startWorkflowOpenTaskListener(): Promise<() => void> {
  return listen<OpenTaskEvent>(WORKFLOW_OPEN_TASK_EVENT, (e) => {
    handleOpenTask(e.payload).catch((err: unknown) => console.error("[workflow] open task ack failed", err));
  });
}

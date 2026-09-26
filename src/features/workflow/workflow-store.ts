import { create } from "zustand";
import { showMessage } from "@/stores/dialog-store";
import type { ProgressEvent, StoreWarning, Task, Workflow, WorkflowRun } from "@/shared/types/workflow";
import { isCommandError, sameRoot } from "./lib/errors";
import { formatCommandError } from "./lib/format";
import { subscribeWorkflowEvents, workflowApi } from "./lib/workflow-api";

/** Latest progress line of a running task. */
export interface TaskProgress {
  text: string;
  kind: "message" | "tool";
  at: number;
}

/** Everything the UI knows about one attached project. */
export interface ProjectState {
  root: string;
  workflows: Workflow[];
  workflowWarnings: StoreWarning[];
  tasks: Task[];
  taskWarnings: StoreWarning[];
  runs: WorkflowRun[];
  /** Keyed by task id. */
  progress: Record<string, TaskProgress>;
  /** True only while the project's first load is in progress. */
  loading: boolean;
  /** True while a later (e.g. event-driven) reload is in progress. */
  refreshing: boolean;
  /** Whether a load has completed successfully once. */
  loaded: boolean;
  /** Localized load error, or null. */
  error: string | null;
}

export interface WorkflowFilters {
  workflowId: string | null;
  showArchived: boolean;
  showCancelled: boolean;
  view: "kanban" | "matrix";
}

interface WorkflowState {
  /** Normalized root of the active folder (the `workflow_attach_project` result). */
  activeRoot: string | null;
  /** Keyed by normalized root. */
  projects: Record<string, ProjectState>;
  /** Localized attach failure of the active folder, or null. */
  attachError: string | null;
  /** Task shown in the task detail modal. */
  selectedTaskId: string | null;
  filters: WorkflowFilters;
  /** Attaches the folder and loads its lists; null clears the active root. */
  activate(folderPath: string | null): Promise<void>;
  /** Reloads workflows, tasks and runs of a project. */
  refresh(root: string): Promise<void>;
  openTask(taskId: string | null): void;
  setFilters(p: Partial<WorkflowFilters>): void;
  /**
   * Executes an action for the active root. Errors are shown in a dialog
   * titled `errorTitle` (already localized text), except
   * `TRANSITION_CONFLICT`, which refreshes silently. Refreshes after success.
   * Resolves to undefined on failure.
   */
  run<T>(errorTitle: string, fn: (root: string) => Promise<T>): Promise<T | undefined>;
}

/** Debounce delay of event-driven refreshes, per project. */
const REFRESH_DEBOUNCE_MS = 150;

const TRANSITION_CONFLICT = "TRANSITION_CONFLICT";

function emptyProject(root: string): ProjectState {
  return {
    root,
    workflows: [],
    workflowWarnings: [],
    tasks: [],
    taskWarnings: [],
    runs: [],
    progress: {},
    loading: false,
    refreshing: false,
    loaded: false,
    error: null,
  };
}

/** Keeps progress lines only for tasks that are still present and running. */
function pruneProgress(progress: Record<string, TaskProgress>, tasks: Task[]): Record<string, TaskProgress> {
  const running = new Set(tasks.filter((t) => t.meta.status === "running").map((t) => t.meta.id));
  return Object.fromEntries(Object.entries(progress).filter(([taskId]) => running.has(taskId)));
}

/** Incremented by every `activate` call; an older call must not change `activeRoot`. */
let activateSeq = 0;
/** Folder path passed to the latest non-null `activate` call. */
let activeFolder: string | null = null;
/** Latest refresh sequence per root; older refresh results are dropped. */
const refreshSeq = new Map<string, number>();

export const useWorkflowStore = create<WorkflowState>()((set, get) => {
  const updateProject = (root: string, fn: (p: ProjectState) => ProjectState) =>
    set((s) => ({ projects: { ...s.projects, [root]: fn(s.projects[root] ?? emptyProject(root)) } }));

  return {
    activeRoot: null,
    attachError: null,
    projects: {},
    selectedTaskId: null,
    filters: { workflowId: null, showArchived: false, showCancelled: false, view: "kanban" },

    async activate(folderPath) {
      const seq = ++activateSeq;
      if (!folderPath) {
        activeFolder = null;
        set({ activeRoot: null, attachError: null, selectedTaskId: null });
        return;
      }
      if (folderPath !== activeFolder) {
        // Hide the previous project's lists until the new folder is attached.
        activeFolder = folderPath;
        set({ activeRoot: null, attachError: null, selectedTaskId: null });
      }
      let root: string;
      try {
        root = await workflowApi.attach(folderPath);
      } catch (err) {
        if (seq === activateSeq) set({ attachError: formatCommandError(err) });
        return;
      }
      if (!get().projects[root]) updateProject(root, (p) => p);
      // A newer activate call owns `activeRoot`; this result is only stored under its own root.
      if (seq === activateSeq) set({ activeRoot: root, attachError: null });
      await get().refresh(root);
    },

    async refresh(root) {
      const seq = (refreshSeq.get(root) ?? 0) + 1;
      refreshSeq.set(root, seq);
      updateProject(root, (p) => (p.loaded ? { ...p, refreshing: true } : { ...p, loading: true }));
      try {
        const [workflows, tasks, runs] = await Promise.all([
          workflowApi.listWorkflows(root),
          workflowApi.listTasks(root),
          workflowApi.listRuns(root),
        ]);
        if (refreshSeq.get(root) !== seq) return;
        updateProject(root, (p) => ({
          ...p,
          workflows: workflows.workflows,
          workflowWarnings: workflows.warnings,
          tasks: tasks.tasks,
          taskWarnings: tasks.warnings,
          runs: runs.runs,
          progress: pruneProgress(p.progress, tasks.tasks),
          loading: false,
          refreshing: false,
          loaded: true,
          error: null,
        }));
      } catch (err) {
        if (refreshSeq.get(root) !== seq) return;
        updateProject(root, (p) => ({ ...p, loading: false, refreshing: false, error: formatCommandError(err) }));
      }
    },

    openTask(taskId) {
      set({ selectedTaskId: taskId });
    },

    setFilters(p) {
      set((s) => ({ filters: { ...s.filters, ...p } }));
    },

    async run<T>(errorTitle: string, fn: (root: string) => Promise<T>): Promise<T | undefined> {
      const root = get().activeRoot;
      if (!root) return undefined;
      let result: T;
      try {
        result = await fn(root);
      } catch (err) {
        if (isCommandError(err) && err.code === TRANSITION_CONFLICT) {
          // The state changed underneath: show the real state instead of an error.
          await get().refresh(root);
        } else {
          void showMessage(formatCommandError(err), { title: errorTitle, kind: "error" });
        }
        return undefined;
      }
      await get().refresh(root);
      return result;
    },
  };
});

/** Returns the stored key of the known project matching an event's root, if any. */
function knownRoot(eventRoot: string): string | undefined {
  return Object.keys(useWorkflowStore.getState().projects).find((root) => sameRoot(root, eventRoot));
}

/** Number of unreleased `startWorkflowEventBridge` callers. */
let bridgeUsers = 0;
/** The shared subscription while at least one caller holds the bridge. */
let bridgeSubscription: Promise<() => void> | null = null;
/** Pending debounced refreshes, keyed by project root. */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRefresh(eventRoot: string) {
  const root = knownRoot(eventRoot);
  if (!root) return;
  const pending = refreshTimers.get(root);
  if (pending !== undefined) clearTimeout(pending);
  refreshTimers.set(
    root,
    setTimeout(() => {
      refreshTimers.delete(root);
      void useWorkflowStore.getState().refresh(root);
    }, REFRESH_DEBOUNCE_MS),
  );
}

function updateProgress(e: ProgressEvent) {
  const root = knownRoot(e.projectRoot);
  if (!root) return;
  useWorkflowStore.setState((s) => {
    const project = s.projects[root];
    return {
      projects: {
        ...s.projects,
        [root]: {
          ...project,
          progress: { ...project.progress, [e.taskId]: { text: e.text, kind: e.kind, at: Date.now() } },
        },
      },
    };
  });
}

/**
 * Holds the orchestrator event subscription (ref-counted: every caller shares
 * one subscription). Task/run events for a known project schedule a debounced
 * refresh; progress events update the latest progress line of known
 * projects. Resolves to this caller's idempotent release; the subscription
 * ends when every caller has released it.
 */
export async function startWorkflowEventBridge(): Promise<() => void> {
  bridgeUsers++;
  if (!bridgeSubscription) {
    const subscription = subscribeWorkflowEvents({
      onTaskChanged: (e) => scheduleRefresh(e.projectRoot),
      onRunChanged: (e) => scheduleRefresh(e.projectRoot),
      onProgress: updateProgress,
    });
    bridgeSubscription = subscription;
    subscription.catch(() => {
      if (bridgeSubscription === subscription) bridgeSubscription = null;
    });
  }
  const subscription = bridgeSubscription;
  try {
    await subscription;
  } catch (err) {
    bridgeUsers--;
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bridgeUsers--;
    if (bridgeUsers > 0) return;
    if (bridgeSubscription === subscription) bridgeSubscription = null;
    for (const timer of refreshTimers.values()) clearTimeout(timer);
    refreshTimers.clear();
    void subscription.then((unsubscribe) => unsubscribe());
  };
}

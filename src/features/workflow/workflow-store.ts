import { create } from "zustand";
import { showMessage } from "@/stores/dialog-store";
import type {
  IntakeSessionView,
  ProgressEvent,
  StoreWarning,
  Task,
  Workflow,
  WorkflowRun,
} from "@/shared/types/workflow";
import { isCommandError, sameRoot } from "./lib/errors";
import { formatCommandError } from "./lib/format";
import {
  subscribeIntakeChanged,
  subscribeWorkflowEvents,
  subscribeWorkflowsChanged,
  workflowApi,
} from "./lib/workflow-api";

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
  /** Intake sessions of every status, newest first. */
  intakes: IntakeSessionView[];
  intakeWarnings: StoreWarning[];
  /** Localized intake list failure, or null; the other lists stay usable. */
  intakeError: string | null;
  /** Whether the intake list has loaded successfully once. */
  intakesLoaded: boolean;
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

/** Options of `run`. */
export interface RunOptions {
  /**
   * Refreshes right after success even while the event bridge is active; for
   * commands that emit no change events (workflow file saves) or whose
   * result must be listed at once (a created task opened in the detail).
   */
  refreshNow?: boolean;
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
  /** Reloads workflows, tasks, runs and intake sessions of a project. */
  refresh(root: string): Promise<void>;
  /** Reloads workflows, tasks and runs of a project, not its intake sessions. */
  refreshLists(root: string): Promise<void>;
  /** Reloads only the intake sessions of a project. */
  refreshIntakes(root: string): Promise<void>;
  /**
   * Resolves once `folderPath` is attached: joins the activation in flight
   * for that folder, or starts one when the folder is not the active one.
   */
  ensureActivated(folderPath: string): Promise<void>;
  openTask(taskId: string | null): void;
  setFilters(p: Partial<WorkflowFilters>): void;
  /**
   * Executes an action for the active root. Errors are shown in a dialog
   * titled `errorTitle` (already localized text), except
   * `TRANSITION_CONFLICT`, which refreshes silently at once. After success
   * the refresh is left to the debounced event-driven one while the event
   * bridge is active (unless `options.refreshNow`), else it runs at once.
   * Resolves to undefined on failure.
   */
  run<T>(errorTitle: string, fn: (root: string) => Promise<T>, options?: RunOptions): Promise<T | undefined>;
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
    intakes: [],
    intakeWarnings: [],
    intakeError: null,
    intakesLoaded: false,
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
/** The latest `activate` call for `activeFolder`, while it is in flight. */
let pendingActivation: Promise<void> | null = null;
/** Latest refresh sequence per root; older refresh results are dropped. */
const refreshSeq = new Map<string, number>();
/** Latest intake refresh sequence per root; older intake list results are dropped. */
const intakeRefreshSeq = new Map<string, number>();

export const useWorkflowStore = create<WorkflowState>()((set, get) => {
  const updateProject = (root: string, fn: (p: ProjectState) => ProjectState) =>
    set((s) => ({ projects: { ...s.projects, [root]: fn(s.projects[root] ?? emptyProject(root)) } }));

  /** Reloads workflows, tasks and runs of a project (not its intakes). */
  const loadLists = async (root: string) => {
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
  };

  /** Attaches `folderPath` and loads its lists; see `activate`. */
  const activateFolder = async (folderPath: string | null) => {
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
  };

  return {
    activeRoot: null,
    attachError: null,
    projects: {},
    selectedTaskId: null,
    filters: { workflowId: null, showArchived: false, showCancelled: false, view: "kanban" },

    activate(folderPath) {
      const activation = activateFolder(folderPath);
      pendingActivation = folderPath ? activation : null;
      void activation.finally(() => {
        if (pendingActivation === activation) pendingActivation = null;
      });
      return activation;
    },

    async ensureActivated(folderPath) {
      if (folderPath === activeFolder && pendingActivation) return pendingActivation;
      if (folderPath === activeFolder && get().activeRoot) return;
      return get().activate(folderPath);
    },

    async refresh(root) {
      await Promise.all([loadLists(root), get().refreshIntakes(root)]);
    },

    refreshLists: (root) => loadLists(root),

    async refreshIntakes(root) {
      const seq = (intakeRefreshSeq.get(root) ?? 0) + 1;
      intakeRefreshSeq.set(root, seq);
      try {
        const list = await workflowApi.intakeList(root);
        if (intakeRefreshSeq.get(root) !== seq) return;
        updateProject(root, (p) => ({
          ...p,
          intakes: list.sessions,
          intakeWarnings: list.warnings,
          intakeError: null,
          intakesLoaded: true,
        }));
      } catch (err) {
        if (intakeRefreshSeq.get(root) !== seq) return;
        updateProject(root, (p) => ({ ...p, intakeError: formatCommandError(err) }));
      }
    },

    openTask(taskId) {
      set({ selectedTaskId: taskId });
    },

    setFilters(p) {
      set((s) => ({ filters: { ...s.filters, ...p } }));
    },

    async run<T>(errorTitle: string, fn: (root: string) => Promise<T>, options?: RunOptions): Promise<T | undefined> {
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
      // With the bridge active, the command's change events refresh the lists.
      if (options?.refreshNow || bridgeUsers === 0) await get().refresh(root);
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
/** Pending debounced list refreshes, keyed by project root. */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Pending debounced intake refreshes, keyed by project root. */
const intakeRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Runs `refresh(root)` for the known project of `eventRoot` once its events pause. */
function debounce(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  eventRoot: string,
  refresh: (root: string) => Promise<void>,
) {
  const root = knownRoot(eventRoot);
  if (!root) return;
  const pending = timers.get(root);
  if (pending !== undefined) clearTimeout(pending);
  timers.set(
    root,
    setTimeout(() => {
      timers.delete(root);
      void refresh(root);
    }, REFRESH_DEBOUNCE_MS),
  );
}

function scheduleListRefresh(eventRoot: string) {
  debounce(refreshTimers, eventRoot, (root) => useWorkflowStore.getState().refreshLists(root));
}

function scheduleIntakeRefresh(eventRoot: string) {
  debounce(intakeRefreshTimers, eventRoot, (root) => useWorkflowStore.getState().refreshIntakes(root));
}

/**
 * Subscribes to the orchestrator, intake and workflow file events; resolves
 * to a function removing every listener. Fails as a whole (without leaking
 * listeners) when any subscription fails.
 */
async function subscribeAll(): Promise<() => void> {
  const results = await Promise.allSettled([
    subscribeWorkflowEvents({
      onTaskChanged: (e) => scheduleListRefresh(e.projectRoot),
      onRunChanged: (e) => scheduleListRefresh(e.projectRoot),
      onProgress: updateProgress,
    }),
    subscribeIntakeChanged((e) => scheduleIntakeRefresh(e.projectRoot)),
    subscribeWorkflowsChanged((e) => scheduleListRefresh(e.projectRoot)),
  ]);
  const unsubscribers: (() => void)[] = [];
  for (const r of results) if (r.status === "fulfilled") unsubscribers.push(r.value);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    for (const unsubscribe of unsubscribers) unsubscribe();
    throw failed.reason;
  }
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
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
 * Holds the workflow event subscription (ref-counted: every caller shares
 * one subscription). Task/run and `workflows-changed` events for a known
 * project schedule a debounced refresh of its lists (not its intakes),
 * `intake-changed` events a debounced refresh of only its intakes; progress events update the latest progress line of
 * known projects. Resolves to this caller's idempotent release; the subscription
 * ends when every caller has released it.
 */
export async function startWorkflowEventBridge(): Promise<() => void> {
  bridgeUsers++;
  if (!bridgeSubscription) {
    const subscription = subscribeAll();
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
    for (const timers of [refreshTimers, intakeRefreshTimers]) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }
    void subscription.then((unsubscribe) => unsubscribe());
  };
}

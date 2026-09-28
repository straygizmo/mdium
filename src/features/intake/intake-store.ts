import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import i18n from "@/shared/i18n";
import { showMessage } from "@/stores/dialog-store";
import type {
  AttachmentMeta,
  ForgeProbe,
  IntakeKind,
  IntakeSessionView,
  Provider,
  ProviderProbe,
  Workflow,
} from "@/shared/types/workflow";
import { formatCommandError, isCommandError, sameRoot } from "@/features/workflow/lib/format";
import {
  subscribeIntakeChanged,
  subscribeWorkflowsChanged,
  workflowApi,
} from "@/features/workflow/lib/workflow-api";

const TRANSITION_CONFLICT = "TRANSITION_CONFLICT";

export interface IntakeCreateInput {
  workflowId: string;
  kind: IntakeKind;
  provider: Provider;
  model: string | null;
}

/** State of the one intake session this window serves. */
export interface IntakeWindowState {
  /** Normalized project root (the `workflow_attach_project` result). */
  root: string;
  /** The session this window serves; null while the start form is shown. */
  intakeId: string | null;
  session: IntakeSessionView | null;
  /** Draft attachments not sent yet. */
  drafts: AttachmentMeta[];
  workflows: Workflow[];
  /**
   * Raw provider probes; localized at render time (`availabilityFromProbes`)
   * so the reasons follow language changes. Empty when probing failed.
   */
  providers: ProviderProbe[];
  /** Forge probe; null while loading or when the probe failed. */
  forge: ForgeProbe | null;
  loading: boolean;
  /** A message send is in flight. */
  sending: boolean;
  /** `create` is in flight. */
  creating: boolean;
  /** Localized load failure; null when the last load succeeded. */
  error: string | null;
  /** Attaches the project and loads workflows, providers, forge and (with an id) the session and drafts. */
  init(root: string, intakeId: string | null): Promise<void>;
  /**
   * Creates a session, opens its own window and closes this one (see the
   * comment in the implementation).
   */
  create(input: IntakeCreateInput): Promise<void>;
  /** Reloads the session and its drafts. */
  reload(): Promise<void>;
  /** Reloads the workflow list. */
  reloadWorkflows(): Promise<void>;
  /** Sends a message with drafts; resolves to whether it was accepted. */
  send(text: string, draftIds: string[]): Promise<boolean>;
  retry(): Promise<void>;
  cancelTurn(): Promise<void>;
  addDraftFromPath(path: string): Promise<void>;
  addDraftFromBytes(name: string, base64: string): Promise<void>;
  removeDraft(id: string): Promise<void>;
}

/** Incremented by every `init`; an older init must not overwrite a newer one. */
let initSeq = 0;
/** Incremented by every session load; only the newest result is applied. */
let sessionSeq = 0;
/** Incremented by every workflow list load; only the newest result is applied. */
let workflowsSeq = 0;

function initialState() {
  return {
    root: "",
    intakeId: null,
    session: null,
    drafts: [],
    workflows: [],
    providers: [],
    forge: null,
    loading: false,
    sending: false,
    creating: false,
    error: null,
  } satisfies Partial<IntakeWindowState>;
}

export const useIntakeStore = create<IntakeWindowState>((set, get) => {
  /** Loads the session and drafts, applying the result only if no newer load started. */
  const loadSession = async (root: string, intakeId: string) => {
    const seq = ++sessionSeq;
    const [session, drafts] = await Promise.all([
      workflowApi.intakeGet(root, intakeId),
      workflowApi.intakeListDrafts(root, intakeId),
    ]);
    if (seq !== sessionSeq || get().intakeId !== intakeId) return;
    set({ session, drafts });
  };

  /**
   * Runs a command against this window's session. Failures are shown in a
   * dialog, except `TRANSITION_CONFLICT`, which reloads silently. Resolves to
   * undefined on failure or when no session is served.
   */
  const act = async <T>(fn: (root: string, intakeId: string) => Promise<T>): Promise<T | undefined> => {
    const { root, intakeId } = get();
    if (!intakeId) return undefined;
    try {
      return await fn(root, intakeId);
    } catch (err) {
      if (isCommandError(err) && err.code === TRANSITION_CONFLICT) {
        // The session changed underneath: show its real state instead of an error.
        await get().reload();
      } else {
        void showMessage(formatCommandError(err), {
          title: i18n.t("workflow:intake.actionFailed"),
          kind: "error",
        });
      }
      return undefined;
    }
  };

  return {
    ...initialState(),

    async init(root, intakeId) {
      const seq = ++initSeq;
      sessionSeq++;
      set({ ...initialState(), root, intakeId, loading: true });
      try {
        const normalized = await workflowApi.attach(root);
        if (seq !== initSeq) return;
        set({ root: normalized });
        const [list, providers, forge] = await Promise.all([
          workflowApi.listWorkflows(normalized),
          // Without probes the start form shows providers without availability.
          workflowApi.probeProviders().catch(() => [] as ProviderProbe[]),
          // Without a forge probe the start form reports the check as failed.
          workflowApi.forgeProbe(normalized).catch(() => null),
          intakeId ? loadSession(normalized, intakeId) : Promise.resolve(),
        ]);
        if (seq !== initSeq) return;
        set({ workflows: list.workflows, providers, forge, loading: false });
      } catch (err) {
        if (seq !== initSeq) return;
        set({ loading: false, error: formatCommandError(err) });
      }
    },

    async create(input) {
      const { root, creating } = get();
      if (creating) return;
      set({ creating: true });
      let view: IntakeSessionView;
      try {
        view = await workflowApi.intakeCreate(root, input.workflowId, input.kind, input.provider, input.model);
      } catch (err) {
        set({ creating: false });
        void showMessage(formatCommandError(err), { title: i18n.t("workflow:intake.start.failed"), kind: "error" });
        return;
      }
      // Windows are keyed by label and this one is `intake-new-*`: if it kept
      // serving the new session, opening the session from the main window
      // would create a second `intake-<id>` window for it. So the session is
      // handed to its own `intake-<id>` window (which loads it) and this one
      // closes.
      try {
        await workflowApi.openIntakeWindow(root, view.id);
      } catch (err) {
        // The session exists but has no window: serve it here rather than lose it.
        sessionSeq++;
        set({ creating: false, intakeId: view.id, session: view, drafts: [] });
        void showMessage(formatCommandError(err), { title: i18n.t("workflow:intake.start.failed"), kind: "error" });
        return;
      }
      try {
        await getCurrentWindow().close();
      } catch (err) {
        console.error("[intake] closing the start window failed", err);
        set({ creating: false });
      }
    },

    async reload() {
      const { root, intakeId } = get();
      if (!intakeId) return;
      try {
        await loadSession(root, intakeId);
        if (get().intakeId === intakeId) set({ error: null });
      } catch (err) {
        if (get().intakeId === intakeId) set({ error: formatCommandError(err) });
      }
    },

    async reloadWorkflows() {
      const root = get().root;
      const seq = ++workflowsSeq;
      try {
        const list = await workflowApi.listWorkflows(root);
        if (seq === workflowsSeq && sameRoot(get().root, root)) set({ workflows: list.workflows });
      } catch (err) {
        // Keep the current list; the next change event or reopening retries.
        console.error("[intake] reloading workflows failed", err);
      }
    },

    async send(text, draftIds) {
      if (get().sending) return false;
      set({ sending: true });
      try {
        const view = await act((root, id) => workflowApi.intakeSend(root, id, text, draftIds));
        if (!view) return false;
        sessionSeq++;
        const sent = new Set(draftIds);
        set((s) => ({ session: view, drafts: s.drafts.filter((d) => !sent.has(d.id)) }));
        return true;
      } finally {
        set({ sending: false });
      }
    },

    async retry() {
      const view = await act((root, id) => workflowApi.intakeRetry(root, id));
      if (view) {
        sessionSeq++;
        set({ session: view });
      }
    },

    async cancelTurn() {
      const cancelled = await act((root, id) => workflowApi.intakeCancelTurn(root, id));
      if (cancelled !== undefined) await get().reload();
    },

    async addDraftFromPath(path) {
      const meta = await act((root, id) => workflowApi.intakeAddDraftPath(root, id, path));
      if (meta) set((s) => ({ drafts: [...s.drafts, meta] }));
    },

    async addDraftFromBytes(name, base64) {
      const meta = await act((root, id) => workflowApi.intakeAddDraftBytes(root, id, name, base64));
      if (meta) set((s) => ({ drafts: [...s.drafts, meta] }));
    },

    async removeDraft(draftId) {
      const done = await act(async (root, id) => {
        await workflowApi.intakeRemoveDraft(root, id, draftId);
        return true;
      });
      if (done) set((s) => ({ drafts: s.drafts.filter((d) => d.id !== draftId) }));
    },
  };
});

/**
 * Keeps the window's state current without polling: `intake-changed` for this
 * project and intake reloads the session (turn start/end, finalize steps,
 * changes from other windows); `workflows-changed` for this project reloads
 * the workflow list. Resolves to a function removing both listeners.
 */
export async function startIntakeEvents(): Promise<() => void> {
  const stopIntake = await subscribeIntakeChanged((e) => {
    const { root, intakeId } = useIntakeStore.getState();
    if (!intakeId || e.intakeId !== intakeId || !sameRoot(e.projectRoot, root)) return;
    void useIntakeStore.getState().reload();
  });
  let stopWorkflows: () => void;
  try {
    stopWorkflows = await subscribeWorkflowsChanged((e) => {
      const { root } = useIntakeStore.getState();
      if (!root || !sameRoot(e.projectRoot, root)) return;
      void useIntakeStore.getState().reloadWorkflows();
    });
  } catch (err) {
    // Do not leak the listener that did register.
    stopIntake();
    throw err;
  }
  return () => {
    stopIntake();
    stopWorkflows();
  };
}

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentMeta,
  ForgeProbe,
  IntakeChangedEvent,
  IntakeSessionView,
  Workflow,
  WorkflowsChangedEvent,
} from "@/shared/types/workflow";

const api = vi.hoisted(() => ({
  attach: vi.fn(),
  listWorkflows: vi.fn(),
  probeProviders: vi.fn(),
  forgeProbe: vi.fn(),
  intakeGet: vi.fn(),
  intakeListDrafts: vi.fn(),
  intakeCreate: vi.fn(),
  openIntakeWindow: vi.fn(),
  intakeSend: vi.fn(),
  intakeRetry: vi.fn(),
  intakeCancelTurn: vi.fn(),
  intakeAddDraftPath: vi.fn(),
  intakeAddDraftBytes: vi.fn(),
  intakeRemoveDraft: vi.fn(),
  intakeUpdateProposal: vi.fn(),
  intakeApplyDocUpdate: vi.fn(),
  intakeFinalize: vi.fn(),
  intakeReopen: vi.fn(),
  intakeAbandon: vi.fn(),
}));
const events = vi.hoisted(() => ({
  intake: null as ((e: IntakeChangedEvent) => void) | null,
  workflows: null as ((e: WorkflowsChangedEvent) => void) | null,
  unlistenIntake: vi.fn(),
  unlistenWorkflows: vi.fn(),
}));
const closeWindow = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const showMessage = vi.hoisted(() => vi.fn());

vi.mock("@/features/workflow/lib/workflow-api", () => ({
  workflowApi: api,
  subscribeIntakeChanged: vi.fn(async (handler: (e: IntakeChangedEvent) => void) => {
    events.intake = handler;
    return events.unlistenIntake;
  }),
  subscribeWorkflowsChanged: vi.fn(async (handler: (e: WorkflowsChangedEvent) => void) => {
    events.workflows = handler;
    return events.unlistenWorkflows;
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: closeWindow }) }));
vi.mock("@/stores/dialog-store", () => ({ showMessage }));
const emitTo = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/event", () => ({ emitTo }));

import i18n from "@/shared/i18n";
import { startIntakeEvents, useIntakeStore } from "../intake-store";

const ROOT = "C:\\proj";
const WORKFLOW = { id: "wf1", name: "WF", enabled: true, archived: false, stages: [] } as unknown as Workflow;
const FORGE: ForgeProbe = { repo: null, cliAvailable: false, authenticated: false };

function session(id: string, patch: Partial<IntakeSessionView> = {}): IntakeSessionView {
  return {
    schemaVersion: 1,
    id,
    workflowId: "wf1",
    kind: "feature",
    provider: "claude",
    model: null,
    status: "active",
    messages: [],
    lastQuestion: null,
    proposal: null,
    docUpdates: [],
    finalize: {
      stage: "ready",
      rootTaskId: null,
      issue: null,
      attachmentIds: [],
      skipIssue: false,
      issueCreating: false,
      lastError: null,
    },
    createdAt: "",
    updatedAt: "",
    busy: false,
    appliedDocPaths: [],
    ...patch,
  };
}

function draft(id: string): AttachmentMeta {
  return {
    schemaVersion: 1,
    id,
    originalName: `${id}.png`,
    storedName: `${id}.png`,
    mime: "image/png",
    size: 1,
    sha256: "",
    createdAt: "",
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("intake-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.intake = null;
    events.workflows = null;
    useIntakeStore.setState(useIntakeStore.getInitialState(), true);
    api.attach.mockResolvedValue(ROOT);
    api.listWorkflows.mockResolvedValue({ workflows: [WORKFLOW], warnings: [] });
    api.probeProviders.mockResolvedValue([{ provider: "claude", result: { kind: "available" } }]);
    api.forgeProbe.mockResolvedValue(FORGE);
    api.intakeGet.mockResolvedValue(session("i1"));
    api.intakeListDrafts.mockResolvedValue([draft("d1")]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("init", () => {
    it("loads workflows, providers and the forge without a session for a new intake", async () => {
      await useIntakeStore.getState().init("c:\\proj", null);
      const s = useIntakeStore.getState();
      expect(api.attach).toHaveBeenCalledWith("c:\\proj");
      expect(s.root).toBe(ROOT);
      expect(s.intakeId).toBeNull();
      expect(s.workflows).toEqual([WORKFLOW]);
      expect(s.providers).toEqual([{ provider: "claude", result: { kind: "available" } }]);
      expect(s.forge).toEqual(FORGE);
      expect(s.session).toBeNull();
      expect(s.loading).toBe(false);
      expect(s.error).toBeNull();
      expect(api.intakeGet).not.toHaveBeenCalled();
    });

    it("loads the session and its drafts for an existing intake", async () => {
      api.intakeGet.mockResolvedValue(session("i1", { busy: true }));
      await useIntakeStore.getState().init(ROOT, "i1");
      const s = useIntakeStore.getState();
      expect(api.intakeGet).toHaveBeenCalledWith(ROOT, "i1");
      expect(api.intakeListDrafts).toHaveBeenCalledWith(ROOT, "i1");
      expect(s.session?.id).toBe("i1");
      expect(s.session?.busy).toBe(true);
      expect(s.drafts.map((d) => d.id)).toEqual(["d1"]);
    });

    it("keeps going without provider or forge probes", async () => {
      api.probeProviders.mockRejectedValue(new Error("x"));
      api.forgeProbe.mockRejectedValue({ code: "FORGE_COMMAND_FAILED", message: "" });
      await useIntakeStore.getState().init(ROOT, null);
      const s = useIntakeStore.getState();
      expect(s.providers).toEqual([]);
      expect(s.forge).toBeNull();
      expect(s.error).toBeNull();
    });

    it("records a load failure", async () => {
      api.intakeGet.mockRejectedValue({ code: "INTAKE_NOT_FOUND", message: "i1" });
      await useIntakeStore.getState().init(ROOT, "i1");
      const s = useIntakeStore.getState();
      expect(s.loading).toBe(false);
      expect(s.session).toBeNull();
      expect(s.error).toContain("i1");
    });
  });

  describe("create", () => {
    it("opens the new session's own window and closes this one", async () => {
      await useIntakeStore.getState().init(ROOT, null);
      api.intakeCreate.mockResolvedValue(session("new1"));
      api.openIntakeWindow.mockResolvedValue("intake-new1");
      await useIntakeStore
        .getState()
        .create({ workflowId: "wf1", kind: "bug", provider: "codex", model: "m" });
      expect(api.intakeCreate).toHaveBeenCalledWith(ROOT, "wf1", "bug", "codex", "m");
      expect(api.openIntakeWindow).toHaveBeenCalledWith(ROOT, "new1");
      expect(closeWindow).toHaveBeenCalledTimes(1);
      expect(api.openIntakeWindow.mock.invocationCallOrder[0]).toBeLessThan(
        closeWindow.mock.invocationCallOrder[0],
      );
    });

    it("shows the error and keeps the form when creating fails", async () => {
      await useIntakeStore.getState().init(ROOT, null);
      api.intakeCreate.mockRejectedValue({ code: "WORKFLOW_NOT_FOUND", message: "wf1" });
      await useIntakeStore.getState().create({ workflowId: "wf1", kind: "feature", provider: "claude", model: null });
      expect(showMessage).toHaveBeenCalledWith(expect.stringContaining("wf1"), expect.objectContaining({ kind: "error" }));
      expect(api.openIntakeWindow).not.toHaveBeenCalled();
      expect(closeWindow).not.toHaveBeenCalled();
      expect(useIntakeStore.getState().creating).toBe(false);
    });

    it("keeps the start form locked and offers a retry when the session window cannot be opened", async () => {
      await useIntakeStore.getState().init(ROOT, null);
      api.intakeCreate.mockResolvedValue(session("new1"));
      api.openIntakeWindow.mockRejectedValueOnce({ code: "WORKFLOW_PROJECT_INVALID", message: "boom" });
      await useIntakeStore.getState().create({ workflowId: "wf1", kind: "feature", provider: "claude", model: null });
      let s = useIntakeStore.getState();
      expect(closeWindow).not.toHaveBeenCalled();
      // The session is never served by the start window.
      expect(s.intakeId).toBeNull();
      expect(s.session).toBeNull();
      expect(s.creating).toBe(false);
      expect(s.handOff).toEqual({ intakeId: "new1", windowOpened: false, error: expect.stringContaining("boom") });

      // A second Start is ignored: the session already exists.
      await useIntakeStore.getState().create({ workflowId: "wf1", kind: "feature", provider: "claude", model: null });
      expect(api.intakeCreate).toHaveBeenCalledTimes(1);

      api.openIntakeWindow.mockResolvedValueOnce("intake-new1");
      await useIntakeStore.getState().retryHandOff();
      s = useIntakeStore.getState();
      expect(api.openIntakeWindow).toHaveBeenLastCalledWith(ROOT, "new1");
      expect(s.handOff).toEqual({ intakeId: "new1", windowOpened: true, error: null });
      expect(closeWindow).toHaveBeenCalledTimes(1);
    });

    it("stays locked when closing fails after the session window opened", async () => {
      await useIntakeStore.getState().init(ROOT, null);
      api.intakeCreate.mockResolvedValue(session("new1"));
      api.openIntakeWindow.mockResolvedValue("intake-new1");
      closeWindow.mockRejectedValueOnce(new Error("no"));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await useIntakeStore.getState().create({ workflowId: "wf1", kind: "feature", provider: "claude", model: null });
      consoleError.mockRestore();
      const s = useIntakeStore.getState();
      expect(s.creating).toBe(false);
      expect(s.handOff).toEqual({ intakeId: "new1", windowOpened: true, error: null });
      expect(s.intakeId).toBeNull();
      await useIntakeStore.getState().retryHandOff();
      await useIntakeStore.getState().create({ workflowId: "wf1", kind: "feature", provider: "claude", model: null });
      expect(api.openIntakeWindow).toHaveBeenCalledTimes(1);
      expect(api.intakeCreate).toHaveBeenCalledTimes(1);
    });

    it("ignores a second create while one is in flight", async () => {
      await useIntakeStore.getState().init(ROOT, null);
      let resolve!: (v: IntakeSessionView) => void;
      api.intakeCreate.mockReturnValue(new Promise((r) => (resolve = r)));
      api.openIntakeWindow.mockResolvedValue("intake-new1");
      const input = { workflowId: "wf1", kind: "feature", provider: "claude", model: null } as const;
      const first = useIntakeStore.getState().create(input);
      await useIntakeStore.getState().create(input);
      resolve(session("new1"));
      await first;
      expect(api.intakeCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("conversation actions", () => {
    beforeEach(async () => {
      api.intakeListDrafts.mockResolvedValue([draft("d1"), draft("d2")]);
      await useIntakeStore.getState().init(ROOT, "i1");
    });

    it("sends with draft ids, stores the session and drops the sent drafts", async () => {
      api.intakeSend.mockResolvedValue(session("i1", { busy: true }));
      const ok = await useIntakeStore.getState().send("hello", ["d1"]);
      expect(ok).toBe(true);
      expect(api.intakeSend).toHaveBeenCalledWith(ROOT, "i1", "hello", ["d1"]);
      const s = useIntakeStore.getState();
      expect(s.session?.busy).toBe(true);
      expect(s.drafts.map((d) => d.id)).toEqual(["d2"]);
      expect(s.sending).toBe(false);
    });

    it("does not send twice while a send is in flight", async () => {
      let resolve!: (v: IntakeSessionView) => void;
      api.intakeSend.mockReturnValue(new Promise((r) => (resolve = r)));
      const first = useIntakeStore.getState().send("a", []);
      expect(useIntakeStore.getState().sending).toBe(true);
      expect(await useIntakeStore.getState().send("a", [])).toBe(false);
      resolve(session("i1"));
      await first;
      expect(api.intakeSend).toHaveBeenCalledTimes(1);
    });

    it("shows a failed send and reports it", async () => {
      api.intakeSend.mockRejectedValue({ code: "INTAKE_TURN_BUSY", message: "" });
      expect(await useIntakeStore.getState().send("a", [])).toBe(false);
      expect(showMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: "error" }));
    });

    it("reloads silently on TRANSITION_CONFLICT", async () => {
      api.intakeRetry.mockRejectedValue({ code: "TRANSITION_CONFLICT", message: "" });
      api.intakeGet.mockClear();
      await useIntakeStore.getState().retry();
      expect(showMessage).not.toHaveBeenCalled();
      expect(api.intakeGet).toHaveBeenCalledWith(ROOT, "i1");
    });

    it("retries and cancels the turn", async () => {
      api.intakeRetry.mockResolvedValue(session("i1", { busy: true }));
      await useIntakeStore.getState().retry();
      expect(useIntakeStore.getState().session?.busy).toBe(true);
      api.intakeCancelTurn.mockResolvedValue(true);
      api.intakeGet.mockResolvedValue(session("i1", { busy: false }));
      await useIntakeStore.getState().cancelTurn();
      expect(api.intakeCancelTurn).toHaveBeenCalledWith(ROOT, "i1");
      expect(useIntakeStore.getState().session?.busy).toBe(false);
    });

    it("runs one turn request at a time (send or retry)", async () => {
      let resolveSend!: (v: IntakeSessionView) => void;
      api.intakeSend.mockReturnValue(new Promise((r) => (resolveSend = r)));
      const sending = useIntakeStore.getState().send("a", []);
      await useIntakeStore.getState().retry();
      expect(api.intakeRetry).not.toHaveBeenCalled();
      resolveSend(session("i1"));
      await sending;

      let resolveRetry!: (v: IntakeSessionView) => void;
      api.intakeRetry.mockReturnValue(new Promise((r) => (resolveRetry = r)));
      const retrying = useIntakeStore.getState().retry();
      expect(useIntakeStore.getState().retrying).toBe(true);
      expect(await useIntakeStore.getState().send("b", [])).toBe(false);
      resolveRetry(session("i1"));
      await retrying;
      expect(useIntakeStore.getState().retrying).toBe(false);
      expect(api.intakeSend).toHaveBeenCalledTimes(1);
    });

    it("reports draft failures to the caller instead of showing them", async () => {
      api.intakeAddDraftBytes.mockRejectedValue({ code: "ATTACHMENT_TOO_MANY", message: "detail" });
      const onError = vi.fn();
      await useIntakeStore.getState().addDraftFromBytes("p.png", "AAAA", { onError });
      expect(onError).toHaveBeenCalledWith(i18n.t("workflow:codes.ATTACHMENT_TOO_MANY"), "ATTACHMENT_TOO_MANY");
      expect(showMessage).not.toHaveBeenCalled();
    });

    it("adds and removes drafts", async () => {
      api.intakeAddDraftPath.mockResolvedValue(draft("d3"));
      api.intakeAddDraftBytes.mockResolvedValue(draft("d4"));
      api.intakeRemoveDraft.mockResolvedValue(undefined);
      await useIntakeStore.getState().addDraftFromPath("C:\\a.png");
      await useIntakeStore.getState().addDraftFromBytes("p.png", "AAAA");
      await useIntakeStore.getState().removeDraft("d1");
      expect(api.intakeAddDraftPath).toHaveBeenCalledWith(ROOT, "i1", "C:\\a.png");
      expect(api.intakeAddDraftBytes).toHaveBeenCalledWith(ROOT, "i1", "p.png", "AAAA");
      expect(api.intakeRemoveDraft).toHaveBeenCalledWith(ROOT, "i1", "d1");
      expect(useIntakeStore.getState().drafts.map((d) => d.id)).toEqual(["d2", "d3", "d4"]);
    });
  });

  describe("events", () => {
    it("reloads on intake-changed for this intake only", async () => {
      await useIntakeStore.getState().init(ROOT, "i1");
      const stop = await startIntakeEvents();
      api.intakeGet.mockClear();
      api.intakeGet.mockResolvedValue(session("i1", { busy: true }));

      events.intake?.({ projectRoot: ROOT, intakeId: "other", status: "active", busy: true });
      events.intake?.({ projectRoot: "C:\\elsewhere", intakeId: "i1", status: "active", busy: true });
      await flush();
      expect(api.intakeGet).not.toHaveBeenCalled();

      events.intake?.({ projectRoot: ROOT, intakeId: "i1", status: "active", busy: true });
      await flush();
      expect(api.intakeGet).toHaveBeenCalledWith(ROOT, "i1");
      expect(useIntakeStore.getState().session?.busy).toBe(true);

      stop();
      expect(events.unlistenIntake).toHaveBeenCalled();
      expect(events.unlistenWorkflows).toHaveBeenCalled();
    });

    it("keeps the newest session when reloads finish out of order", async () => {
      await useIntakeStore.getState().init(ROOT, "i1");
      const stop = await startIntakeEvents();
      let resolveOld!: (v: IntakeSessionView) => void;
      api.intakeGet
        .mockReturnValueOnce(new Promise((r) => (resolveOld = r)))
        .mockResolvedValueOnce(session("i1", { busy: false, updatedAt: "new" }));
      events.intake?.({ projectRoot: ROOT, intakeId: "i1", status: "active", busy: true });
      events.intake?.({ projectRoot: ROOT, intakeId: "i1", status: "active", busy: false });
      await flush();
      resolveOld(session("i1", { busy: true, updatedAt: "old" }));
      await flush();
      expect(useIntakeStore.getState().session?.updatedAt).toBe("new");
      stop();
    });

    it("applies an event reload that races init and ignores init's outdated result", async () => {
      const stop = await startIntakeEvents();
      let resolveInit!: (v: IntakeSessionView) => void;
      api.intakeGet
        .mockReturnValueOnce(new Promise((r) => (resolveInit = r)))
        .mockResolvedValueOnce(session("i1", { busy: false, updatedAt: "new" }));
      const init = useIntakeStore.getState().init(ROOT, "i1");
      await flush();
      events.intake?.({ projectRoot: ROOT, intakeId: "i1", status: "active", busy: false });
      await flush();
      resolveInit(session("i1", { busy: true, updatedAt: "old" }));
      await init;
      const s = useIntakeStore.getState();
      expect(s.session?.updatedAt).toBe("new");
      expect(s.loading).toBe(false);
      expect(s.error).toBeNull();
      stop();
    });

    it("ignores a failure of an outdated load", async () => {
      const stop = await startIntakeEvents();
      let rejectInit!: (e: unknown) => void;
      api.intakeGet
        .mockReturnValueOnce(new Promise((_, r) => (rejectInit = r)))
        .mockResolvedValueOnce(session("i1", { updatedAt: "new" }));
      const init = useIntakeStore.getState().init(ROOT, "i1");
      await flush();
      events.intake?.({ projectRoot: ROOT, intakeId: "i1", status: "active", busy: false });
      await flush();
      rejectInit({ code: "STORE_IO", message: "old" });
      await init;
      const s = useIntakeStore.getState();
      expect(s.session?.updatedAt).toBe("new");
      expect(s.error).toBeNull();
      stop();
    });

    it("ignores a failed reload overtaken by a newer one", async () => {
      await useIntakeStore.getState().init(ROOT, "i1");
      let rejectOld!: (e: unknown) => void;
      api.intakeGet
        .mockReturnValueOnce(new Promise((_, r) => (rejectOld = r)))
        .mockResolvedValueOnce(session("i1", { updatedAt: "new" }));
      const first = useIntakeStore.getState().reload();
      await useIntakeStore.getState().reload();
      rejectOld({ code: "STORE_IO", message: "old" });
      await first;
      expect(useIntakeStore.getState().error).toBeNull();
      expect(useIntakeStore.getState().session?.updatedAt).toBe("new");
    });

    it("reloads workflows on workflows-changed for this project", async () => {
      await useIntakeStore.getState().init(ROOT, null);
      const stop = await startIntakeEvents();
      const renamed = { ...WORKFLOW, name: "Renamed" };
      api.listWorkflows.mockClear();
      api.listWorkflows.mockResolvedValue({ workflows: [renamed], warnings: [] });

      events.workflows?.({ projectRoot: "C:\\elsewhere" });
      await flush();
      expect(api.listWorkflows).not.toHaveBeenCalled();

      events.workflows?.({ projectRoot: ROOT });
      await flush();
      expect(api.listWorkflows).toHaveBeenCalledWith(ROOT);
      expect(useIntakeStore.getState().workflows).toEqual([renamed]);
      stop();
    });
  });

  describe("review and finalize actions", () => {
    beforeEach(async () => {
      api.intakeGet.mockResolvedValue(session("i1", { proposal: { title: "T", body: "B" }, updatedAt: "u1" }));
      await useIntakeStore.getState().init(ROOT, "i1");
    });

    it("saves the proposal and reports validation failures inline", async () => {
      api.intakeUpdateProposal.mockResolvedValue(session("i1", { proposal: { title: "New", body: "Body" } }));
      const onError = vi.fn();
      expect(await useIntakeStore.getState().updateProposal("New", "Body", onError)).toBe(true);
      expect(api.intakeUpdateProposal).toHaveBeenCalledWith(ROOT, "i1", "New", "Body");
      expect(useIntakeStore.getState().session?.proposal?.title).toBe("New");

      api.intakeUpdateProposal.mockRejectedValue({ code: "INTAKE_PROPOSAL_TITLE_INVALID", message: "" });
      expect(await useIntakeStore.getState().updateProposal("", "Body", onError)).toBe(false);
      expect(onError).toHaveBeenCalledWith(expect.any(String), "INTAKE_PROPOSAL_TITLE_INVALID");
      expect(showMessage).not.toHaveBeenCalled();
    });

    it("applies or rejects a doc update and passes the failure code to the caller", async () => {
      api.intakeApplyDocUpdate.mockResolvedValue(session("i1", { appliedDocPaths: ["docs/a.md"] }));
      expect(await useIntakeStore.getState().applyDocUpdate("p1", true)).toBe(true);
      expect(api.intakeApplyDocUpdate).toHaveBeenCalledWith(ROOT, "i1", "p1", true);
      expect(useIntakeStore.getState().session?.appliedDocPaths).toEqual(["docs/a.md"]);

      api.intakeApplyDocUpdate.mockRejectedValue({ code: "INTAKE_DOC_CHANGED_SINCE_PROPOSAL", message: "" });
      const onError = vi.fn();
      expect(await useIntakeStore.getState().applyDocUpdate("p1", true, onError)).toBe(false);
      expect(onError).toHaveBeenCalledWith(expect.any(String), "INTAKE_DOC_CHANGED_SINCE_PROPOSAL");
    });

    it("finalizes once at a time and stores the finished session", async () => {
      let resolve!: (v: IntakeSessionView) => void;
      api.intakeFinalize.mockReturnValue(new Promise((r) => (resolve = r)));
      const first = useIntakeStore.getState().finalize(false);
      expect(useIntakeStore.getState().finalizeAction).toBe("finalize");
      await useIntakeStore.getState().finalize(true);
      await useIntakeStore.getState().reopen();
      expect(api.intakeFinalize).toHaveBeenCalledTimes(1);
      expect(api.intakeReopen).not.toHaveBeenCalled();
      resolve(session("i1", { status: "done" }));
      await first;
      expect(api.intakeFinalize).toHaveBeenCalledWith(ROOT, "i1", false);
      expect(useIntakeStore.getState().session?.status).toBe("done");
      expect(useIntakeStore.getState().finalizeAction).toBeNull();
      expect(useIntakeStore.getState().finalizeError).toBeNull();
    });

    it("keeps an early ISSUE_TRACKING_UNAVAILABLE inline and probes the forge again", async () => {
      api.intakeFinalize.mockRejectedValue({ code: "ISSUE_TRACKING_UNAVAILABLE", message: "" });
      api.forgeProbe.mockClear();
      api.intakeGet.mockClear();
      await useIntakeStore.getState().finalize(false);
      expect(showMessage).not.toHaveBeenCalled();
      expect(api.intakeGet).toHaveBeenCalledWith(ROOT, "i1");
      expect(api.forgeProbe).toHaveBeenCalledWith(ROOT);
      expect(useIntakeStore.getState().finalizeError).toEqual({
        code: "ISSUE_TRACKING_UNAVAILABLE",
        text: expect.any(String),
        updatedAt: "u1",
      });

      api.intakeFinalize.mockResolvedValue(session("i1", { status: "done" }));
      await useIntakeStore.getState().finalize(true);
      expect(api.intakeFinalize).toHaveBeenLastCalledWith(ROOT, "i1", true);
      expect(useIntakeStore.getState().finalizeError).toBeNull();
    });

    it("reopens and abandons; failures are shown and reload the session", async () => {
      api.intakeReopen.mockResolvedValue(session("i1", { status: "active" }));
      await useIntakeStore.getState().reopen();
      expect(api.intakeReopen).toHaveBeenCalledWith(ROOT, "i1");
      api.intakeAbandon.mockResolvedValue(session("i1", { status: "abandoned" }));
      await useIntakeStore.getState().abandon();
      expect(useIntakeStore.getState().session?.status).toBe("abandoned");

      api.intakeReopen.mockRejectedValue({ code: "INTAKE_NOT_REOPENABLE", message: "" });
      api.intakeGet.mockClear();
      await useIntakeStore.getState().reopen();
      expect(showMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: "error" }));
      expect(api.intakeGet).toHaveBeenCalledWith(ROOT, "i1");
      expect(useIntakeStore.getState().finalizeAction).toBeNull();
    });

    it("hands the created task to the main window and closes this one", async () => {
      useIntakeStore.setState({
        session: session("i1", {
          status: "done",
          finalize: { ...session("i1").finalize, stage: "done", rootTaskId: "t1" },
        }),
      });
      await useIntakeStore.getState().openTask();
      expect(emitTo).toHaveBeenCalledWith("main", "workflow://open-task", { projectRoot: ROOT, taskId: "t1" });
      expect(closeWindow).toHaveBeenCalled();
    });
  });
});

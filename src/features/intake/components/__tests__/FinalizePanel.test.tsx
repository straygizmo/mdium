// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalizeState, ForgeProbe, IntakeSessionView, IssueRef, Workflow } from "@/shared/types/workflow";

const api = vi.hoisted(() => ({
  intakeGet: vi.fn(),
  intakeListDrafts: vi.fn(),
  intakeFinalize: vi.fn(),
  intakeReopen: vi.fn(),
  intakeAbandon: vi.fn(),
  forgeProbe: vi.fn(),
}));
vi.mock("@/features/workflow/lib/workflow-api", () => ({
  workflowApi: api,
  subscribeIntakeChanged: vi.fn(),
  subscribeWorkflowsChanged: vi.fn(),
}));
const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
/** The acknowledgement the main window sends for the next open-task request. */
const mainWindow = vi.hoisted(() => ({
  ack: null as ((e: { payload: unknown }) => void) | null,
  answer: { handled: true } as { handled: boolean },
}));
const emitTo = vi.hoisted(() =>
  vi.fn(async (_target: string, _event: string, payload: { taskId: string }) => {
    mainWindow.ack?.({ payload: { taskId: payload.taskId, handled: mainWindow.answer.handled } });
  }),
);
const listen = vi.hoisted(() =>
  vi.fn(async (_event: string, handler: (e: { payload: unknown }) => void) => {
    mainWindow.ack = handler;
    return () => {
      mainWindow.ack = null;
    };
  }),
);
vi.mock("@tauri-apps/api/event", () => ({ emitTo, listen }));
const closeWindow = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: closeWindow, label: "intake-i1" }) }));
const dialogs = vi.hoisted(() => ({ showMessage: vi.fn(), showConfirm: vi.fn() }));
vi.mock("@/stores/dialog-store", () => dialogs);

import i18n from "@/shared/i18n";
import { formatCode } from "@/features/workflow/lib/format";
import { useIntakeStore } from "../../intake-store";
import { AbandonIntakeButton, FinalizePanel } from "../FinalizePanel";
import { reviewSession } from "./review-test-utils";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: "workflow", ...opts });
const ROOT = "C:\\proj";
const FORGE_OK: ForgeProbe = {
  repo: { kind: "github", host: "github.com", path: "o/r" },
  cliAvailable: true,
  authenticated: true,
};
const FORGE_NO_REPO: ForgeProbe = { repo: null, cliAvailable: true, authenticated: true };
const ISSUE: IssueRef = { kind: "github", host: "github.com", path: "o/r", number: 7, url: "https://github.com/o/r/issues/7" };

function workflow(issueTracking: "auto" | "off"): Workflow {
  return { id: "wf1", name: "WF", enabled: true, archived: false, stages: [], issueTracking } as unknown as Workflow;
}

function finalizing(patch: Partial<FinalizeState>, extra: Partial<IntakeSessionView> = {}): IntakeSessionView {
  const base = reviewSession();
  return reviewSession({ status: "finalizing", finalize: { ...base.finalize, rootTaskId: "t1", ...patch }, ...extra });
}

/** Button classes of the finalize actions, in display order. */
const ACTIONS = ["submit", "retry", "skip", "reopen", "abandon", "open-task"] as const;

describe("FinalizePanel", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    useIntakeStore.setState(useIntakeStore.getInitialState(), true);
    dialogs.showConfirm.mockResolvedValue(true);
    mainWindow.answer.handled = true;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
  });

  function Wrapper() {
    const current = useIntakeStore((s) => s.session);
    return current ? <FinalizePanel session={current} /> : null;
  }

  async function mount(
    view: IntakeSessionView,
    { tracking = "auto", forge = FORGE_OK }: { tracking?: "auto" | "off"; forge?: ForgeProbe | null } = {},
  ) {
    api.intakeGet.mockResolvedValue(view);
    api.intakeListDrafts.mockResolvedValue([]);
    api.forgeProbe.mockResolvedValue(forge);
    useIntakeStore.setState({
      root: ROOT,
      intakeId: view.id,
      session: view,
      workflows: [workflow(tracking)],
      forge,
    });
    root = createRoot(container);
    await act(async () => root?.render(<Wrapper />));
  }

  const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T & Element>(sel);
  const shownActions = () => ACTIONS.filter((a) => q(`.intake-finalize__${a}`) !== null);

  async function click(el: Element | null) {
    await act(async () => (el as HTMLElement).click());
  }

  it("lists the planned steps and finalizes", async () => {
    useIntakeStore.setState({ drafts: [] });
    await mount(reviewSession());
    await act(async () => useIntakeStore.setState({ drafts: [{ id: "d1" }, { id: "d2" }] as never }));
    const steps = [...container.querySelectorAll(".intake-finalize__steps li")].map((li) => li.textContent);
    expect(steps).toEqual([
      t("intake.finalize.stepIssue", { host: "github.com", path: "o/r" }),
      t("intake.finalize.stepAttachments", { count: 2 }),
      t("intake.finalize.stepTask"),
    ]);
    expect(shownActions()).toEqual(["submit"]);

    api.intakeFinalize.mockResolvedValue(
      finalizing({ stage: "done", issue: ISSUE }, { status: "done" }),
    );
    await click(q(".intake-finalize__submit"));
    expect(api.intakeFinalize).toHaveBeenCalledWith(ROOT, "i1", false);
  });

  it("plans no Issue when the workflow does not track Issues", async () => {
    await mount(reviewSession(), { tracking: "off" });
    const steps = [...container.querySelectorAll(".intake-finalize__steps li")].map((li) => li.textContent);
    expect(steps).toEqual([t("intake.finalize.stepNoIssue"), t("intake.finalize.stepTask")]);
  });

  it("warns about pending doc updates and cannot finalize while the agent replies", async () => {
    await mount(
      reviewSession({
        busy: true,
        docUpdates: [{ id: "p", path: "a.md", content: "", status: "pending", reason: null, baseSha256: null }],
      }),
    );
    expect(container.textContent).toContain(t("intake.finalize.pendingDocs"));
    expect(q<HTMLButtonElement>(".intake-finalize__submit")?.disabled).toBe(true);
  });

  it("opens the task in the main window and closes after success", async () => {
    await mount(finalizing({ stage: "done", issue: ISSUE }, { status: "done" }));
    expect(container.textContent).toContain(t("intake.finalize.done"));
    expect(shownActions()).toEqual(["open-task"]);

    await click(q(".intake-finalize__issue-link"));
    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: ISSUE.url });
    expect(dialogs.showMessage).not.toHaveBeenCalled();
    invoke.mockRejectedValueOnce(new Error("no browser"));
    await click(q(".intake-finalize__issue-link"));
    expect(dialogs.showMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: t("intake.issue.openFailed"), kind: "error" }),
    );

    await click(q(".intake-finalize__open-task"));
    expect(emitTo).toHaveBeenCalledWith("main", "workflow://open-task", {
      projectRoot: ROOT,
      taskId: "t1",
      sender: "intake-i1",
    });
    expect(closeWindow).toHaveBeenCalled();
    expect(q(".intake-finalize__unhandled")).toBeNull();
  });

  it("stays open and explains when the main window cannot show the task", async () => {
    mainWindow.answer.handled = false;
    await mount(finalizing({ stage: "done" }, { status: "done" }));
    await click(q(".intake-finalize__open-task"));
    expect(closeWindow).not.toHaveBeenCalled();
    expect(q(".intake-finalize__unhandled")?.textContent).toBe(t("intake.finalize.openTaskUnhandled"));
    expect(q<HTMLButtonElement>(".intake-finalize__open-task")?.disabled).toBe(false);
  });

  it("shows a finalize running elsewhere and hides every action", async () => {
    await mount(finalizing({ lastError: "FORGE_TIMEOUT" }, { finalizeRunning: true }));
    expect(q(".intake-finalize__progress")?.textContent).toBe(t("intake.finalize.finalizing"));
    expect(q(".intake-finalize__error")).toBeNull();
    expect(container.textContent).not.toContain(t("intake.finalize.failed"));
    expect(shownActions()).toEqual([]);
  });

  it("shows a finalize that is starting while the session is still active", async () => {
    await mount(reviewSession({ finalizeRunning: true }));
    expect(q(".intake-finalize__progress")?.textContent).toBe(t("intake.finalize.finalizing"));
    expect(shownActions()).toEqual([]);
  });

  it("offers continuing without an Issue when tracking is unavailable before finalizing starts", async () => {
    await mount(reviewSession(), { forge: FORGE_NO_REPO });
    api.intakeFinalize.mockRejectedValueOnce({ code: "ISSUE_TRACKING_UNAVAILABLE", message: "" });
    await click(q(".intake-finalize__submit"));
    expect(dialogs.showMessage).not.toHaveBeenCalled();
    expect(q(".intake-finalize__error")?.textContent).toBe(
      t("intake.finalize.issueUnavailable", { reason: t("intake.start.forgeReason.noRepo") }),
    );
    expect(shownActions()).toEqual(["submit", "skip"]);

    api.intakeFinalize.mockResolvedValue(finalizing({ stage: "done", skipIssue: true }, { status: "done" }));
    await click(q(".intake-finalize__skip"));
    expect(dialogs.showConfirm).toHaveBeenCalledWith(
      t("intake.finalize.continueWithoutIssueConfirm"),
      expect.anything(),
    );
    expect(api.intakeFinalize).toHaveBeenLastCalledWith(ROOT, "i1", true);
  });

  it("does not skip the Issue when the confirmation is declined", async () => {
    dialogs.showConfirm.mockResolvedValue(false);
    await mount(finalizing({ lastError: "FORGE_TIMEOUT" }));
    await click(q(".intake-finalize__skip"));
    expect(api.intakeFinalize).not.toHaveBeenCalled();
  });

  it("offers every step back while nothing left the app", async () => {
    await mount(finalizing({ lastError: "FORGE_TIMEOUT" }));
    expect(container.textContent).toContain(t("intake.finalize.failed"));
    expect(q(".intake-finalize__error")?.textContent).toBe(formatCode("FORGE_TIMEOUT"));
    expect(shownActions()).toEqual(["retry", "skip", "reopen", "abandon"]);

    api.intakeFinalize.mockResolvedValue(finalizing({ stage: "done" }, { status: "done" }));
    await click(q(".intake-finalize__retry"));
    expect(api.intakeFinalize).toHaveBeenCalledWith(ROOT, "i1", false);
  });

  it("explains unavailable tracking recorded while finalizing", async () => {
    await mount(finalizing({ lastError: "ISSUE_TRACKING_UNAVAILABLE" }), { forge: { ...FORGE_OK, authenticated: false } });
    expect(q(".intake-finalize__error")?.textContent).toBe(
      t("intake.finalize.issueUnavailable", { reason: t("intake.start.forgeReason.unauthenticated") }),
    );
    expect(shownActions()).toEqual(["retry", "skip", "reopen", "abandon"]);
  });

  it("only retries or skips while the Issue may have been created", async () => {
    await mount(finalizing({ lastError: "FORGE_COMMAND_FAILED", issueCreating: true }));
    expect(container.textContent).toContain(t("intake.finalize.issueCreating"));
    expect(shownActions()).toEqual(["retry", "skip"]);

    api.intakeFinalize.mockResolvedValue(finalizing({ stage: "done", skipIssue: true }, { status: "done" }));
    await click(q(".intake-finalize__skip"));
    expect(dialogs.showConfirm).toHaveBeenCalledWith(
      `${t("intake.finalize.continueWithoutIssueConfirm")}\n\n${t("intake.finalize.continueWithoutIssueCreatingConfirm")}`,
      expect.anything(),
    );
    expect(api.intakeFinalize).toHaveBeenCalledWith(ROOT, "i1", true);
  });

  it("shows this window's latest failure over the recorded one", async () => {
    const view = finalizing({ lastError: "FORGE_TIMEOUT" });
    await mount(view);
    api.intakeFinalize.mockRejectedValue({ code: "INTAKE_FINALIZE_IN_PROGRESS", message: "" });
    await click(q(".intake-finalize__retry"));
    expect(q(".intake-finalize__error")?.textContent).toBe(formatCode("INTAKE_FINALIZE_IN_PROGRESS"));
  });

  it("offers skipping the Issue when tracking is unavailable and the workflow is not loaded", async () => {
    await mount(reviewSession(), { forge: FORGE_NO_REPO });
    await act(async () => useIntakeStore.setState({ workflows: [] }));
    api.intakeFinalize.mockRejectedValueOnce({ code: "ISSUE_TRACKING_UNAVAILABLE", message: "" });
    await click(q(".intake-finalize__submit"));
    expect(shownActions()).toEqual(["submit", "skip"]);
  });

  it("only retries once the Issue exists", async () => {
    await mount(finalizing({ stage: "issue_created", issue: ISSUE, lastError: "ATTACHMENT_IO" }));
    expect(container.textContent).toContain(t("intake.finalize.stage.issue_created"));
    expect(shownActions()).toEqual(["retry"]);
  });

  it("does not offer skipping the Issue when the workflow does not track Issues", async () => {
    await mount(finalizing({ lastError: "ATTACHMENT_IO" }), { tracking: "off" });
    expect(shownActions()).toEqual(["retry", "reopen", "abandon"]);
  });

  it("does not offer skipping again once the Issue was skipped", async () => {
    await mount(finalizing({ stage: "attachments_committed", skipIssue: true, lastError: "STORE_IO" }));
    expect(shownActions()).toEqual(["retry"]);
  });

  it("disables every action while one is in flight", async () => {
    let resolve!: (v: IntakeSessionView) => void;
    api.intakeFinalize.mockReturnValue(new Promise((r) => (resolve = r)));
    await mount(finalizing({ lastError: "FORGE_TIMEOUT" }));
    await click(q(".intake-finalize__retry"));
    expect(container.textContent).toContain(t("intake.finalize.finalizing"));
    for (const action of ["retry", "skip", "reopen", "abandon"]) {
      expect(q<HTMLButtonElement>(`.intake-finalize__${action}`)?.disabled).toBe(true);
    }
    await click(q(".intake-finalize__retry"));
    expect(api.intakeFinalize).toHaveBeenCalledTimes(1);
    await act(async () => resolve(finalizing({ stage: "done" }, { status: "done" })));
  });

  it("returns to the conversation", async () => {
    api.intakeReopen.mockResolvedValue(reviewSession());
    await mount(finalizing({ lastError: "FORGE_TIMEOUT" }));
    await click(q(".intake-finalize__reopen"));
    expect(api.intakeReopen).toHaveBeenCalledWith(ROOT, "i1");
    expect(shownActions()).toEqual(["submit"]);
  });

  it("abandons after confirmation only", async () => {
    dialogs.showConfirm.mockResolvedValueOnce(false);
    await mount(finalizing({ lastError: "FORGE_TIMEOUT" }));
    await click(q(".intake-finalize__abandon"));
    expect(api.intakeAbandon).not.toHaveBeenCalled();

    api.intakeAbandon.mockResolvedValue(finalizing({}, { status: "abandoned" }));
    await click(q(".intake-finalize__abandon"));
    expect(dialogs.showConfirm).toHaveBeenLastCalledWith(t("intake.finalize.abandonConfirm"), expect.anything());
    expect(api.intakeAbandon).toHaveBeenCalledWith(ROOT, "i1");
    expect(container.innerHTML).toBe("");
  });

  it("offers abandoning an active intake", async () => {
    api.intakeAbandon.mockResolvedValue(reviewSession({ status: "abandoned" }));
    useIntakeStore.setState({ root: ROOT, intakeId: "i1", session: reviewSession() });
    root = createRoot(container);
    await act(async () => root?.render(<AbandonIntakeButton />));
    const button = q<HTMLButtonElement>(".intake-abandon")!;
    expect(button.textContent).toBe(t("intake.conversation.abandon"));
    await click(button);
    expect(dialogs.showConfirm).toHaveBeenCalledWith(t("intake.conversation.abandonConfirm"), expect.anything());
    expect(api.intakeAbandon).toHaveBeenCalledWith(ROOT, "i1");
    expect(q(".intake-abandon")).toBeNull();
  });

  it("offers abandoning while the agent replies, but not while finalizing runs", async () => {
    useIntakeStore.setState({ root: ROOT, intakeId: "i1", session: reviewSession({ busy: true }) });
    root = createRoot(container);
    await act(async () => root?.render(<AbandonIntakeButton />));
    expect(q<HTMLButtonElement>(".intake-abandon")?.disabled).toBe(false);
    await act(async () => useIntakeStore.setState({ session: reviewSession({ finalizeRunning: true }) }));
    expect(q(".intake-abandon")).toBeNull();
  });
});

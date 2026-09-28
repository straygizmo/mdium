// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalizeState, IntakeMessage, IntakeSessionView } from "@/shared/types/workflow";

const api = vi.hoisted(() => ({
  intakeList: vi.fn(),
  intakeAbandon: vi.fn(),
  openIntakeWindow: vi.fn(),
}));
const dialogs = vi.hoisted(() => ({
  showMessage: vi.fn(),
  showConfirm: vi.fn(),
}));
vi.mock("../../lib/workflow-api", () => ({ workflowApi: api, subscribeWorkflowEvents: vi.fn() }));
vi.mock("@/stores/dialog-store", () => dialogs);

import i18n from "@/shared/i18n";
import { useWorkflowStore, type ProjectState } from "../../workflow-store";
import { IntakeList } from "../IntakeList";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "C:\\proj";

function finalize(patch: Partial<FinalizeState> = {}): FinalizeState {
  return {
    stage: "ready",
    rootTaskId: null,
    issue: null,
    attachmentIds: [],
    skipIssue: false,
    issueCreating: false,
    lastError: null,
    ...patch,
  };
}

function message(role: IntakeMessage["role"], text: string): IntakeMessage {
  return { id: `${role}-${text}`, role, text, draftIds: [], at: "2026-09-28T10:00:00Z", detail: null };
}

function session(id: string, patch: Partial<IntakeSessionView> = {}): IntakeSessionView {
  return {
    schemaVersion: 1,
    id,
    workflowId: "wf1",
    kind: "feature",
    provider: "codex",
    model: null,
    status: "active",
    messages: [],
    lastQuestion: null,
    proposal: null,
    docUpdates: [],
    finalize: finalize(),
    createdAt: "2026-09-28T09:00:00Z",
    updatedAt: "2026-09-28T10:00:00Z",
    busy: false,
    appliedDocPaths: [],
    ...patch,
  };
}

const initialStore = useWorkflowStore.getState();

function setProject(patch: Partial<ProjectState>) {
  const base: ProjectState = {
    root: ROOT,
    workflows: [],
    workflowWarnings: [],
    tasks: [],
    taskWarnings: [],
    runs: [],
    intakes: [],
    intakeWarnings: [],
    intakeError: null,
    progress: {},
    loading: false,
    refreshing: false,
    loaded: true,
    error: null,
  };
  useWorkflowStore.setState({ activeRoot: ROOT, projects: { [ROOT]: { ...base, ...patch } } });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("IntakeList", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    useWorkflowStore.setState(initialStore, true);
    api.intakeList.mockResolvedValue({ sessions: [], warnings: [] });
    api.openIntakeWindow.mockResolvedValue("intake-1");
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  async function render() {
    await act(async () => root.render(<IntakeList />));
  }

  function item(id: string) {
    return container.querySelector<HTMLElement>(`[data-intake-id="${id}"]`);
  }

  function button(scope: ParentNode, label: string) {
    return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  }

  it("lists active and finalizing sessions with title, kind, status, busy state and update time", async () => {
    setProject({
      intakes: [
        session("i1", { proposal: { title: "Export to PDF", body: "" }, messages: [message("user", "Hello")] }),
        session("i2", {
          kind: "bug",
          status: "finalizing",
          busy: true,
          messages: [message("assistant", "Hi"), message("user", "The save button\ncrashes")],
        }),
        session("i3"),
        session("i4", { status: "done" }),
        session("i5", { status: "abandoned" }),
      ],
    });
    await render();
    expect([...container.querySelectorAll("[data-intake-id]")].map((e) => e.getAttribute("data-intake-id"))).toEqual([
      "i1",
      "i2",
      "i3",
    ]);
    expect(item("i1")!.textContent).toContain("Export to PDF");
    expect(item("i1")!.textContent).toContain(i18n.t("workflow:intake.kind.feature"));
    expect(item("i1")!.textContent).toContain(i18n.t("workflow:intake.status.active"));
    expect(item("i1")!.textContent).not.toContain(i18n.t("workflow:intake.list.busy"));
    // Without a proposal the first user message's first line is the title.
    expect(item("i2")!.querySelector(".intake-list__title")!.textContent).toBe("The save button");
    expect(item("i2")!.textContent).toContain(i18n.t("workflow:intake.kind.bug"));
    expect(item("i2")!.textContent).toContain(i18n.t("workflow:intake.status.finalizing"));
    expect(item("i2")!.textContent).toContain(i18n.t("workflow:intake.list.busy"));
    expect(item("i3")!.querySelector(".intake-list__title")!.textContent).toBe(i18n.t("workflow:intake.list.untitled"));
    const time = new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "short" }).format(
      new Date("2026-09-28T10:00:00Z"),
    );
    expect(item("i1")!.textContent).toContain(i18n.t("workflow:intake.list.updatedAt", { time }));
  });

  it("shows the empty message, the load failure and warnings", async () => {
    setProject({
      intakes: [session("i4", { status: "done" })],
      intakeError: "boom",
      intakeWarnings: [{ file: ".mdium/intakes/x.json", message: "broken" }],
    });
    await render();
    expect(container.textContent).toContain(i18n.t("workflow:intake.list.empty"));
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(i18n.t("workflow:intake.list.loadFailed"));
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("boom");
    expect(container.textContent).toContain(i18n.t("workflow:intake.list.warnings", { count: 1 }));
    expect(container.textContent).toContain(".mdium/intakes/x.json");
  });

  it("re-renders when the store's intakes change", async () => {
    setProject({ intakes: [session("i1")] });
    await render();
    expect(item("i2")).toBeNull();
    api.intakeList.mockResolvedValue({ sessions: [session("i1"), session("i2")], warnings: [] });
    await act(async () => useWorkflowStore.getState().refreshIntakes(ROOT));
    expect(item("i2")).not.toBeNull();
  });

  it("opens the intake window of a session", async () => {
    setProject({ intakes: [session("i1")] });
    await render();
    await act(async () => button(item("i1")!, i18n.t("workflow:intake.list.open"))!.click());
    expect(api.openIntakeWindow).toHaveBeenCalledWith(ROOT, "i1");
  });

  it("disables Open while the window is opening and reports a failure", async () => {
    setProject({ intakes: [session("i1")] });
    await render();
    const pending = deferred<string>();
    api.openIntakeWindow.mockReturnValue(pending.promise);
    const open = button(item("i1")!, i18n.t("workflow:intake.list.open"))!;
    await act(async () => open.click());
    expect(open.disabled).toBe(true);
    await act(async () => open.click());
    expect(api.openIntakeWindow).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve("intake-1"));
    expect(open.disabled).toBe(false);

    api.openIntakeWindow.mockRejectedValue({ code: "WORKFLOW_PROJECT_INVALID", message: "no window" });
    await act(async () => open.click());
    expect(dialogs.showMessage).toHaveBeenCalledWith(
      expect.stringContaining("no window"),
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("abandons a session after confirmation and refreshes the list", async () => {
    setProject({ intakes: [session("i1", { proposal: { title: "Export", body: "" } })] });
    api.intakeAbandon.mockResolvedValue(session("i1", { status: "abandoned" }));
    api.intakeList.mockResolvedValue({ sessions: [session("i1", { status: "abandoned" })], warnings: [] });
    dialogs.showConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await render();
    const abandon = () => button(item("i1")!, i18n.t("workflow:intake.list.abandon"))!;

    await act(async () => abandon().click());
    expect(dialogs.showConfirm).toHaveBeenCalledWith(
      i18n.t("workflow:intake.list.abandonConfirm", { title: "Export" }),
      { kind: "warning" },
    );
    expect(api.intakeAbandon).not.toHaveBeenCalled();

    await act(async () => abandon().click());
    expect(api.intakeAbandon).toHaveBeenCalledWith(ROOT, "i1");
    expect(api.intakeList).toHaveBeenCalledWith(ROOT);
    expect(item("i1")).toBeNull();
  });

  it("shows an abandon failure and refreshes the real state", async () => {
    setProject({ intakes: [session("i1")] });
    api.intakeAbandon.mockRejectedValue({ code: "INTAKE_NOT_ACTIVE", message: "gone" });
    dialogs.showConfirm.mockResolvedValue(true);
    await render();
    await act(async () => button(item("i1")!, i18n.t("workflow:intake.list.abandon"))!.click());
    expect(dialogs.showMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: "error" }));
    expect(api.intakeList).toHaveBeenCalledWith(ROOT);
  });

  it("offers Abandon only while nothing has left the app", async () => {
    setProject({
      intakes: [
        session("active"),
        session("ready", { status: "finalizing", finalize: finalize({ lastError: "ISSUE_TRACKING_UNAVAILABLE" }) }),
        session("issued", {
          status: "finalizing",
          finalize: finalize({
            stage: "issue_created",
            issue: { kind: "github", host: "github.com", path: "o/r", number: 1, url: "u" },
          }),
        }),
        session("creating", { status: "finalizing", finalize: finalize({ issueCreating: true }) }),
      ],
    });
    await render();
    const label = i18n.t("workflow:intake.list.abandon");
    expect(button(item("active")!, label)).toBeDefined();
    expect(button(item("ready")!, label)).toBeDefined();
    expect(button(item("issued")!, label)).toBeUndefined();
    expect(button(item("creating")!, label)).toBeUndefined();
    // Every listed session can be opened.
    for (const id of ["active", "ready", "issued", "creating"]) {
      expect(button(item(id)!, i18n.t("workflow:intake.list.open"))).toBeDefined();
    }
  });
});

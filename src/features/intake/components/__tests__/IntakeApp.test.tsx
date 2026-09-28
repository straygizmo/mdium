// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntakeChangedEvent, IntakeSessionView, Workflow } from "@/shared/types/workflow";

const api = vi.hoisted(() => ({
  attach: vi.fn(),
  listWorkflows: vi.fn(),
  probeProviders: vi.fn(),
  forgeProbe: vi.fn(),
  intakeGet: vi.fn(),
  intakeListDrafts: vi.fn(),
}));
const unlistenIntake = vi.hoisted(() => vi.fn());
const unlistenWorkflows = vi.hoisted(() => vi.fn());
const subscribe = vi.hoisted(() => ({
  intake: vi.fn(async (_handler: unknown) => unlistenIntake),
  workflows: vi.fn(async (_handler: unknown) => unlistenWorkflows),
}));
vi.mock("@/features/workflow/lib/workflow-api", () => ({
  workflowApi: api,
  subscribeIntakeChanged: (handler: unknown) => subscribe.intake(handler),
  subscribeWorkflowsChanged: (handler: unknown) => subscribe.workflows(handler),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn() }) }));
vi.mock("@/stores/dialog-store", () => ({ showMessage: vi.fn() }));

import i18n from "@/shared/i18n";
import { useIntakeStore } from "../../intake-store";
import { IntakeApp } from "../IntakeApp";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: "workflow", ...opts });
const ROOT = "C:\\proj";
const SESSION = {
  id: "i1",
  status: "active",
  kind: "bug",
  busy: false,
  messages: [{ id: "m1", role: "user", text: "It crashes", draftIds: [], at: "2026-09-28T00:00:00Z", detail: null }],
  lastQuestion: null,
  proposal: null,
  docUpdates: [],
  appliedDocPaths: [],
  finalize: { stage: "ready", issue: null, skipIssue: false, issueCreating: false, lastError: null },
} as unknown as IntakeSessionView;
const WORKFLOW = {
  id: "wf1",
  name: "Flow",
  enabled: true,
  archived: false,
  stages: [],
  issueTracking: "off",
} as unknown as Workflow;

describe("IntakeApp", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    useIntakeStore.setState(useIntakeStore.getInitialState(), true);
    api.attach.mockResolvedValue(ROOT);
    api.listWorkflows.mockResolvedValue({ workflows: [WORKFLOW], warnings: [] });
    api.probeProviders.mockResolvedValue([]);
    api.forgeProbe.mockResolvedValue({ repo: null, cliAvailable: false, authenticated: false });
    api.intakeListDrafts.mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
  });

  async function mount(intakeId: string | null, workflowId: string | null = null, strict = false) {
    root = createRoot(container);
    const app = <IntakeApp root={ROOT} intakeId={intakeId} workflowId={workflowId} />;
    await act(async () => {
      root?.render(strict ? <StrictMode>{app}</StrictMode> : app);
    });
  }

  it("shows the start form for a new intake", async () => {
    await mount(null, "wf1");
    expect(api.attach).toHaveBeenCalledWith(ROOT);
    expect(container.querySelector(".intake-start")).not.toBeNull();
    expect(container.querySelector<HTMLSelectElement>("select[name='workflow']")!.value).toBe("wf1");
  });

  it("shows the session of an existing intake", async () => {
    api.intakeGet.mockResolvedValue(SESSION);
    await mount("i1");
    expect(api.intakeGet).toHaveBeenCalledWith(ROOT, "i1");
    expect(container.querySelector(".intake-start")).toBeNull();
    expect(container.querySelector(".intake-app__session")).not.toBeNull();
    expect(container.textContent).toContain(t("intake.kind.bug"));
    expect(container.querySelector(".intake-conversation")).not.toBeNull();
    expect(container.querySelector(".intake-message--user")?.textContent).toContain("It crashes");
  });

  it("shows the proposal, document updates and finalize next to the conversation", async () => {
    api.intakeGet.mockResolvedValue(SESSION);
    await mount("i1");
    expect(container.querySelector(".intake-app__review")).toBeNull();
    expect(container.querySelector(".intake-abandon")?.textContent).toBe(t("intake.conversation.abandon"));

    await act(async () =>
      useIntakeStore.setState({
        session: { ...SESSION, proposal: { title: "Fix crash", body: "Details" }, appliedDocPaths: ["docs/a.md"] },
      }),
    );
    const review = container.querySelector(".intake-app__review")!;
    expect(review.querySelector(".intake-proposal__title")?.textContent).toBe("Fix crash");
    expect(review.querySelector(".intake-docs__applied")).not.toBeNull();
    expect(review.querySelector(".intake-finalize__submit")).not.toBeNull();
  });

  it("shows a load failure", async () => {
    api.intakeGet.mockRejectedValue({ code: "INTAKE_NOT_FOUND", message: "i1" });
    await mount("i1");
    expect(container.textContent).toContain(t("intake.loadFailed"));
  });

  it("listens to change events while mounted", async () => {
    await mount(null);
    expect(unlistenIntake).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    root = undefined;
    expect(unlistenIntake).toHaveBeenCalledTimes(1);
    expect(unlistenWorkflows).toHaveBeenCalledTimes(1);
  });

  it("initializes once and keeps listeners balanced under StrictMode", async () => {
    await mount(null, null, true);
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(subscribe.intake).toHaveBeenCalledTimes(2);
    // The discarded first mount removed its listeners; the live one keeps them.
    expect(unlistenIntake).toHaveBeenCalledTimes(1);
    expect(unlistenWorkflows).toHaveBeenCalledTimes(1);
    await act(async () => root?.unmount());
    root = undefined;
    expect(unlistenIntake).toHaveBeenCalledTimes(2);
    expect(unlistenWorkflows).toHaveBeenCalledTimes(2);
  });

  it("keeps loading while a racing reload has not applied the session yet", async () => {
    let resolveInit!: (v: IntakeSessionView) => void;
    api.intakeGet
      .mockReturnValueOnce(new Promise((r) => (resolveInit = r)))
      .mockReturnValueOnce(new Promise(() => undefined));
    await mount("i1");
    const handler = subscribe.intake.mock.calls[0][0] as (e: IntakeChangedEvent) => void;
    await act(async () => handler({ projectRoot: ROOT, intakeId: "i1", status: "active", busy: true }));
    // init's own load finishes after the reload started, so it is outdated.
    await act(async () => resolveInit(SESSION));
    expect(useIntakeStore.getState().loading).toBe(false);
    expect(container.querySelector("[role='status']")?.textContent).toBe(t("intake.loading"));
    expect(container.textContent).not.toContain(t("intake.loadFailed"));
  });
});

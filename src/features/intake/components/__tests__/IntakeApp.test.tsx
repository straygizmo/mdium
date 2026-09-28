// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntakeSessionView, Workflow } from "@/shared/types/workflow";

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
vi.mock("@/features/workflow/lib/workflow-api", () => ({
  workflowApi: api,
  subscribeIntakeChanged: vi.fn(async () => unlistenIntake),
  subscribeWorkflowsChanged: vi.fn(async () => unlistenWorkflows),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn() }) }));
vi.mock("@/stores/dialog-store", () => ({ showMessage: vi.fn() }));

import i18n from "@/shared/i18n";
import { useIntakeStore } from "../../intake-store";
import { IntakeApp } from "../IntakeApp";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: "workflow", ...opts });
const ROOT = "C:\\proj";
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

  async function mount(intakeId: string | null, workflowId: string | null = null) {
    root = createRoot(container);
    await act(async () => {
      root?.render(<IntakeApp root={ROOT} intakeId={intakeId} workflowId={workflowId} />);
    });
  }

  it("shows the start form for a new intake", async () => {
    await mount(null, "wf1");
    expect(api.attach).toHaveBeenCalledWith(ROOT);
    expect(container.querySelector(".intake-start")).not.toBeNull();
    expect(container.querySelector<HTMLSelectElement>("select[name='workflow']")!.value).toBe("wf1");
  });

  it("shows the session of an existing intake", async () => {
    api.intakeGet.mockResolvedValue({ id: "i1", status: "active", kind: "bug", busy: false } as IntakeSessionView);
    await mount("i1");
    expect(api.intakeGet).toHaveBeenCalledWith(ROOT, "i1");
    expect(container.querySelector(".intake-start")).toBeNull();
    expect(container.querySelector(".intake-app__session")).not.toBeNull();
    expect(container.textContent).toContain(t("intake.kind.bug"));
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
});

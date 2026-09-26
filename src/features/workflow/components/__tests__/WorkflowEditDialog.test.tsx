// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Stage, Workflow } from "@/shared/types/workflow";

const api = vi.hoisted(() => ({
  listWorkflows: vi.fn(),
  listTasks: vi.fn(),
  listRuns: vi.fn(),
  saveWorkflows: vi.fn(),
  probeProviders: vi.fn(),
}));
const dialogs = vi.hoisted(() => ({
  showMessage: vi.fn(),
  showConfirm: vi.fn(),
  showPrompt: vi.fn(),
}));
vi.mock("../../lib/workflow-api", () => ({ workflowApi: api, subscribeWorkflowEvents: vi.fn() }));
vi.mock("@/stores/dialog-store", () => dialogs);

import i18n from "@/shared/i18n";
import { useWorkflowStore } from "../../workflow-store";
import { DEFAULT_DESIGN_DOC_PATH, parseValidationErrors, WorkflowEditDialog } from "../WorkflowEditDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "C:\\proj";

function stage(role: Stage["role"], patch: Partial<Stage> = {}): Stage {
  return {
    id: `${role}-id`,
    role,
    name: `${role} stage`,
    prompt: `${role} prompt`,
    completionCriteria: `${role} criteria`,
    provider: "codex",
    model: null,
    requiresApproval: false,
    timeoutMinutes: 30,
    ...patch,
  };
}

function workflow(id: string, patch: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: `Flow ${id}`,
    enabled: false,
    archived: false,
    stages: [
      stage("design"),
      stage("implement", { provider: "claude", model: "opus", requiresApproval: true }),
      stage("review", { provider: "opencode" }),
    ],
    reviewReturnTo: "implement",
    maxReentryCount: 4,
    maxConcurrentRuns: 2,
    designDocPath: null,
    issueTracking: "off",
    ...patch,
  };
}

const initialStore = useWorkflowStore.getState();

/** Sets a form control's value the way a user edit does, so React sees it. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("parseValidationErrors", () => {
  it("extracts each validation code and its detail from a STORE_INVALID message", () => {
    expect(
      parseValidationErrors(
        "STORE_INVALID: [WORKFLOW_NAME_EMPTY, WORKFLOW_INVALID_TIMEOUT: design, WORKFLOW_INVALID_DESIGN_DOC_PATH: a, b.md, WORKFLOW_INVALID_MAX_REENTRY]",
      ),
    ).toEqual([
      { code: "WORKFLOW_NAME_EMPTY", detail: null },
      { code: "WORKFLOW_INVALID_TIMEOUT", detail: "design" },
      { code: "WORKFLOW_INVALID_DESIGN_DOC_PATH", detail: "a, b.md" },
      { code: "WORKFLOW_INVALID_MAX_REENTRY", detail: null },
    ]);
  });

  it("returns nothing for a message without a code list", () => {
    expect(parseValidationErrors("STORE_INVALID")).toEqual([]);
    expect(parseValidationErrors("something else")).toEqual([]);
  });
});

describe("WorkflowEditDialog", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let workflows: Workflow[];
  let onClose: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    useWorkflowStore.setState(initialStore, true);
    workflows = [workflow("wf1"), workflow("wf2", { enabled: true })];
    useWorkflowStore.setState({
      activeRoot: ROOT,
      projects: {
        [ROOT]: {
          root: ROOT,
          workflows,
          workflowWarnings: [],
          tasks: [],
          taskWarnings: [],
          runs: [],
          progress: {},
          loading: false,
          refreshing: false,
          loaded: true,
          error: null,
        },
      },
    });
    api.listWorkflows.mockImplementation(async () => ({ workflows, warnings: [] }));
    api.listTasks.mockResolvedValue({ tasks: [], warnings: [] });
    api.listRuns.mockResolvedValue({ runs: [], warnings: [] });
    api.saveWorkflows.mockResolvedValue(undefined);
    api.probeProviders.mockResolvedValue([
      { provider: "codex", result: { kind: "available", version: "1.0" } },
      { provider: "copilot", result: { kind: "missing", detail: "copilot" } },
      { provider: "opencode", result: { kind: "error", detail: "RUNNER_TIMEOUT" } },
      { provider: "claude", result: { kind: "available", version: "2.0" } },
    ]);
    onClose = vi.fn<() => void>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(target: Workflow, confirmEnable = vi.fn(async () => true)) {
    await act(async () =>
      root.render(<WorkflowEditDialog workflow={target} confirmEnable={confirmEnable} onClose={onClose} />),
    );
    return confirmEnable;
  }

  function field<T extends HTMLElement = HTMLInputElement>(name: string) {
    return container.querySelector<T>(`[name="${name}"]`);
  }

  function button(label: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  }

  async function save() {
    await act(async () => button(i18n.t("workflow:edit.save"))!.click());
  }

  it("renders every field of the workflow", async () => {
    await render(workflows[0]);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(field("name")!.value).toBe("Flow wf1");
    expect(field("enabled")!.checked).toBe(false);
    expect(field("enabled")!.hasAttribute("data-switch")).toBe(true);
    const roles = [...container.querySelectorAll("[data-stage-role]")].map((el) => el.getAttribute("data-stage-role"));
    expect(roles).toEqual(["design", "implement", "review"]);
    expect(container.textContent).toContain(i18n.t("workflow:role.implement"));
    expect(field("design.name")!.value).toBe("design stage");
    expect(field<HTMLSelectElement>("implement.provider")!.value).toBe("claude");
    expect(field("implement.model")!.value).toBe("opus");
    expect(field("design.model")!.value).toBe("");
    expect(field<HTMLTextAreaElement>("review.prompt")!.value).toBe("review prompt");
    expect(field<HTMLTextAreaElement>("review.completionCriteria")!.value).toBe("review criteria");
    expect(field("design.timeoutMinutes")!.value).toBe("30");
    expect(field<HTMLSelectElement>("reviewReturnTo")!.value).toBe("implement");
    expect(field("maxReentryCount")!.value).toBe("4");
    expect(field("maxConcurrentRuns")!.value).toBe("2");
    expect(field("saveDesignDoc")!.checked).toBe(false);
    expect(field("designDocPath")).toBeNull();
    expect(field<HTMLSelectElement>("issueTracking")!.value).toBe("off");
  });

  it("shows the approval switch only on the implement stage", async () => {
    await render(workflows[0]);
    expect(field("implement.requiresApproval")!.checked).toBe(true);
    expect(field("implement.requiresApproval")!.hasAttribute("data-switch")).toBe(true);
    expect(field("design.requiresApproval")).toBeNull();
    expect(field("review.requiresApproval")).toBeNull();
  });

  it("fills the default design doc path when saving the design doc is enabled", async () => {
    await render(workflows[0]);
    await act(async () => field("saveDesignDoc")!.click());
    expect(field("designDocPath")!.value).toBe(DEFAULT_DESIGN_DOC_PATH);
    expect(DEFAULT_DESIGN_DOC_PATH).toBe("docs/designs/{date}-{slug}-design.md");
    await act(async () => field("saveDesignDoc")!.click());
    expect(field("designDocPath")).toBeNull();
  });

  it("saves the modified workflow in place of the original", async () => {
    await render(workflows[0]);
    await act(async () => setValue(field("name")!, "Renamed"));
    await act(async () => setValue(field<HTMLSelectElement>("design.provider")!, "claude"));
    await act(async () => setValue(field("design.model")!, "sonnet"));
    await act(async () => setValue(field("implement.model")!, " "));
    await act(async () => setValue(field("review.timeoutMinutes")!, "90"));
    await act(async () => field("implement.requiresApproval")!.click());
    await act(async () => setValue(field<HTMLSelectElement>("reviewReturnTo")!, "design"));
    await act(async () => setValue(field("maxReentryCount")!, "7"));
    await act(async () => setValue(field("maxConcurrentRuns")!, "3"));
    await act(async () => field("saveDesignDoc")!.click());
    await act(async () => setValue(field<HTMLSelectElement>("issueTracking")!, "auto"));
    await save();

    expect(api.saveWorkflows).toHaveBeenCalledTimes(1);
    const [projectRoot, file] = api.saveWorkflows.mock.calls[0];
    expect(projectRoot).toBe(ROOT);
    expect(file.schemaVersion).toBe(1);
    expect(file.workflows.map((w: Workflow) => w.id)).toEqual(["wf1", "wf2"]);
    expect(file.workflows[1]).toEqual(workflows[1]);
    const saved: Workflow = file.workflows[0];
    expect(saved.name).toBe("Renamed");
    expect(saved.stages[0]).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(saved.stages[1]).toMatchObject({ model: null, requiresApproval: false });
    expect(saved.stages[2]).toMatchObject({ timeoutMinutes: 90 });
    expect(saved).toMatchObject({
      reviewReturnTo: "design",
      maxReentryCount: 7,
      maxConcurrentRuns: 3,
      designDocPath: DEFAULT_DESIGN_DOC_PATH,
      issueTracking: "auto",
      enabled: false,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows STORE_INVALID validation errors inside the dialog", async () => {
    api.saveWorkflows.mockRejectedValue({
      code: "STORE_INVALID",
      message: "STORE_INVALID: [WORKFLOW_NAME_EMPTY, WORKFLOW_INVALID_TIMEOUT: design]",
    });
    await render(workflows[0]);
    await save();
    const items = [...container.querySelectorAll(".workflow-edit__errors li")].map((li) => li.textContent);
    expect(items).toEqual([
      i18n.t("workflow:codes.WORKFLOW_NAME_EMPTY"),
      `${i18n.t("workflow:codes.WORKFLOW_INVALID_TIMEOUT")} (design)`,
    ]);
    expect(dialogs.showMessage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows other save failures in the error dialog and stays open", async () => {
    api.saveWorkflows.mockRejectedValue({ code: "STORE_IO_FAILED", message: "disk" });
    await render(workflows[0]);
    await save();
    expect(dialogs.showMessage).toHaveBeenCalledWith(
      expect.stringContaining(i18n.t("workflow:codes.STORE_IO_FAILED")),
      expect.objectContaining({ kind: "error" }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses to save a workflow that is no longer listed", async () => {
    await render(workflow("gone"));
    await save();
    expect(api.saveWorkflows).not.toHaveBeenCalled();
    expect(dialogs.showMessage).toHaveBeenCalledWith(
      expect.stringContaining(i18n.t("workflow:codes.WORKFLOW_NOT_FOUND")),
      expect.objectContaining({ kind: "error" }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("marks unavailable providers with the reason", async () => {
    await render(workflows[0]);
    const options = [...field<HTMLSelectElement>("design.provider")!.options];
    const text = (value: string) => options.find((o) => o.value === value)!.textContent!;
    expect(text("codex")).toBe(i18n.t("workflow:provider.codex"));
    expect(text("copilot")).toContain(i18n.t("workflow:provider.copilot"));
    expect(text("copilot")).toContain(i18n.t("workflow:edit.availability.missing"));
    expect(text("opencode")).toContain(i18n.t("workflow:codes.RUNNER_TIMEOUT"));
  });

  it("asks for the enable confirmation when a disabled workflow is enabled", async () => {
    const confirmEnable = await render(workflows[0], vi.fn(async () => false));
    await act(async () => field("enabled")!.click());
    expect(confirmEnable).toHaveBeenCalledWith(expect.objectContaining({ id: "wf1" }));
    expect(field("enabled")!.checked).toBe(false);

    confirmEnable.mockResolvedValue(true);
    await act(async () => field("enabled")!.click());
    expect(field("enabled")!.checked).toBe(true);
    await save();
    expect(api.saveWorkflows.mock.calls[0][1].workflows[0].enabled).toBe(true);
  });

  it("does not ask for confirmation when disabling an enabled workflow", async () => {
    const confirmEnable = await render(workflows[1]);
    await act(async () => field("enabled")!.click());
    expect(confirmEnable).not.toHaveBeenCalled();
    expect(field("enabled")!.checked).toBe(false);
  });

  it("closes on Escape and on cancel without saving", async () => {
    await render(workflows[0]);
    await act(async () =>
      container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => button(i18n.t("workflow:edit.cancel"))!.click());
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(api.saveWorkflows).not.toHaveBeenCalled();
  });
});

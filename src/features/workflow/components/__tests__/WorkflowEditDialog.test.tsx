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
import { DEFAULT_DESIGN_DOC_PATH, parseCount, parseValidationErrors, WorkflowEditDialog } from "../WorkflowEditDialog";

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

describe("parseCount", () => {
  it("accepts whole numbers from 1 to the u32 maximum", () => {
    expect(parseCount("1")).toBe(1);
    expect(parseCount(" 42 ")).toBe(42);
    expect(parseCount("4294967295")).toBe(4294967295);
    for (const raw of ["", "0", "-5", "2.5", "1e3", "abc", "4294967296", "99999999999999999999"]) {
      expect(parseCount(raw)).toBeNull();
    }
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

  function setStored(update: (list: Workflow[]) => Workflow[]) {
    workflows = update(workflows);
    useWorkflowStore.setState((st) => ({
      projects: { ...st.projects, [ROOT]: { ...st.projects[ROOT], workflows } },
    }));
  }

  function dialog() {
    return container.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  function overlay() {
    return container.querySelector<HTMLElement>(".workflow-edit-overlay")!;
  }

  function key(target: HTMLElement, init: KeyboardEventInit) {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
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
      message: "STORE_INVALID: [WORKFLOW_NAME_EMPTY, WORKFLOW_INVALID_TIMEOUT: design-id, WORKFLOW_STAGE_ID_DUPLICATE: x]",
    });
    await render(workflows[0]);
    await save();
    const items = [...container.querySelectorAll(".workflow-edit__errors li")].map((li) => li.textContent);
    expect(items).toEqual([
      i18n.t("workflow:codes.WORKFLOW_NAME_EMPTY"),
      `${i18n.t("workflow:codes.WORKFLOW_INVALID_TIMEOUT")} (${i18n.t("workflow:role.design")})`,
      `${i18n.t("workflow:codes.WORKFLOW_STAGE_ID_DUPLICATE")} (x)`,
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

  it.each([
    ["-5"],
    ["2.5"],
    [""],
    ["99999999999"],
  ])("rejects the number %j before saving", async (raw) => {
    await render(workflows[0]);
    await act(async () => setValue(field("review.timeoutMinutes")!, raw));
    await act(async () => setValue(field("maxReentryCount")!, raw));
    await act(async () => setValue(field("maxConcurrentRuns")!, raw));
    await save();
    expect(api.saveWorkflows).not.toHaveBeenCalled();
    const items = [...container.querySelectorAll(".workflow-edit__errors li")].map((li) => li.textContent);
    expect(items).toEqual([
      `${i18n.t("workflow:codes.WORKFLOW_INVALID_TIMEOUT")} (${i18n.t("workflow:role.review")})`,
      i18n.t("workflow:codes.WORKFLOW_INVALID_MAX_REENTRY"),
      i18n.t("workflow:codes.WORKFLOW_INVALID_MAX_CONCURRENT"),
    ]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the overlay only when the press starts and ends on it", async () => {
    await render(workflows[0]);
    // A drag that starts inside the dialog and ends on the overlay keeps it open.
    await act(async () => {
      dialog().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      overlay().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      overlay().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      overlay().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding changes", async () => {
    await render(workflows[0]);
    await act(async () => setValue(field("name")!, "Changed"));
    dialogs.showConfirm.mockResolvedValueOnce(false);
    await act(async () => key(dialog(), { key: "Escape" }));
    expect(dialogs.showConfirm).toHaveBeenCalledWith(
      i18n.t("workflow:edit.discardConfirm"),
      expect.objectContaining({ kind: "warning" }),
    );
    expect(onClose).not.toHaveBeenCalled();
    dialogs.showConfirm.mockResolvedValueOnce(true);
    await act(async () => button(i18n.t("workflow:edit.cancel"))!.click());
    expect(dialogs.showConfirm).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cannot be closed while saving", async () => {
    let finish!: () => void;
    api.saveWorkflows.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    await render(workflows[0]);
    await save();
    expect(button(i18n.t("workflow:edit.cancel"))!.disabled).toBe(true);
    await act(async () => key(dialog(), { key: "Escape" }));
    await act(async () => {
      overlay().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      overlay().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("follows the latest stored enabled flag unless it is changed here", async () => {
    const confirmEnable = await render(workflows[0]);
    // Enabled elsewhere (e.g. from the panel) while the dialog is open.
    await act(async () => setStored((list) => list.map((w) => (w.id === "wf1" ? { ...w, enabled: true } : w))));
    expect(field("enabled")!.checked).toBe(true);
    await save();
    expect(confirmEnable).not.toHaveBeenCalled();
    expect(api.saveWorkflows.mock.calls[0][1].workflows[0].enabled).toBe(true);
  });

  it("asks for the enable confirmation against the latest stored copy", async () => {
    const confirmEnable = await render(workflows[1], vi.fn(async () => true));
    // Disabled elsewhere after the dialog opened with an enabled copy.
    await act(async () => setStored((list) => list.map((w) => (w.id === "wf2" ? { ...w, enabled: false } : w))));
    expect(field("enabled")!.checked).toBe(false);
    await act(async () => field("enabled")!.click());
    expect(confirmEnable).toHaveBeenCalledTimes(1);
    await save();
    expect(confirmEnable).toHaveBeenCalledTimes(1);
    expect(api.saveWorkflows.mock.calls[0][1].workflows[1].enabled).toBe(true);
  });

  it("saves on top of the latest stored workflows", async () => {
    await render(workflows[0]);
    await act(async () => setValue(field("name")!, "Renamed"));
    await act(async () =>
      setStored((list) => [
        ...list.map((w) =>
          w.id === "wf1" ? { ...w, archived: true } : w.id === "wf2" ? { ...w, name: "Changed elsewhere" } : w,
        ),
        workflow("wf3"),
      ]),
    );
    await save();
    const saved: Workflow[] = api.saveWorkflows.mock.calls[0][1].workflows;
    expect(saved.map((w) => w.id)).toEqual(["wf1", "wf2", "wf3"]);
    expect(saved[0]).toMatchObject({ name: "Renamed", archived: true });
    expect(saved[1].name).toBe("Changed elsewhere");
  });

  it("keeps Tab focus inside the dialog", async () => {
    await render(workflows[0]);
    const save = button(i18n.t("workflow:edit.save"))!;
    const first = field("name")!;
    save.focus();
    await act(async () => key(dialog(), { key: "Tab" }));
    expect(document.activeElement).toBe(first);
    await act(async () => key(dialog(), { key: "Tab", shiftKey: true }));
    expect(document.activeElement).toBe(save);
  });
});

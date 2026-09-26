// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Stage, Workflow } from "@/shared/types/workflow";

const api = vi.hoisted(() => ({
  attach: vi.fn(),
  listWorkflows: vi.fn(),
  listTasks: vi.fn(),
  listRuns: vi.fn(),
  saveWorkflows: vi.fn(),
  addStandard: vi.fn(),
  activeRunCount: vi.fn(),
  probeProviders: vi.fn(),
  createTask: vi.fn(),
  gitignoreStatus: vi.fn(),
}));
const dialogs = vi.hoisted(() => ({
  showMessage: vi.fn(),
  showConfirm: vi.fn(),
  showPrompt: vi.fn(),
}));
vi.mock("../../lib/workflow-api", () => ({ workflowApi: api, subscribeWorkflowEvents: vi.fn() }));
vi.mock("@/stores/dialog-store", () => dialogs);

import i18n from "@/shared/i18n";
import { useTabStore } from "@/stores/tab-store";
import { useWorkflowStore } from "../../workflow-store";
import { WorkflowPanel } from "../WorkflowPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "C:\\proj";

function stage(role: Stage["role"], provider: Stage["provider"]): Stage {
  return {
    id: role,
    role,
    name: role,
    prompt: "",
    completionCriteria: "",
    provider,
    model: null,
    requiresApproval: false,
    timeoutMinutes: 60,
  };
}

function workflow(id: string, patch: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: `Flow ${id}`,
    enabled: false,
    archived: false,
    stages: [stage("design", "codex"), stage("implement", "codex"), stage("review", "claude")],
    reviewReturnTo: "design",
    maxReentryCount: 5,
    maxConcurrentRuns: 1,
    designDocPath: null,
    issueTracking: "off",
    ...patch,
  };
}

const initialStore = useWorkflowStore.getState();

describe("WorkflowPanel", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let workflows: Workflow[];

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    useWorkflowStore.setState(initialStore, true);
    workflows = [workflow("wf1"), workflow("wf2", { enabled: true }), workflow("wf3", { archived: true })];
    api.attach.mockImplementation(async () => ROOT);
    api.listWorkflows.mockImplementation(async () => ({ workflows, warnings: [] }));
    api.listTasks.mockResolvedValue({ tasks: [], warnings: [] });
    api.listRuns.mockResolvedValue({ runs: [], warnings: [] });
    api.saveWorkflows.mockResolvedValue(undefined);
    api.activeRunCount.mockResolvedValue(0);
    api.probeProviders.mockResolvedValue([]);
    api.gitignoreStatus.mockResolvedValue({ missing: [] });
    localStorage.clear();
    useTabStore.setState({ activeFolderPath: "C:/proj" });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useTabStore.setState({ activeFolderPath: null });
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function render(props: Parameters<typeof WorkflowPanel>[0] = {}) {
    await act(async () => root.render(<WorkflowPanel {...props} />));
  }

  function row(id: string) {
    return container.querySelector<HTMLElement>(`[data-workflow-id="${id}"]`);
  }

  function button(scope: ParentNode, label: string) {
    return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  }

  it("asks for a folder when none is open", async () => {
    useTabStore.setState({ activeFolderPath: null });
    await render();
    expect(container.textContent).toContain(i18n.t("workflow:noFolder"));
    expect(api.attach).not.toHaveBeenCalled();
  });

  it("activates the folder and lists the workflows with their stage providers", async () => {
    await render();
    expect(api.attach).toHaveBeenCalledWith("C:/proj");
    expect(row("wf1")?.textContent).toContain("Flow wf1");
    expect(row("wf1")?.textContent).toContain("Codex / Codex / Claude");
    expect(row("wf2")?.querySelector<HTMLInputElement>("input[data-switch]")?.checked).toBe(true);
    // Archived workflows are hidden unless the archived filter is on.
    expect(row("wf3")).toBeNull();
  });

  it("shows the attach error", async () => {
    api.attach.mockRejectedValue({ code: "WORKFLOW_PROJECT_INVALID", message: "" });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      i18n.t("workflow:codes.WORKFLOW_PROJECT_INVALID"),
    );
  });

  it("saves the flipped enabled flag after the enable confirmation", async () => {
    const confirmEnable = vi.fn(async () => true);
    await render({ confirmEnable });
    await act(async () => row("wf1")!.querySelector<HTMLInputElement>("input[data-switch]")!.click());
    expect(confirmEnable).toHaveBeenCalledWith(expect.objectContaining({ id: "wf1" }));
    expect(api.saveWorkflows).toHaveBeenCalledTimes(1);
    const [root, file] = api.saveWorkflows.mock.calls[0];
    expect(root).toBe(ROOT);
    expect(file.schemaVersion).toBe(1);
    expect(file.workflows.map((w: Workflow) => [w.id, w.enabled])).toEqual([
      ["wf1", true],
      ["wf2", true],
      ["wf3", false],
    ]);
    // Every other field is written back unchanged.
    expect(file.workflows).toEqual([{ ...workflows[0], enabled: true }, workflows[1], workflows[2]]);
    expect(file.workflows[0].stages).toEqual(workflows[0].stages);
    expect(file.workflows[0].maxConcurrentRuns).toBe(1);
  });

  it("runs one operation at a time", async () => {
    let resolveEnable!: (v: boolean) => void;
    const confirmEnable = vi.fn(() => new Promise<boolean>((r) => (resolveEnable = r)));
    await render({ confirmEnable });
    const input = row("wf1")!.querySelector<HTMLInputElement>("input[data-switch]")!;
    await act(async () => {
      input.click();
      input.click();
    });
    await act(async () => resolveEnable(true));
    expect(confirmEnable).toHaveBeenCalledTimes(1);
    expect(api.saveWorkflows).toHaveBeenCalledTimes(1);
  });

  it("does not save when the enable confirmation is declined", async () => {
    await render({ confirmEnable: async () => false });
    await act(async () => row("wf1")!.querySelector<HTMLInputElement>("input[data-switch]")!.click());
    expect(api.saveWorkflows).not.toHaveBeenCalled();
  });

  it("disables without the enable confirmation", async () => {
    const confirmEnable = vi.fn(async () => true);
    await render({ confirmEnable });
    await act(async () => row("wf2")!.querySelector<HTMLInputElement>("input[data-switch]")!.click());
    expect(confirmEnable).not.toHaveBeenCalled();
    expect(api.saveWorkflows.mock.calls[0][1].workflows[1].enabled).toBe(false);
  });

  it("confirms archiving with the number of runs in progress", async () => {
    api.activeRunCount.mockResolvedValue(2);
    dialogs.showConfirm.mockResolvedValue(true);
    await render();
    await act(async () => button(row("wf2")!, i18n.t("workflow:panel.archive"))!.click());
    expect(api.activeRunCount).toHaveBeenCalledWith(ROOT, "wf2");
    const text = dialogs.showConfirm.mock.calls[0][0] as string;
    expect(text).toContain(i18n.t("workflow:panel.archiveConfirm", { name: "Flow wf2" }));
    expect(text).toContain(i18n.t("workflow:panel.activeRuns", { count: 2 }));
    const saved = api.saveWorkflows.mock.calls[0][1].workflows as Workflow[];
    expect(saved.find((w) => w.id === "wf2")?.archived).toBe(true);
  });

  it("fetches the run count without reloading the lists", async () => {
    dialogs.showConfirm.mockResolvedValue(false);
    await render();
    const loads = api.listWorkflows.mock.calls.length;
    await act(async () => button(row("wf1")!, i18n.t("workflow:panel.archive"))!.click());
    expect(api.activeRunCount).toHaveBeenCalledTimes(1);
    expect(api.listWorkflows.mock.calls.length).toBe(loads);
  });

  it("shows a run count failure and does not ask for confirmation", async () => {
    api.activeRunCount.mockRejectedValue({ code: "STORE_IO_FAILED", message: "" });
    await render();
    await act(async () => button(row("wf1")!, i18n.t("workflow:panel.archive"))!.click());
    expect(dialogs.showConfirm).not.toHaveBeenCalled();
    expect(dialogs.showMessage).toHaveBeenCalledWith(i18n.t("workflow:codes.STORE_IO_FAILED"), {
      title: i18n.t("workflow:panel.runCountFailed"),
      kind: "error",
    });
    expect(api.saveWorkflows).not.toHaveBeenCalled();
  });

  it("omits the run count note when no run is in progress and keeps the file on cancel", async () => {
    dialogs.showConfirm.mockResolvedValue(false);
    await render();
    await act(async () => button(row("wf1")!, i18n.t("workflow:panel.archive"))!.click());
    const text = dialogs.showConfirm.mock.calls[0][0] as string;
    expect(text).not.toContain(i18n.t("workflow:panel.activeRuns", { count: 0 }));
    expect(api.saveWorkflows).not.toHaveBeenCalled();
  });

  it("deletes an archived workflow after confirmation", async () => {
    dialogs.showConfirm.mockResolvedValue(true);
    useWorkflowStore.getState().setFilters({ showArchived: true });
    await render();
    await act(async () => button(row("wf3")!, i18n.t("workflow:panel.delete"))!.click());
    expect(dialogs.showConfirm.mock.calls[0][0]).toContain(
      i18n.t("workflow:panel.deleteConfirm", { name: "Flow wf3" }),
    );
    const saved = api.saveWorkflows.mock.calls[0][1].workflows as Workflow[];
    expect(saved.map((w) => w.id)).toEqual(["wf1", "wf2"]);
  });

  it("adds the standard workflow with the prompted name and the chosen provider", async () => {
    dialogs.showPrompt.mockResolvedValue("My flow");
    api.addStandard.mockResolvedValue(workflow("wf4"));
    await render();
    const select = container.querySelector<HTMLSelectElement>(".workflow-panel__provider-select")!;
    expect(select.value).toBe("codex");
    await act(async () => {
      select.value = "copilot";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button(container, i18n.t("workflow:panel.addStandard"))!.click());
    expect(dialogs.showPrompt.mock.calls[0][1]).toEqual(
      expect.objectContaining({ defaultValue: i18n.t("workflow:template.standardName") }),
    );
    expect(api.addStandard).toHaveBeenCalledWith(ROOT, "My flow", "copilot");
  });

  it("renders load warnings with the file and the localized message", async () => {
    api.listWorkflows.mockImplementation(async () => ({
      workflows,
      warnings: [{ file: "workflows.json", message: "STORE_CORRUPT: bad" }],
    }));
    api.listTasks.mockResolvedValue({
      tasks: [],
      warnings: [{ file: "tasks/x.md", message: "BRAND_NEW_CODE" }],
    });
    await render();
    const warnings = container.querySelector(".workflow-panel__warnings")!;
    expect(warnings.textContent).toContain("workflows.json");
    expect(warnings.textContent).toContain(i18n.t("workflow:codes.STORE_CORRUPT"));
    expect(warnings.textContent).toContain("bad");
    expect(warnings.textContent).toContain("tasks/x.md");
    expect(warnings.textContent).toContain("BRAND_NEW_CODE");
  });

  it("updates the store filters", async () => {
    await render();
    const workflowSelect = container.querySelector<HTMLSelectElement>(".workflow-panel__workflow-filter")!;
    await act(async () => {
      workflowSelect.value = "wf2";
      workflowSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(useWorkflowStore.getState().filters.workflowId).toBe("wf2");
    await act(async () => {
      workflowSelect.value = "";
      workflowSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(useWorkflowStore.getState().filters.workflowId).toBeNull();

    const archived = container.querySelector<HTMLInputElement>('input[name="showArchived"]')!;
    await act(async () => archived.click());
    expect(useWorkflowStore.getState().filters.showArchived).toBe(true);
    expect(row("wf3")).not.toBeNull();

    const cancelled = container.querySelector<HTMLInputElement>('input[name="showCancelled"]')!;
    await act(async () => cancelled.click());
    expect(useWorkflowStore.getState().filters.showCancelled).toBe(true);

    await act(async () => button(container, i18n.t("workflow:panel.viewMatrix"))!.click());
    expect(useWorkflowStore.getState().filters.view).toBe("matrix");
  });

  it("lists archived workflows in the filter only when they are shown and resets a hidden selection", async () => {
    useWorkflowStore.getState().setFilters({ showArchived: true, workflowId: "wf3" });
    await render();
    const workflowSelect = container.querySelector<HTMLSelectElement>(".workflow-panel__workflow-filter")!;
    const options = () => [...workflowSelect.options].map((o) => o.value);
    expect(options()).toEqual(["", "wf1", "wf2", "wf3"]);
    expect(useWorkflowStore.getState().filters.workflowId).toBe("wf3");

    const archived = container.querySelector<HTMLInputElement>('input[name="showArchived"]')!;
    await act(async () => archived.click());
    expect(options()).toEqual(["", "wf1", "wf2"]);
    expect(useWorkflowStore.getState().filters.workflowId).toBeNull();
  });

  it("opens the built-in edit and task creation dialogs", async () => {
    await render();
    await act(async () => button(row("wf1")!, i18n.t("workflow:panel.edit"))!.click());
    const edit = container.querySelector('[role="dialog"]')!;
    expect(edit.textContent).toContain(i18n.t("workflow:edit.title"));
    expect(edit.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe("Flow wf1");
    await act(async () => button(edit, i18n.t("workflow:edit.cancel"))!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => button(container, i18n.t("workflow:panel.newTask"))!.click());
    const create = container.querySelector('[role="dialog"]')!;
    expect(create.textContent).toContain(i18n.t("workflow:create.title"));
    const options = [...create.querySelectorAll<HTMLOptionElement>('[name="workflow"] option')].map((o) => o.value);
    expect(options).toEqual(["wf2"]);
  });

  it("passes the enable confirmation to the edit dialog", async () => {
    const confirmEnable = vi.fn(async () => false);
    await render({ confirmEnable });
    await act(async () => button(row("wf1")!, i18n.t("workflow:panel.edit"))!.click());
    const enabled = container.querySelector<HTMLInputElement>('[role="dialog"] [name="enabled"]')!;
    await act(async () => enabled.click());
    expect(confirmEnable).toHaveBeenCalledWith(expect.objectContaining({ id: "wf1" }));
    expect(enabled.checked).toBe(false);
  });

  it("closes the create dialog and adds the standard workflow from it", async () => {
    workflows = [workflow("wf1")];
    dialogs.showPrompt.mockResolvedValue(null);
    await render();
    await act(async () => button(container, i18n.t("workflow:panel.newTask"))!.click());
    await act(async () => button(container.querySelector('[role="dialog"]')!, i18n.t("workflow:panel.addStandard"))!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(dialogs.showPrompt).toHaveBeenCalled();
  });

  it("uses the given handlers instead of the built-in dialogs", async () => {
    const onCreateTask = vi.fn();
    const onEditWorkflow = vi.fn();
    await render({ onCreateTask, onEditWorkflow });
    await act(async () => button(container, i18n.t("workflow:panel.newTask"))!.click());
    expect(onCreateTask).toHaveBeenCalled();
    await act(async () => button(row("wf1")!, i18n.t("workflow:panel.edit"))!.click());
    expect(onEditWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: "wf1" }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  function safetyDialog() {
    return container.querySelector<HTMLElement>(".workflow-safety");
  }

  function toggle(id: string) {
    return row(id)!.querySelector<HTMLInputElement>("input[data-switch]")!;
  }

  it("shows the safety notice on the first enable and enables after acceptance", async () => {
    await render();
    await act(async () => toggle("wf1").click());
    expect(safetyDialog()?.textContent).toContain(i18n.t("workflow:safety.limits"));
    expect(api.saveWorkflows).not.toHaveBeenCalled();
    await act(async () => button(safetyDialog()!, i18n.t("workflow:safety.accept"))!.click());
    expect(safetyDialog()).toBeNull();
    expect(localStorage.getItem("mdium-workflow-safety-ack")).toBe("1");
    expect(api.saveWorkflows.mock.calls[0][1].workflows[0].enabled).toBe(true);
  });

  it("enables without the safety notice once it was accepted", async () => {
    localStorage.setItem("mdium-workflow-safety-ack", "1");
    await render();
    await act(async () => toggle("wf1").click());
    expect(safetyDialog()).toBeNull();
    expect(api.saveWorkflows.mock.calls[0][1].workflows[0].enabled).toBe(true);
  });

  it("keeps the workflow disabled when the safety notice is cancelled", async () => {
    await render();
    await act(async () => toggle("wf1").click());
    await act(async () => button(safetyDialog()!, i18n.t("workflow:safety.cancel"))!.click());
    expect(safetyDialog()).toBeNull();
    expect(api.saveWorkflows).not.toHaveBeenCalled();
    expect(toggle("wf1").checked).toBe(false);
    expect(localStorage.getItem("mdium-workflow-safety-ack")).toBeNull();
  });

  it("shows the safety notice and still enables when storage is unavailable", async () => {
    await render();
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("denied");
    });
    await act(async () => toggle("wf1").click());
    expect(safetyDialog()).not.toBeNull();
    await act(async () => button(safetyDialog()!, i18n.t("workflow:safety.accept"))!.click());
    expect(api.saveWorkflows.mock.calls[0][1].workflows[0].enabled).toBe(true);
  });

  it("cancels a pending safety notice when the folder changes", async () => {
    await render();
    await act(async () => toggle("wf1").click());
    expect(safetyDialog()).not.toBeNull();
    api.attach.mockImplementation(async () => "C:\\other");
    await act(async () => useTabStore.setState({ activeFolderPath: "C:/other" }));
    expect(safetyDialog()).toBeNull();
    expect(api.saveWorkflows).not.toHaveBeenCalled();
  });

  it("asks for the safety notice when enabling from the edit dialog", async () => {
    await render();
    await act(async () => button(row("wf1")!, i18n.t("workflow:panel.edit"))!.click());
    const enabled = container.querySelector<HTMLInputElement>('.workflow-edit [name="enabled"]')!;
    await act(async () => enabled.click());
    expect(safetyDialog()).not.toBeNull();
    expect(enabled.checked).toBe(false);
    await act(async () => button(safetyDialog()!, i18n.t("workflow:safety.accept"))!.click());
    expect(enabled.checked).toBe(true);
  });

  it("does not check the ignore rules while no workflow is enabled", async () => {
    workflows = [workflow("wf1")];
    await render();
    expect(api.gitignoreStatus).not.toHaveBeenCalled();
  });

  it("lists the missing ignore rules and copies them", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
    api.gitignoreStatus.mockResolvedValue({ missing: [".mdium/tasks/", ".mdium/runs/"] });
    await render();
    expect(api.gitignoreStatus).toHaveBeenCalledWith(ROOT);
    const notice = container.querySelector<HTMLElement>(".workflow-panel__gitignore")!;
    expect(notice.textContent).toContain(i18n.t("workflow:gitignore.description"));
    expect(notice.querySelector("pre")?.textContent).toBe(".mdium/tasks/\n.mdium/runs/");
    await act(async () => button(notice, i18n.t("workflow:gitignore.copy"))!.click());
    expect(writeText).toHaveBeenCalledWith(".mdium/tasks/\n.mdium/runs/\n");
    expect(button(notice, i18n.t("workflow:gitignore.copied"))).toBeDefined();
    await act(async () => button(notice, i18n.t("workflow:gitignore.dismiss"))!.click());
    expect(container.querySelector(".workflow-panel__gitignore")).toBeNull();
  });

  it("reports a failed copy", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
    api.gitignoreStatus.mockResolvedValue({ missing: [".mdium/intakes/"] });
    await render();
    const notice = container.querySelector<HTMLElement>(".workflow-panel__gitignore")!;
    await act(async () => button(notice, i18n.t("workflow:gitignore.copy"))!.click());
    expect(dialogs.showMessage).toHaveBeenCalledWith(i18n.t("workflow:gitignore.copyFailed"), { kind: "error" });
  });

  it("checks the ignore rules after a workflow is enabled", async () => {
    workflows = [workflow("wf1")];
    localStorage.setItem("mdium-workflow-safety-ack", "1");
    api.gitignoreStatus.mockResolvedValue({ missing: [".mdium/runs/"] });
    api.saveWorkflows.mockImplementation(async (_root: string, file: { workflows: Workflow[] }) => {
      workflows = file.workflows;
    });
    await render();
    expect(api.gitignoreStatus).not.toHaveBeenCalled();
    await act(async () => toggle("wf1").click());
    expect(api.gitignoreStatus).toHaveBeenCalledWith(ROOT);
    expect(container.querySelector(".workflow-panel__gitignore pre")?.textContent).toBe(".mdium/runs/");
  });
});

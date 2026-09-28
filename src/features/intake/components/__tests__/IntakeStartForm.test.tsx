// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeProbe, Stage, Workflow } from "@/shared/types/workflow";

vi.mock("@/features/workflow/lib/workflow-api", () => ({
  workflowApi: {},
  subscribeIntakeChanged: vi.fn(),
  subscribeWorkflowsChanged: vi.fn(),
}));
const closeWindow = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: closeWindow }) }));
vi.mock("@/stores/dialog-store", () => ({ showMessage: vi.fn() }));

import i18n from "@/shared/i18n";
import { useIntakeStore } from "../../intake-store";
import { IntakeStartForm } from "../IntakeStartForm";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: "workflow", ...opts });

function stage(role: Stage["role"], patch: Partial<Stage> = {}): Stage {
  return {
    id: `${role}-id`,
    role,
    name: role,
    prompt: "",
    completionCriteria: "",
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
    enabled: true,
    archived: false,
    stages: [stage("implement", { provider: "claude" }), stage("design"), stage("review")],
    reviewReturnTo: "design",
    maxReentryCount: 5,
    maxConcurrentRuns: 1,
    designDocPath: null,
    issueTracking: "off",
    ...patch,
  };
}

const WORKFLOWS = [
  workflow("a", { stages: [stage("design", { provider: "codex", model: "gpt-x" })] }),
  workflow("b", { stages: [stage("design", { provider: "opencode", model: null })], issueTracking: "auto" }),
  workflow("off", { enabled: false }),
  workflow("old", { archived: true }),
];

/** Sets a form control's value the way a user edit does, so React sees it. */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("IntakeStartForm", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;
  const create = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    create.mockClear();
    closeWindow.mockClear();
    useIntakeStore.setState({
      ...useIntakeStore.getInitialState(),
      root: "C:\\proj",
      workflows: WORKFLOWS,
      providers: [{ provider: "claude", result: { kind: "missing" } }],
      forge: null,
      create,
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
  });

  async function mount(initialWorkflowId: string | null = null) {
    root = createRoot(container);
    await act(async () => {
      root?.render(<IntakeStartForm initialWorkflowId={initialWorkflowId} />);
    });
  }

  const workflowSelect = () => container.querySelector<HTMLSelectElement>("select[name='workflow']")!;
  const providerSelect = () => container.querySelector<HTMLSelectElement>("select[name='provider']")!;
  const modelInput = () => container.querySelector<HTMLInputElement>("input[name='model']")!;
  const startButton = () => container.querySelector<HTMLButtonElement>(".intake-start__submit")!;
  const issueLine = () => container.querySelector(".intake-start__issue")?.textContent ?? null;

  it("lists only enabled, unarchived workflows", async () => {
    await mount();
    expect([...workflowSelect().options].map((o) => o.value)).toEqual(["a", "b"]);
  });

  it("preselects the workflow passed by the main window", async () => {
    await mount("b");
    expect(workflowSelect().value).toBe("b");
  });

  it("falls back to the first usable workflow for an unusable preselection", async () => {
    await mount("off");
    expect(workflowSelect().value).toBe("a");
  });

  it("defaults provider and model from the design stage and follows the workflow", async () => {
    await mount();
    expect(providerSelect().value).toBe("codex");
    expect(modelInput().value).toBe("gpt-x");
    await act(async () => setValue(workflowSelect(), "b"));
    expect(providerSelect().value).toBe("opencode");
    expect(modelInput().value).toBe("");
  });

  it("labels unavailable providers with the reason", async () => {
    await mount();
    const claude = [...providerSelect().options].find((o) => o.value === "claude")!;
    expect(claude.textContent).toBe(
      t("edit.unavailable", { provider: t("provider.claude"), reason: t("edit.availability.missing") }),
    );
  });

  it("shows no Issue line when the workflow does not track Issues", async () => {
    await mount("a");
    expect(issueLine()).toBeNull();
  });

  it("announces the Issue when tracking is available", async () => {
    const forge: ForgeProbe = {
      repo: { kind: "github", host: "github.com", path: "o/r" },
      cliAvailable: true,
      authenticated: true,
    };
    useIntakeStore.setState({ forge });
    await mount("b");
    expect(issueLine()).toBe(t("intake.start.issueWillCreate", { host: "github.com", path: "o/r" }));
  });

  it.each([
    ["noRepo", { repo: null, cliAvailable: true, authenticated: true }],
    ["cliMissing", { repo: { kind: "gitlab", host: "gl", path: "p" }, cliAvailable: false, authenticated: false }],
    ["unauthenticated", { repo: { kind: "gitlab", host: "gl", path: "p" }, cliAvailable: true, authenticated: false }],
    ["checkFailed", null],
  ] as const)("explains why Issue tracking is unavailable (%s)", async (reason, forge) => {
    useIntakeStore.setState({ forge: forge as ForgeProbe | null });
    await mount("b");
    expect(issueLine()).toBe(
      t("intake.start.issueUnavailable", { reason: t(`intake.start.forgeReason.${reason}`) }),
    );
  });

  it("starts the intake with the chosen values", async () => {
    await mount();
    const bug = container.querySelector<HTMLInputElement>("input[name='kind'][value='bug']")!;
    await act(async () => {
      bug.click();
      setValue(providerSelect(), "claude");
    });
    await act(async () => setValue(modelInput(), "  opus  "));
    await act(async () => startButton().click());
    expect(create).toHaveBeenCalledWith({ workflowId: "a", kind: "bug", provider: "claude", model: "opus" });
  });

  it("sends a blank model as null", async () => {
    await mount("b");
    await act(async () => startButton().click());
    expect(create).toHaveBeenCalledWith({ workflowId: "b", kind: "feature", provider: "opencode", model: null });
  });

  it("disables Start while creating", async () => {
    useIntakeStore.setState({ creating: true });
    await mount();
    expect(startButton().disabled).toBe(true);
    expect(startButton().textContent).toBe(t("intake.start.starting"));
  });

  it("keeps the provider and model choice when the workflow list reloads", async () => {
    await mount("a");
    await act(async () => setValue(providerSelect(), "claude"));
    await act(async () => setValue(modelInput(), "opus"));
    await act(async () => {
      useIntakeStore.setState({ workflows: WORKFLOWS.map((w) => ({ ...w, name: `${w.name} renamed` })) });
    });
    expect(workflowSelect().value).toBe("a");
    expect(providerSelect().value).toBe("claude");
    expect(modelInput().value).toBe("opus");
  });

  it("disables the form while creating", async () => {
    useIntakeStore.setState({ creating: true });
    await mount();
    expect(container.querySelector<HTMLFieldSetElement>(".intake-start__fields")!.disabled).toBe(true);
  });

  it("links the provider warning and the kind help to their controls", async () => {
    await mount();
    await act(async () => setValue(providerSelect(), "claude"));
    const warning = container.querySelector(".intake-start__warning")!;
    expect(providerSelect().getAttribute("aria-describedby")).toBe(warning.id);
    const bug = container.querySelector<HTMLInputElement>("input[name='kind'][value='bug']")!;
    const help = document.getElementById(bug.getAttribute("aria-describedby")!);
    expect(help?.textContent).toBe(t("intake.start.bugHelp"));
  });

  it("offers a retry and close when the created session's window could not be opened", async () => {
    const retryHandOff = vi.fn(() => Promise.resolve());
    useIntakeStore.setState({ handOff: { intakeId: "new1", windowOpened: false, error: "boom" }, retryHandOff });
    await mount();
    expect(container.querySelector<HTMLFieldSetElement>(".intake-start__fields")!.disabled).toBe(true);
    expect(container.textContent).toContain(t("intake.start.handOffFailed"));
    expect(container.textContent).toContain("boom");
    await act(async () => container.querySelector<HTMLButtonElement>(".intake-start__retry")!.click());
    expect(retryHandOff).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector<HTMLButtonElement>(".intake-start__close")!.click());
    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  it("stays disabled with a short notice when only closing this window failed", async () => {
    useIntakeStore.setState({ handOff: { intakeId: "new1", windowOpened: true, error: null } });
    await mount();
    expect(startButton().disabled).toBe(true);
    expect(container.textContent).toContain(t("intake.start.handedOff"));
    expect(container.querySelector(".intake-start__retry")).toBeNull();
    expect(container.querySelector(".intake-start__close")).not.toBeNull();
  });

  it("explains when no workflow is usable", async () => {
    useIntakeStore.setState({ workflows: [WORKFLOWS[2], WORKFLOWS[3]] });
    await mount();
    expect(container.textContent).toContain(t("intake.start.noWorkflows"));
    expect(startButton().disabled).toBe(true);
  });
});

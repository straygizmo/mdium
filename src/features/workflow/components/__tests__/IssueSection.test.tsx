// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueRef, RunStatus, WorkflowRun } from "@/shared/types/workflow";

vi.mock("../../lib/workflow-api", () => ({
  workflowApi: {
    listWorkflows: vi.fn(),
    listTasks: vi.fn(),
    listRuns: vi.fn(),
    retryIssueClose: vi.fn(),
  },
  subscribeWorkflowEvents: vi.fn(),
}));
const dialogs = vi.hoisted(() => ({ showMessage: vi.fn(), showConfirm: vi.fn() }));
vi.mock("@/stores/dialog-store", () => dialogs);
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import i18n from "@/shared/i18n";
import { formatCode } from "../../lib/format";
import { workflowApi } from "../../lib/workflow-api";
import { useWorkflowStore } from "../../workflow-store";
import { IssueSection } from "../IssueSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "C:\\work\\app";
const api = vi.mocked(workflowApi);

const issue: IssueRef = {
  kind: "github",
  host: "github.com",
  path: "acme/app",
  number: 42,
  url: "https://github.com/acme/app/issues/42",
};

function run(status: RunStatus, patch: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    rootTaskId: "t1",
    status,
    worktree: null,
    issue,
    issueClosed: false,
    issueCloseError: null,
    ...patch,
  } as WorkflowRun;
}

const initialStore = useWorkflowStore.getState();

describe("IssueSection", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    useWorkflowStore.setState(initialStore, true);
    useWorkflowStore.setState({ activeRoot: ROOT });
    api.listWorkflows.mockResolvedValue({ workflows: [], warnings: [] });
    api.listTasks.mockResolvedValue({ tasks: [], warnings: [] });
    api.listRuns.mockResolvedValue({ runs: [], warnings: [] });
    invoke.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(r: WorkflowRun | null) {
    await act(async () => root.render(<IssueSection issue={issue} run={r} />));
  }

  function retryButton() {
    return container.querySelector<HTMLButtonElement>('button[data-action="retryIssueClose"]');
  }

  it("opens the Issue link in the external browser", async () => {
    await render(null);
    const link = container.querySelector<HTMLAnchorElement>("a.workflow-issue__link")!;
    expect(link.textContent).toBe(i18n.t("workflow:intake.issue.link", { number: 42, host: "github.com", path: "acme/app" }));
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: issue.url });
    expect(dialogs.showMessage).not.toHaveBeenCalled();
  });

  it("shows a failure to open the Issue", async () => {
    invoke.mockRejectedValueOnce(new Error("no browser"));
    await render(null);
    await act(async () => container.querySelector<HTMLAnchorElement>("a.workflow-issue__link")!.click());
    expect(dialogs.showMessage).toHaveBeenCalledWith(expect.any(String), {
      title: i18n.t("workflow:intake.issue.openFailed"),
      kind: "error",
    });
  });

  it("shows a non-http Issue URL as text without a link", async () => {
    await act(async () => root.render(<IssueSection issue={{ ...issue, url: "file:///c:/x" }} run={null} />));
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".workflow-issue__text")?.textContent).toContain("#42");
  });

  it("uses the normalized URL as the link target", async () => {
    await render(null);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(issue.url);
  });

  it("renders a section with a heading when standalone", async () => {
    await act(async () => root.render(<IssueSection issue={issue} run={null} standalone />));
    const section = container.querySelector('section[data-section="issue"]')!;
    expect(section.querySelector("h3")?.textContent).toBe(i18n.t("workflow:intake.issue.title"));
  });

  it("shows the closed state of the run's Issue", async () => {
    await render(run("merged", { issueClosed: true }));
    expect(container.textContent).toContain(i18n.t("workflow:intake.issue.closed"));
    await render(run("active"));
    expect(container.textContent).toContain(i18n.t("workflow:intake.issue.stateOpen"));
  });

  it.each([
    ["merged", {}, true],
    ["merged", { issueClosed: true }, false],
    ["merged", { issue: null }, false],
    ["active", {}, false],
    ["awaiting_merge", {}, false],
    ["cancelled", {}, false],
  ] as [RunStatus, Partial<WorkflowRun>, boolean][])("offers retry close for a %s run %j: %s", async (status, patch, shown) => {
    await render(run(status, patch));
    expect(retryButton() !== null).toBe(shown);
  });

  it("shows the close error and retries closing the Issue", async () => {
    let resolve!: (r: WorkflowRun) => void;
    api.retryIssueClose.mockReturnValue(new Promise((r) => (resolve = r)));
    await render(run("merged", { issueCloseError: "FORGE_COMMAND_FAILED" }));
    expect(container.textContent).toContain(
      i18n.t("workflow:intake.issue.closeFailed", { error: formatCode("FORGE_COMMAND_FAILED") }),
    );
    const button = retryButton()!;
    expect(button.textContent).toBe(i18n.t("workflow:intake.issue.retryClose"));
    await act(async () => button.click());
    expect(api.retryIssueClose).toHaveBeenCalledWith(ROOT, "t1");
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(api.retryIssueClose).toHaveBeenCalledTimes(1);
    await act(async () => resolve(run("merged", { issueClosed: true })));
    expect(button.disabled).toBe(false);
    expect(api.listRuns).toHaveBeenCalled();
  });
});

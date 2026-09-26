// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergePreview, RunStatus, WorkflowRun } from "@/shared/types/workflow";

vi.mock("../../lib/workflow-api", () => ({
  workflowApi: {
    listWorkflows: vi.fn(),
    listTasks: vi.fn(),
    listRuns: vi.fn(),
    mergePreview: vi.fn(),
    mergeRun: vi.fn(),
    discardRun: vi.fn(),
  },
  subscribeWorkflowEvents: vi.fn(),
}));
vi.mock("@/stores/dialog-store", () => ({ showMessage: vi.fn(), showConfirm: vi.fn(), showPrompt: vi.fn() }));

import i18n from "@/shared/i18n";
import { showConfirm, showMessage } from "@/stores/dialog-store";
import { workflowApi } from "../../lib/workflow-api";
import { useWorkflowStore } from "../../workflow-store";
import { MergeSection } from "../MergeSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "C:\\work\\app";
const api = vi.mocked(workflowApi);

function runOf(status: RunStatus, withWorktree = true): WorkflowRun {
  return {
    schemaVersion: 1,
    rootTaskId: "t1",
    workflow: {
      id: "wf1",
      name: "Standard",
      enabled: true,
      archived: false,
      stages: [],
      maxReentryCount: 3,
    } as unknown as WorkflowRun["workflow"],
    status,
    currentTaskId: "t1",
    reentryCount: 0,
    worktree: withWorktree
      ? { path: "C:\\wt\\t1", branch: "mdium/t1", baseBranch: "main", baseCommit: "0123456789abcdef" }
      : null,
    attempts: [],
    pendingTransition: null,
    integrityBaseline: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    acknowledgedAgentConfig: [],
  };
}

function preview(patch: Partial<MergePreview> = {}): MergePreview {
  return {
    branch: "mdium/t1",
    baseBranch: "main",
    baseCommit: "0123456789abcdef",
    commits: [{ hash: "abcdef0123456789", subject: "agent work" }],
    diff: "diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-old line\n+new line\n",
    reviewPaths: [".github/workflows/ci.yml", "AGENTS.md"],
    integrityChanges: [],
    ...patch,
  };
}

const initialStore = useWorkflowStore.getState();

describe("MergeSection", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    useWorkflowStore.setState(initialStore, true);
    useWorkflowStore.setState({ activeRoot: ROOT, selectedTaskId: "t1" });
    api.listWorkflows.mockResolvedValue({ workflows: [], warnings: [] });
    api.listTasks.mockResolvedValue({ tasks: [], warnings: [] });
    api.listRuns.mockResolvedValue({ runs: [], warnings: [] });
    api.mergePreview.mockResolvedValue(preview());
    api.mergeRun.mockResolvedValue(runOf("merged"));
    api.discardRun.mockResolvedValue(runOf("discarded", false));
    vi.mocked(showConfirm).mockResolvedValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(run: WorkflowRun) {
    await act(async () => root.render(<MergeSection run={run} />));
  }

  function button(action: string) {
    return container.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  }

  async function click(el: HTMLElement | null) {
    await act(async () => el!.click());
  }

  function pathBoxes() {
    return [...container.querySelectorAll<HTMLInputElement>('input[data-review-path]')];
  }

  async function showPreview() {
    await click(button("preview"));
  }

  it("renders nothing for runs without merge or discard operations", async () => {
    await render(runOf("active"));
    expect(container.innerHTML).toBe("");
    await render(runOf("discarded", false));
    expect(container.innerHTML).toBe("");
    await render(runOf("cancelled", false));
    expect(container.innerHTML).toBe("");
  });

  it("renders the preview with commits, diff and review paths", async () => {
    await render(runOf("awaiting_merge"));
    expect(button("merge")).toBeNull();
    await showPreview();
    expect(api.mergePreview).toHaveBeenCalledWith(ROOT, "t1");
    const text = container.textContent ?? "";
    expect(text).toContain("mdium/t1");
    expect(text).toContain("main");
    expect(text).toContain("0123456");
    expect(text).not.toContain("0123456789abcdef");
    expect(text).toContain("abcdef0");
    expect(text).toContain("agent work");
    expect(container.querySelector(".unified-diff__line--added")?.textContent).toBe("+new line");
    expect(pathBoxes().map((b) => b.dataset.reviewPath)).toEqual([".github/workflows/ci.yml", "AGENTS.md"]);
    for (const box of pathBoxes()) expect(box.hasAttribute("data-switch")).toBe(true);
    expect(text).not.toContain("merge.");
  });

  it("enables the merge only when every review path is ticked and merges with them", async () => {
    await render(runOf("awaiting_merge"));
    await showPreview();
    expect(button("merge")!.disabled).toBe(true);
    await click(pathBoxes()[0]);
    expect(button("merge")!.disabled).toBe(true);
    await click(pathBoxes()[1]);
    expect(button("merge")!.disabled).toBe(false);

    await click(button("merge"));
    expect(showConfirm).toHaveBeenCalledWith(
      i18n.t("workflow:merge.mergeConfirm", { branch: "mdium/t1", baseBranch: "main" }),
      expect.anything(),
    );
    expect(api.mergeRun).toHaveBeenCalledWith(ROOT, "t1", [".github/workflows/ci.yml", "AGENTS.md"], false);
    expect(container.textContent).toContain(i18n.t("workflow:merge.done"));
    expect(showMessage).not.toHaveBeenCalled();
  });

  it("does not merge when the confirmation is declined", async () => {
    vi.mocked(showConfirm).mockResolvedValue(false);
    await render(runOf("awaiting_merge"));
    await showPreview();
    for (const box of pathBoxes()) await click(box);
    await click(button("merge"));
    expect(api.mergeRun).not.toHaveBeenCalled();
  });

  it("merges without review paths when there are none", async () => {
    api.mergePreview.mockResolvedValue(preview({ reviewPaths: [] }));
    await render(runOf("awaiting_merge"));
    await showPreview();
    expect(button("merge")!.disabled).toBe(false);
    await click(button("merge"));
    expect(api.mergeRun).toHaveBeenCalledWith(ROOT, "t1", [], false);
  });

  it("acknowledges integrity changes in two steps and re-runs the preview", async () => {
    api.mergePreview
      .mockResolvedValueOnce(
        preview({
          commits: [],
          diff: "",
          reviewPaths: [],
          integrityChanges: [{ code: "INTEGRITY_HOOKS_CHANGED", detail: "pre-commit" }],
        }),
      )
      .mockResolvedValueOnce(preview());
    api.mergeRun.mockRejectedValueOnce({ code: "WORKFLOW_MERGE_REVIEW_CHANGED", message: "" });
    await render(runOf("awaiting_merge"));
    await showPreview();

    const text = container.textContent ?? "";
    expect(text).toContain(i18n.t("workflow:codes.INTEGRITY_HOOKS_CHANGED"));
    expect(text).toContain("pre-commit");
    expect(button("merge")).toBeNull();
    expect(pathBoxes()).toHaveLength(0);
    expect(button("recheck")!.disabled).toBe(true);
    await click(container.querySelector<HTMLInputElement>('input[name="acknowledgeIntegrity"]'));
    expect(button("recheck")!.disabled).toBe(false);

    await click(button("recheck"));
    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(api.mergeRun).toHaveBeenCalledWith(ROOT, "t1", [], true);
    // The expected refusal is not an error for the user: the preview is loaded again.
    expect(showMessage).not.toHaveBeenCalled();
    expect(api.mergePreview).toHaveBeenCalledTimes(2);
    expect(pathBoxes()).toHaveLength(2);
    expect(container.querySelector('input[name="acknowledgeIntegrity"]')).toBeNull();
  });

  it("shows the merge as done when the acknowledgement merged right away", async () => {
    api.mergePreview.mockResolvedValue(
      preview({ commits: [], diff: "", reviewPaths: [], integrityChanges: [{ code: "INTEGRITY_GIT_CONFIG_CHANGED", detail: "" }] }),
    );
    await render(runOf("awaiting_merge"));
    await showPreview();
    await click(container.querySelector<HTMLInputElement>('input[name="acknowledgeIntegrity"]'));
    await click(button("recheck"));
    expect(api.mergeRun).toHaveBeenCalledWith(ROOT, "t1", [], true);
    expect(container.textContent).toContain(i18n.t("workflow:merge.done"));
  });

  it.each([
    "GIT_NOT_ON_BASE_BRANCH",
    "GIT_DIRTY_WORKTREE",
    "GIT_MERGE_CONFLICT",
    "GIT_MERGE_FAILED",
    "GIT_MERGE_ABORT_FAILED",
  ])("shows the localized text of %s", async (code) => {
    api.mergePreview.mockResolvedValue(preview({ reviewPaths: [] }));
    api.mergeRun.mockRejectedValueOnce({ code, message: "" });
    await render(runOf("awaiting_merge"));
    await showPreview();
    await click(button("merge"));
    const expected = i18n.t(`workflow:codes.${code}`);
    expect(expected).not.toContain("codes.");
    expect(showMessage).toHaveBeenCalledWith(expected, { title: i18n.t("workflow:merge.failed"), kind: "error" });
    expect(container.textContent).not.toContain(i18n.t("workflow:merge.done"));
  });

  it("reloads the preview when the merge is refused because the review paths changed", async () => {
    api.mergePreview.mockResolvedValueOnce(preview({ reviewPaths: [] })).mockResolvedValueOnce(preview());
    api.mergeRun.mockRejectedValueOnce({ code: "WORKFLOW_MERGE_REVIEW_CHANGED", message: "" });
    await render(runOf("awaiting_merge"));
    await showPreview();
    await click(button("merge"));
    expect(showMessage).toHaveBeenCalledTimes(1);
    expect(api.mergePreview).toHaveBeenCalledTimes(2);
    expect(pathBoxes()).toHaveLength(2);
    expect(button("merge")!.disabled).toBe(true);
  });

  it("shows preview errors", async () => {
    api.mergePreview.mockRejectedValueOnce({ code: "GIT_FAILED", message: "boom" });
    await render(runOf("awaiting_merge"));
    await showPreview();
    expect(showMessage).toHaveBeenCalledWith(`${i18n.t("workflow:codes.GIT_FAILED")}\nboom`, {
      title: i18n.t("workflow:merge.previewFailed"),
      kind: "error",
    });
    expect(button("merge")).toBeNull();
  });

  it("discards a cancelled run after confirming", async () => {
    await render(runOf("cancelled"));
    expect(button("preview")).toBeNull();
    await click(button("discard"));
    expect(showConfirm).toHaveBeenCalledWith(
      i18n.t("workflow:merge.discardConfirm", { branch: "mdium/t1" }),
      expect.anything(),
    );
    expect(api.discardRun).toHaveBeenCalledWith(ROOT, "t1");
  });

  it("does not discard when the confirmation is declined", async () => {
    vi.mocked(showConfirm).mockResolvedValue(false);
    await render(runOf("cancelled"));
    await click(button("discard"));
    expect(api.discardRun).not.toHaveBeenCalled();
  });

  it("offers removing the worktree of a merged run", async () => {
    await render(runOf("merged"));
    await click(button("removeWorktree"));
    expect(showConfirm).toHaveBeenCalledWith(
      i18n.t("workflow:merge.removeWorktreeConfirm", { branch: "mdium/t1", baseBranch: "main" }),
      expect.anything(),
    );
    expect(api.discardRun).toHaveBeenCalledWith(ROOT, "t1");
  });

  it("offers removing the worktree right after a merge", async () => {
    api.mergePreview.mockResolvedValue(preview({ reviewPaths: [] }));
    await render(runOf("awaiting_merge"));
    await showPreview();
    await click(button("merge"));
    // The store refresh delivers the merged run.
    await render(runOf("merged"));
    expect(container.textContent).toContain(i18n.t("workflow:merge.done"));
    await click(button("removeWorktree"));
    expect(api.discardRun).toHaveBeenCalledWith(ROOT, "t1");
  });

  it("caps a very large diff with a truncation note", async () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `+line ${i} ${"x".repeat(20)}`);
    api.mergePreview.mockResolvedValue(preview({ diff: `@@ -0,0 +1,20000 @@\n${lines.join("\n")}\n` }));
    await render(runOf("awaiting_merge"));
    await showPreview();
    expect(container.querySelectorAll(".unified-diff__line")).toHaveLength(5000);
    expect(container.querySelector(".unified-diff__truncated")?.textContent).toBe(
      i18n.t("common:truncatedLines", { count: 20001 - 5000 }),
    );
  });
});

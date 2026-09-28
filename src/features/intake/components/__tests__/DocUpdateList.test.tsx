// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocUpdateProposal, IntakeSessionView } from "@/shared/types/workflow";

const api = vi.hoisted(() => ({
  intakeGet: vi.fn(),
  intakeListDrafts: vi.fn(),
  intakeApplyDocUpdate: vi.fn(),
}));
vi.mock("@/features/workflow/lib/workflow-api", () => ({
  workflowApi: api,
  subscribeIntakeChanged: vi.fn(),
  subscribeWorkflowsChanged: vi.fn(),
}));
const readTextFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile }));
vi.mock("@tauri-apps/api/path", () => ({ join: async (...parts: string[]) => parts.join("\\") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn() }) }));
const dialogs = vi.hoisted(() => ({ showMessage: vi.fn(), showConfirm: vi.fn() }));
vi.mock("@/stores/dialog-store", () => dialogs);

import i18n from "@/shared/i18n";
import { formatCode } from "@/features/workflow/lib/format";
import { useIntakeStore } from "../../intake-store";
import { DocUpdateList, MAX_DIFF_SOURCE_CHARS } from "../DocUpdateList";
import { reviewSession } from "./review-test-utils";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: "workflow", ...opts });
const ROOT = "C:\\proj";

function doc(patch: Partial<DocUpdateProposal> = {}): DocUpdateProposal {
  return {
    id: "p1",
    path: "docs/guide.md",
    content: "# Guide\nnew line\n",
    status: "pending",
    reason: null,
    baseSha256: "abc",
    ...patch,
  };
}

describe("DocUpdateList", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    useIntakeStore.setState(useIntakeStore.getInitialState(), true);
    readTextFile.mockResolvedValue("# Guide\nold line\n");
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
  });

  function Wrapper() {
    const current = useIntakeStore((s) => s.session);
    return current ? <DocUpdateList session={current} /> : null;
  }

  async function mount(view: IntakeSessionView) {
    useIntakeStore.setState({ root: ROOT, intakeId: view.id, session: view });
    root = createRoot(container);
    await act(async () => root?.render(<Wrapper />));
    // Let the current file content load.
    await act(async () => {});
  }

  const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T & Element>(sel);
  const lines = (kind: string) =>
    [...container.querySelectorAll(`.unified-diff__line--${kind}`)].map((el) => el.textContent);

  async function click(el: Element | null) {
    await act(async () => (el as HTMLElement).click());
  }

  it("diffs the proposed content against the current file", async () => {
    await mount(reviewSession({ docUpdates: [doc()] }));
    expect(readTextFile).toHaveBeenCalledWith("C:\\proj\\docs/guide.md");
    expect(q(".intake-doc__path")?.textContent).toBe("docs/guide.md");
    expect(q(".intake-doc__status")?.textContent).toBe(t("intake.docUpdates.status.pending"));
    expect(lines("removed")).toEqual(["-old line"]);
    expect(lines("added")).toEqual(["+new line"]);
  });

  it("diffs a new file against empty content", async () => {
    readTextFile.mockRejectedValue(new Error("failed to open file: os error 2"));
    await mount(reviewSession({ docUpdates: [doc({ baseSha256: null })] }));
    expect(container.textContent).toContain(t("intake.docUpdates.newFile"));
    expect(lines("added")).toEqual(["+# Guide", "+new line"]);
    expect(lines("removed")).toEqual([]);
  });

  it("reports a file that cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readTextFile.mockRejectedValue(new Error("access denied"));
    await mount(reviewSession({ docUpdates: [doc({ baseSha256: null })] }));
    expect(container.textContent).toContain(t("intake.docUpdates.readFailed"));
    expect(container.textContent).not.toContain(t("intake.docUpdates.newFile"));
    expect(q<HTMLButtonElement>(".intake-doc__apply")?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(".intake-doc__reject")?.disabled).toBe(false);
    warn.mockRestore();
  });

  it("reports a file deleted since the proposal", async () => {
    readTextFile.mockRejectedValue(new Error("failed to open file: os error 2"));
    await mount(reviewSession({ docUpdates: [doc()] }));
    expect(container.textContent).toContain(t("intake.docUpdates.deleted"));
    expect(container.textContent).not.toContain(t("intake.docUpdates.newFile"));
    expect(container.querySelector(".unified-diff")).toBeNull();
    expect(q<HTMLButtonElement>(".intake-doc__apply")?.disabled).toBe(true);
  });

  it("does not diff a very large current file", async () => {
    readTextFile.mockResolvedValue("x".repeat(MAX_DIFF_SOURCE_CHARS + 1));
    await mount(reviewSession({ docUpdates: [doc()] }));
    expect(container.textContent).toContain(t("intake.docUpdates.fileTooLarge"));
    expect(container.querySelector(".unified-diff")).toBeNull();
    expect(q<HTMLButtonElement>(".intake-doc__apply")?.disabled).toBe(true);
  });

  it("gives up on a diff that is too large to compute", async () => {
    const block = (p: string) => Array.from({ length: 3000 }, (_, i) => `${p}${i}`).join("\n");
    readTextFile.mockResolvedValue(block("old"));
    await mount(reviewSession({ docUpdates: [doc({ content: block("new") })] }));
    expect(container.textContent).toContain(t("intake.docUpdates.diffTooLarge"));
    expect(container.querySelector(".unified-diff")).toBeNull();
    expect(q<HTMLButtonElement>(".intake-doc__apply")?.disabled).toBe(false);
  });

  it("applies and rejects pending updates", async () => {
    api.intakeApplyDocUpdate.mockResolvedValue(
      reviewSession({ docUpdates: [doc({ status: "applied" })], appliedDocPaths: ["docs/guide.md"] }),
    );
    await mount(reviewSession({ docUpdates: [doc()] }));
    await click(q(".intake-doc__apply"));
    expect(api.intakeApplyDocUpdate).toHaveBeenCalledWith(ROOT, "i1", "p1", true);
    expect(q(".intake-doc__apply")).toBeNull();
    expect(q(".intake-doc__status")?.textContent).toBe(t("intake.docUpdates.status.applied"));

    await act(async () => useIntakeStore.setState({ session: reviewSession({ docUpdates: [doc({ id: "p2" })] }) }));
    await act(async () => {});
    api.intakeApplyDocUpdate.mockResolvedValue(reviewSession({ docUpdates: [doc({ id: "p2", status: "rejected" })] }));
    await click(q(".intake-doc__reject"));
    expect(api.intakeApplyDocUpdate).toHaveBeenLastCalledWith(ROOT, "i1", "p2", false);
  });

  it("disables the buttons while a request is in flight", async () => {
    let resolve!: (v: IntakeSessionView) => void;
    api.intakeApplyDocUpdate.mockReturnValue(new Promise((r) => (resolve = r)));
    await mount(reviewSession({ docUpdates: [doc()] }));
    await click(q(".intake-doc__apply"));
    expect(q<HTMLButtonElement>(".intake-doc__apply")?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(".intake-doc__reject")?.disabled).toBe(true);
    await click(q(".intake-doc__reject"));
    expect(api.intakeApplyDocUpdate).toHaveBeenCalledTimes(1);
    await act(async () => resolve(reviewSession({ docUpdates: [doc()] })));
  });

  it("explains a file changed since the proposal and reloads the diff", async () => {
    api.intakeApplyDocUpdate.mockRejectedValue({ code: "INTAKE_DOC_CHANGED_SINCE_PROPOSAL", message: "" });
    await mount(reviewSession({ docUpdates: [doc()] }));
    await click(q(".intake-doc__apply"));
    expect(q(".intake-doc__error")?.textContent).toBe(t("intake.docUpdates.changed"));
    expect(dialogs.showMessage).not.toHaveBeenCalled();
    expect(q<HTMLButtonElement>(".intake-doc__apply")?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(".intake-doc__reject")?.disabled).toBe(false);

    readTextFile.mockResolvedValue("# Guide\nedited by user\n");
    await click(q(".intake-doc__reload"));
    await act(async () => {});
    expect(readTextFile).toHaveBeenCalledTimes(2);
    expect(lines("removed")).toEqual(["-edited by user"]);
    // The update stays unappliable: only rejecting or a new proposal helps.
    expect(q(".intake-doc__error")?.textContent).toBe(t("intake.docUpdates.changed"));
    expect(q<HTMLButtonElement>(".intake-doc__apply")?.disabled).toBe(true);
  });

  it("shows other apply failures inline", async () => {
    api.intakeApplyDocUpdate.mockRejectedValue({ code: "INTAKE_DOC_PATH_PROTECTED", message: "" });
    await mount(reviewSession({ docUpdates: [doc()] }));
    await click(q(".intake-doc__apply"));
    expect(q(".intake-doc__error")?.textContent).toBe(formatCode("INTAKE_DOC_PATH_PROTECTED"));
    expect(q(".intake-doc__reload")).toBeNull();
  });

  it("shows why an update was rejected when proposed", async () => {
    await mount(reviewSession({ docUpdates: [doc({ status: "rejected", reason: "INTAKE_DOC_PATH_INVALID" })] }));
    expect(q(".intake-doc__reason")?.textContent).toBe(
      t("intake.docUpdates.reason", { reason: formatCode("INTAKE_DOC_PATH_INVALID") }),
    );
    expect(q(".intake-doc__apply")).toBeNull();
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("lists the applied documents with a reminder to commit them", async () => {
    await mount(reviewSession({ docUpdates: [doc({ status: "applied" })], appliedDocPaths: ["docs/guide.md"] }));
    const notice = q(".intake-docs__applied")!;
    expect(notice.textContent).toContain(t("intake.docUpdates.appliedNotice"));
    expect([...notice.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["docs/guide.md"]);
  });

  it("hides pending updates once the intake is done or abandoned", async () => {
    await mount(
      reviewSession({
        status: "done",
        docUpdates: [doc(), doc({ id: "p2", path: "docs/b.md", status: "applied" })],
        appliedDocPaths: ["docs/b.md"],
      }),
    );
    expect([...container.querySelectorAll(".intake-doc__path")].map((el) => el.textContent)).toEqual(["docs/b.md"]);
    expect(readTextFile).not.toHaveBeenCalled();
    await act(async () => useIntakeStore.setState({ session: reviewSession({ status: "abandoned", docUpdates: [doc()] }) }));
    expect(container.innerHTML).toBe("");
  });
});

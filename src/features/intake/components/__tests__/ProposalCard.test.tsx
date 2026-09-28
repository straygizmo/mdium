// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntakeSessionView } from "@/shared/types/workflow";

const api = vi.hoisted(() => ({
  intakeGet: vi.fn(),
  intakeListDrafts: vi.fn(),
  intakeUpdateProposal: vi.fn(),
}));
vi.mock("@/features/workflow/lib/workflow-api", () => ({
  workflowApi: api,
  subscribeIntakeChanged: vi.fn(),
  subscribeWorkflowsChanged: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn() }) }));
const dialogs = vi.hoisted(() => ({ showMessage: vi.fn(), showConfirm: vi.fn() }));
vi.mock("@/stores/dialog-store", () => dialogs);

import i18n from "@/shared/i18n";
import { formatCode } from "@/features/workflow/lib/format";
import { useIntakeStore } from "../../intake-store";
import { ProposalCard } from "../ProposalCard";
import { reviewSession } from "./review-test-utils";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: "workflow", ...opts });
const ROOT = "C:\\proj";

describe("ProposalCard", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    useIntakeStore.setState(useIntakeStore.getInitialState(), true);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
  });

  function Wrapper() {
    const current = useIntakeStore((s) => s.session);
    return current ? <ProposalCard session={current} /> : null;
  }

  async function mount(view: IntakeSessionView) {
    useIntakeStore.setState({ root: ROOT, intakeId: view.id, session: view });
    root = createRoot(container);
    await act(async () => root?.render(<Wrapper />));
  }

  const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T & Element>(sel);

  async function click(el: Element | null) {
    await act(async () => (el as HTMLElement).click());
  }

  async function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("renders the proposal through the safe Markdown renderer", async () => {
    await mount(reviewSession({ proposal: { title: "Export CSV", body: "**bold** <script>x()</script>" } }));
    expect(q(".intake-proposal__title")?.textContent).toBe("Export CSV");
    expect(q(".intake-proposal__body strong")?.textContent).toBe("bold");
    expect(q(".intake-proposal__body script")).toBeNull();
    expect(container.textContent).toContain(t("intake.proposal.refineHint"));
  });

  it("saves an edited proposal and leaves edit mode", async () => {
    api.intakeUpdateProposal.mockResolvedValue(reviewSession({ proposal: { title: "New title", body: "New body" } }));
    await mount(reviewSession());
    await click(q(".intake-proposal__edit"));
    expect(q<HTMLInputElement>(".intake-proposal__title-input")?.value).toBe("Export CSV");
    await setValue(q<HTMLInputElement>(".intake-proposal__title-input")!, "New title");
    await setValue(q<HTMLTextAreaElement>(".intake-proposal__body-input")!, "New body");
    await click(q(".intake-proposal__save"));
    expect(api.intakeUpdateProposal).toHaveBeenCalledWith(ROOT, "i1", "New title", "New body");
    expect(q(".intake-proposal__title-input")).toBeNull();
    expect(q(".intake-proposal__title")?.textContent).toBe("New title");
  });

  it("shows a validation failure inline and keeps the edit", async () => {
    api.intakeUpdateProposal.mockRejectedValue({ code: "INTAKE_PROPOSAL_TITLE_INVALID", message: "" });
    await mount(reviewSession());
    await click(q(".intake-proposal__edit"));
    await setValue(q<HTMLInputElement>(".intake-proposal__title-input")!, " ");
    await click(q(".intake-proposal__save"));
    expect(q(".intake-proposal__error")?.textContent).toBe(formatCode("INTAKE_PROPOSAL_TITLE_INVALID"));
    expect(q<HTMLInputElement>(".intake-proposal__title-input")?.value).toBe(" ");
    expect(dialogs.showMessage).not.toHaveBeenCalled();
  });

  it("disables saving while the save is in flight", async () => {
    let resolve!: (v: IntakeSessionView) => void;
    api.intakeUpdateProposal.mockReturnValue(new Promise((r) => (resolve = r)));
    await mount(reviewSession());
    await click(q(".intake-proposal__edit"));
    await click(q(".intake-proposal__save"));
    expect(q<HTMLButtonElement>(".intake-proposal__save")?.disabled).toBe(true);
    expect(q(".intake-proposal__save")?.textContent).toBe(t("intake.proposal.saving"));
    await click(q(".intake-proposal__save"));
    expect(api.intakeUpdateProposal).toHaveBeenCalledTimes(1);
    await act(async () => resolve(reviewSession()));
  });

  it("asks before discarding changes", async () => {
    dialogs.showConfirm.mockResolvedValue(false);
    await mount(reviewSession());
    await click(q(".intake-proposal__edit"));
    await setValue(q<HTMLInputElement>(".intake-proposal__title-input")!, "Changed");
    await click(q(".intake-proposal__cancel"));
    expect(dialogs.showConfirm).toHaveBeenCalled();
    expect(q(".intake-proposal__title-input")).not.toBeNull();
  });

  it("cannot be edited while the agent replies or after the conversation", async () => {
    await mount(reviewSession({ busy: true }));
    expect(q<HTMLButtonElement>(".intake-proposal__edit")?.disabled).toBe(true);
    expect(container.textContent).toContain(t("intake.proposal.busyHint"));
    await act(async () => useIntakeStore.setState({ session: reviewSession({ status: "done" }) }));
    expect(q(".intake-proposal__edit")).toBeNull();
    expect(container.textContent).not.toContain(t("intake.proposal.refineHint"));
  });
});

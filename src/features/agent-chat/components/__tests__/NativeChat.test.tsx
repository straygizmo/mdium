// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";

vi.mock("../../lib/agent-runner-client", () => ({
  sendToRunner: vi.fn(async () => {}),
  requestRunner: vi.fn(async () => ({ availability: { kind: "missing", detail: "codex" } })),
  onRunnerMessage: vi.fn(() => () => {}),
  newRunnerId: vi.fn(() => "id"),
}));

import { useAgentChatStore } from "../../agent-chat-store";
import { NativeChat } from "../NativeChat";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FOLDER = "C:/w";

describe("NativeChat", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useAgentChatStore.setState({ selectedTab: "copilot", chats: {}, availability: {} });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  });

  it("keeps the input text when send resolves false, and clears it when send resolves true", async () => {
    const send = vi.spyOn(useAgentChatStore.getState(), "send").mockResolvedValueOnce(false);
    await act(async () => root.render(<NativeChat folder={FOLDER} provider="copilot" />));
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;
    const sendBtn = [...container.querySelectorAll("button")].find((b) => b.title === "Send")!;

    // Use the native value setter (as @testing-library/react's fireEvent does)
    // so React's controlled-input value tracker sees the change and fires onChange.
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(textarea, "hello");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => sendBtn.click());
    expect(send).toHaveBeenCalledWith(FOLDER, "copilot", "hello");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello");

    send.mockResolvedValueOnce(true);
    await act(async () => sendBtn.click());
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("localizes COPILOT_DISCONNECTED and SESSION_CLOSED error entries", async () => {
    useAgentChatStore.setState({
      chats: {
        "copilot::C:/w": {
          sessionId: "s1",
          status: "idle",
          entries: [
            { id: "e1", role: "error", text: "COPILOT_DISCONNECTED" },
            { id: "e2", role: "error", text: "SESSION_CLOSED" },
          ],
          pendingPermissions: [],
        },
      },
    });
    await act(async () => root.render(<NativeChat folder={FOLDER} provider="copilot" />));
    expect(container.textContent).toContain(i18n.t("errorCopilotDisconnected", { ns: "agent-chat" }));
    expect(container.textContent).toContain(i18n.t("errorSessionUnavailable", { ns: "agent-chat" }));
  });

  it("shows a distinct message when loading session history fails", async () => {
    vi.spyOn(useAgentChatStore.getState(), "listSessions").mockRejectedValueOnce(new Error("boom"));
    await act(async () => root.render(<NativeChat folder={FOLDER} provider="copilot" />));
    const historyBtn = [...container.querySelectorAll("button")].find((b) => b.title === "Session history")!;
    await act(async () => historyBtn.click());
    expect(container.textContent).toContain(i18n.t("historyError", { ns: "agent-chat" }));
    expect(container.textContent).not.toContain(i18n.t("noHistory", { ns: "agent-chat" }));
  });
});

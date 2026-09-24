// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";

vi.mock("@/features/opencode-config/components/OpencodeConfigPanel", () => ({
  OpencodeConfigPanel: () => <div data-testid="opencode-panel" />,
}));
vi.mock("../../lib/agent-runner-client", () => ({
  sendToRunner: vi.fn(async () => {}),
  requestRunner: vi.fn(async () => ({ availability: { kind: "missing", detail: "codex" } })),
  onRunnerMessage: vi.fn(() => () => {}),
  newRunnerId: vi.fn(() => "id"),
}));

import { useTabStore } from "@/stores/tab-store";
import { useAgentChatStore } from "../../agent-chat-store";
import { AgentChatPanel } from "../AgentChatPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentChatPanel", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useTabStore.setState({ activeFolderPath: "C:/w" });
    useAgentChatStore.setState({
      selectedTab: "opencode",
      chats: {},
      availability: { codex: { kind: "missing", detail: "codex" }, copilot: { kind: "available", version: "1.0.88" } },
    });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useTabStore.setState({ activeFolderPath: null });
  });

  it("shows the opencode panel by default and switches to an available native tab", async () => {
    await act(async () => root.render(<AgentChatPanel />));
    expect(container.querySelector('[data-testid="opencode-panel"]')).not.toBeNull();
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["opencode", "Codex", "Copilot"]);

    await act(async () => tabs[2].click());
    expect(useAgentChatStore.getState().selectedTab).toBe("copilot");
    expect(container.querySelector('[data-testid="opencode-panel"]')).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("disables an unavailable provider tab and explains why", async () => {
    await act(async () => root.render(<AgentChatPanel />));
    const codex = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')][1];
    expect(codex.disabled).toBe(true);
    expect(codex.title).toBe(i18n.t("unavailableMissing", { ns: "agent-chat", name: "Codex" }));
  });

  it("renders a pending permission with allow and deny", async () => {
    useAgentChatStore.setState({
      selectedTab: "copilot",
      chats: {
        "copilot::C:/w": {
          sessionId: "s1",
          status: "running",
          entries: [{ id: "u", role: "user", text: "hi" }],
          pendingPermission: { permissionId: "p1", request: { kind: "shell", summary: "npm test" } },
        },
      },
    });
    const respond = vi.spyOn(useAgentChatStore.getState(), "respondPermission").mockResolvedValue();
    await act(async () => root.render(<AgentChatPanel />));
    expect(container.textContent).toContain("npm test");
    const allow = [...container.querySelectorAll("button")].find((b) => b.textContent === "Allow")!;
    await act(async () => allow.click());
    expect(respond).toHaveBeenCalledWith("C:/w", "copilot", true);
  });
});

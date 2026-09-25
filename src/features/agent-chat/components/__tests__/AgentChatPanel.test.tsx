// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";

vi.mock("@/features/opencode-config/components/OpencodeConfigPanel", () => ({
  OpencodeConfigPanel: () => <div data-testid="opencode-panel" />,
}));
vi.mock("@/features/claude-config/components/ClaudePanel", () => ({
  ClaudePanel: () => <div data-testid="claude-panel" />,
}));
vi.mock("../../lib/agent-runner-client", () => ({
  sendToRunner: vi.fn(async () => {}),
  requestRunner: vi.fn(async () => ({ availability: { kind: "missing", detail: "codex" } })),
  onRunnerMessage: vi.fn(() => () => {}),
  newRunnerId: vi.fn(() => "id"),
}));

import { useTabStore } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";
import { useAgentChatStore } from "../../agent-chat-store";
import { requestRunner } from "../../lib/agent-runner-client";
import { AgentChatPanel } from "../AgentChatPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentChatPanel", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useTabStore.setState({ activeFolderPath: "C:/w" });
    useUiStore.setState({ leftPanel: "opencode-config" });
    useAgentChatStore.setState({
      selectedTab: "opencode",
      chats: {},
      availability: { codex: { kind: "missing", detail: "codex" }, copilot: { kind: "available", version: "1.0.88" } },
    });
    vi.mocked(requestRunner).mockClear();
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useTabStore.setState({ activeFolderPath: null });
    useUiStore.setState({ leftPanel: "folder" });
  });

  it("shows the opencode panel by default and switches to an available native tab", async () => {
    await act(async () => root.render(<AgentChatPanel />));
    expect(container.querySelector('[data-testid="opencode-panel"]')).not.toBeNull();
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["opencode", "Claude", "Codex", "Copilot"]);

    await act(async () => tabs[3].click());
    expect(useAgentChatStore.getState().selectedTab).toBe("copilot");
    expect(container.querySelector('[data-testid="opencode-panel"]')).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("hosts the existing Claude panel in an always-enabled Claude tab", async () => {
    await act(async () => root.render(<AgentChatPanel />));
    const claude = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')][1];
    expect(claude.disabled).toBe(false);
    await act(async () => claude.click());
    expect(useAgentChatStore.getState().selectedTab).toBe("claude");
    expect(container.querySelector('[data-testid="claude-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="opencode-panel"]')).toBeNull();
  });

  it("disables an unavailable provider tab and explains why", async () => {
    await act(async () => root.render(<AgentChatPanel />));
    const codex = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')][2];
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
          pendingPermissions: [{ permissionId: "p1", request: { kind: "shell", summary: "npm test" } }],
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

  it("maps spawn/version error details to the availabilityCheckFailed message, never the raw code", async () => {
    // Keep the panel hidden so the mount-time re-probe effect (tested
    // separately below) does not overwrite this fixture's availability.
    useUiStore.setState({ leftPanel: "folder" });
    useAgentChatStore.setState({
      availability: { codex: { kind: "error", detail: "spawn" }, copilot: { kind: "error", detail: "version" } },
    });
    await act(async () => root.render(<AgentChatPanel />));
    const [, , codex, copilot] = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const expected = i18n.t("availabilityCheckFailed", { ns: "agent-chat", name: "Codex" });
    expect(codex.title).toBe(expected);
    expect(codex.title).not.toContain("spawn");
    expect(copilot.title).toBe(i18n.t("availabilityCheckFailed", { ns: "agent-chat", name: "Copilot" }));
  });

  it("maps RUNNER_EXITED/RUNNER_START_TIMEOUT error details to the availabilityRunnerFailed message", async () => {
    useUiStore.setState({ leftPanel: "folder" });
    useAgentChatStore.setState({
      availability: { codex: { kind: "error", detail: "RUNNER_EXITED" }, copilot: { kind: "error", detail: "RUNNER_START_TIMEOUT" } },
    });
    await act(async () => root.render(<AgentChatPanel />));
    const [, , codex, copilot] = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(codex.title).toBe(i18n.t("availabilityRunnerFailed", { ns: "agent-chat", name: "Codex" }));
    expect(copilot.title).toBe(i18n.t("availabilityRunnerFailed", { ns: "agent-chat", name: "Copilot" }));
  });

  it("falls back to the generic message, without the raw detail, for unknown error codes", async () => {
    useUiStore.setState({ leftPanel: "folder" });
    useAgentChatStore.setState({
      availability: { codex: { kind: "error", detail: "ENOENT: something weird" }, copilot: { kind: "available", version: "1" } },
    });
    await act(async () => root.render(<AgentChatPanel />));
    const codex = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')][2];
    expect(codex.title).toBe(i18n.t("unavailableError", { ns: "agent-chat", name: "Codex" }));
    expect(codex.title).not.toContain("ENOENT");
  });

  it("shows the unknownVersion key instead of a hard-coded '?' when too_old has no detected version", async () => {
    useAgentChatStore.setState({
      availability: { codex: { kind: "too_old", detail: "1.2.3" }, copilot: { kind: "available", version: "1" } },
    });
    await act(async () => root.render(<AgentChatPanel />));
    const codex = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')][2];
    expect(codex.title).toBe(i18n.t("unavailableTooOld", { ns: "agent-chat", name: "Codex", minimum: "1.2.3", found: i18n.t("unknownVersion", { ns: "agent-chat" }) }));
    expect(codex.title).not.toContain("?");
  });

  it("re-probes a provider stuck in error when the panel becomes visible", async () => {
    useUiStore.setState({ leftPanel: "folder" });
    useAgentChatStore.setState({
      availability: { codex: { kind: "error", detail: "spawn" }, copilot: { kind: "available", version: "1" } },
    });
    await act(async () => root.render(<AgentChatPanel />));
    expect(requestRunner).not.toHaveBeenCalled();

    await act(async () => { useUiStore.setState({ leftPanel: "opencode-config" }); });

    expect(requestRunner).toHaveBeenCalledWith(expect.objectContaining({ type: "probe", provider: "codex" }), "availability");
    expect(requestRunner).not.toHaveBeenCalledWith(expect.objectContaining({ type: "probe", provider: "copilot" }), "availability");
  });
});

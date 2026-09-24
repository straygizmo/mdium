// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServersSection } from "./McpServersSection";
import { useOpencodeConfigStore } from "@/stores/opencode-config-store";
import { useTabStore } from "@/stores/tab-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/dialog-store", () => ({
  showConfirm: vi.fn().mockResolvedValue(true),
  showChoice: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/features/opencode-config/hooks/useOpencodeChat", () => ({
  getOpencodeClient: vi.fn(() => null),
}));

const initialState = useOpencodeConfigStore.getState();

describe("McpServersSection", () => {
  afterEach(() => {
    useTabStore.setState({ activeFolderPath: null });
    useOpencodeConfigStore.setState({
      config: initialState.config,
      projectMcpServers: initialState.projectMcpServers,
      loadConfig: initialState.loadConfig,
      loadProjectMcpServers: initialState.loadProjectMcpServers,
    });
  });

  it("keeps all MCP cards in the scrollable list and can edit the last card", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const mcp = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [
        `server-${index + 1}`,
        { type: "local" as const, command: ["npx", `server-${index + 1}`], enabled: false },
      ]),
    );
    useTabStore.setState({ activeFolderPath: "C:/project" });
    useOpencodeConfigStore.setState({
      config: { mcp },
      projectMcpServers: {},
      loadConfig: vi.fn().mockResolvedValue(undefined),
      loadProjectMcpServers: vi.fn().mockResolvedValue(undefined),
    });

    await act(async () => { root.render(<McpServersSection />); });

    const list = container.querySelector(".oc-mcp-servers__list");
    const actions = container.querySelector(".oc-mcp-servers__actions");
    const cards = container.querySelectorAll(".oc-section__item");
    expect(cards).toHaveLength(11);
    expect(list?.nextElementSibling).toBe(actions);
    expect(list?.contains(cards[10])).toBe(true);

    await act(async () => {
      cards[10].querySelector<HTMLButtonElement>(".oc-section__edit-btn")?.click();
    });
    expect(container.querySelector<HTMLInputElement>(".oc-section__input")?.value).toBe("server-11");
    await act(async () => root.unmount());
  });

  it("defines the MCP list scroll and actions shrink rules", async () => {
    const css = await readFile(
      resolve(process.cwd(), "src/features/opencode-config/components/OpencodeConfigDialog.css"),
      "utf8",
    );
    expect(css).toMatch(/\.oc-mcp-servers__list\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
    expect(css).toMatch(/\.oc-mcp-servers__actions\s*\{[^}]*flex-shrink:\s*0;/s);
  });
});

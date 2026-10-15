// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpencodeChat } from "./OpencodeChat";
import { useChatUIStore } from "../hooks/useOpencodeChat";
import { useTabStore } from "@/stores/tab-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), exists: vi.fn() }));

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(ui));
  return { container, unmount: () => act(async () => root.unmount()) };
}

describe("OpencodeChat variants", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null, activeFolderPath: null });
    useChatUIStore.setState({ connected: true, connecting: false, messages: [], loading: false });
  });
  afterEach(() => {
    useChatUIStore.setState({ connected: false });
  });

  it("panel variant renders the toolbar and md toggle", async () => {
    const { container, unmount } = await render(<OpencodeChat />);
    expect(container.querySelector(".oc-chat__toolbar")).not.toBeNull();
    expect(container.querySelector(".oc-chat__md-toggle-row")).not.toBeNull();
    await unmount();
  });

  it("macro variant renders the header instead and uses the custom placeholder", async () => {
    const { container, unmount } = await render(
      <OpencodeChat variant="macro" header={<div data-testid="hdr">H</div>} placeholder="Describe the change" />,
    );
    expect(container.querySelector('[data-testid="hdr"]')).not.toBeNull();
    expect(container.querySelector(".oc-chat__toolbar")).toBeNull();
    expect(container.querySelector(".oc-chat__md-toggle-row")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>(".oc-chat__input")?.placeholder).toBe("Describe the change");
    await unmount();
  });
});

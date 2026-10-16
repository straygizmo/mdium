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

const sendMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("../hooks/useOpencodeChat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useOpencodeChat")>();
  return {
    ...actual,
    useOpencodeChat: (folder?: string) => ({ ...actual.useOpencodeChat(folder), sendMessage }),
  };
});

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(ui));
  return { container, unmount: () => act(async () => root.unmount()) };
}

describe("OpencodeChat variants", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null, activeFolderPath: null });
    useChatUIStore.setState({ connected: true, connecting: false, messages: [], loading: false, chatInput: "" });
    sendMessage.mockClear();
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

  async function typeAndSend(container: HTMLElement, text: string) {
    await act(async () => useChatUIStore.setState({ chatInput: text }));
    const btn = container.querySelector<HTMLButtonElement>(".oc-chat__send")!;
    await act(async () => btn.click());
  }

  it("macro variant sends with the build agent", async () => {
    const { container, unmount } = await render(<OpencodeChat variant="macro" header={null} />);
    await typeAndSend(container, "fix the macro");
    expect(sendMessage).toHaveBeenCalledWith("fix the macro", "build", undefined);
    await unmount();
  });

  it("panel variant leaves the agent to the selection", async () => {
    const { container, unmount } = await render(<OpencodeChat />);
    await typeAndSend(container, "hello");
    expect(sendMessage).toHaveBeenCalledWith("hello", undefined, undefined);
    await unmount();
  });

  it("onBeforeSend returning false cancels the send and keeps the input", async () => {
    const onBeforeSend = vi.fn().mockResolvedValue(false);
    const { container, unmount } = await render(<OpencodeChat variant="macro" onBeforeSend={onBeforeSend} />);
    await typeAndSend(container, "edit Module1");
    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(useChatUIStore.getState().chatInput).toBe("edit Module1");
    await unmount();
  });

  it("onBeforeSend returning true lets the message go out", async () => {
    const onBeforeSend = vi.fn().mockResolvedValue(true);
    const { container, unmount } = await render(<OpencodeChat variant="macro" onBeforeSend={onBeforeSend} />);
    await typeAndSend(container, "edit Module1");
    expect(sendMessage).toHaveBeenCalledWith("edit Module1", "build", undefined);
    expect(useChatUIStore.getState().chatInput).toBe("");
    await unmount();
  });
});

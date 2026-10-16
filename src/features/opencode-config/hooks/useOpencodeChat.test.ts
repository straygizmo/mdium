// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { doCreateNewSession, useChatUIStore, waitForConnection } from "./useOpencodeChat";

describe("doCreateNewSession", () => {
  it("clears a running turn's spinner and stall notice", async () => {
    useChatUIStore.setState({
      loading: true,
      stallNotice: true,
      currentSessionId: "ses_old",
      messages: [{ role: "user", content: "hi" }],
    });
    await doCreateNewSession();
    const s = useChatUIStore.getState();
    expect(s.loading).toBe(false);
    expect(s.stallNotice).toBe(false);
    expect(s.currentSessionId).toBeNull();
    expect(s.messages).toEqual([]);
  });
});

describe("waitForConnection", () => {
  it("keeps waiting while no client is connected, and resolves on abort", async () => {
    useChatUIStore.setState({ connected: true });
    const ac = new AbortController();
    let settled = false;
    const p = waitForConnection("C:/project", ac.signal).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    ac.abort();
    await p;
    expect(settled).toBe(true);
  });
});

// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { doCreateNewSession, doSendMessage, useChatUIStore, waitForConnection } from "./useOpencodeChat";
import { useMacroChatStore } from "@/stores/macro-chat-store";

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

describe("doSendMessage", () => {
  it("resets the run budget of the workbook bound to the current session before sending", async () => {
    useMacroChatStore.getState().setSession("C:/w/Book.xlsm", "ses_1");
    useChatUIStore.setState({ currentSessionId: "ses_1" });
    await doSendMessage("hi"); // no client connected: returns after the reset
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("reset_vba_run_budget", { xlsmPath: "c:/w/book.xlsm" });
  });

  it("keeps the run budget for the stall watchdog's automatic reply", async () => {
    useMacroChatStore.getState().setSession("C:/w/Book.xlsm", "ses_1");
    useChatUIStore.setState({ currentSessionId: "ses_1" });
    vi.mocked(invoke).mockClear();
    await doSendMessage("続けてください", undefined, undefined, { isAutoReply: true });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("reset_vba_run_budget", expect.anything());
  });
});

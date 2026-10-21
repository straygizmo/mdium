// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { TFunction } from "i18next";

const { invoke, showConfirm, listen, state } = vi.hoisted(() => {
  const state = {
    handler: null as null | ((e: { payload: unknown }) => void),
    unlisten: vi.fn(),
  };
  return {
    invoke: vi.fn(),
    showConfirm: vi.fn(),
    state,
    listen: vi.fn(async (_name: string, h: (e: { payload: unknown }) => void) => {
      state.handler = h;
      return state.unlisten;
    }),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@/stores/dialog-store", () => ({ showConfirm }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import {
  formatApprovalMessage,
  useVbaRunApproval,
  type VbaRunApprovalRequest,
} from "../useVbaRunApproval";

// Deterministic stub: renders the key plus the interpolation options.
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key} ${JSON.stringify(opts)}` : key) as unknown as TFunction<"editor">;

/** Minimal renderHook replacement (testing-library is not installed). */
function renderHook(hook: () => void) {
  function Probe() {
    hook();
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  return { unmount: () => act(() => root.unmount()) };
}

async function emit(payload: VbaRunApprovalRequest) {
  await Promise.resolve();
  state.handler!({ payload });
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.handler = null;
  invoke.mockResolvedValue(undefined);
});

describe("formatApprovalMessage", () => {
  it("formats the message with at most 20 match lines and a more-count", () => {
    const matches = Array.from({ length: 23 }, (_, i) => ({ module: "Module1", line: i + 1, text: `Kill ${i}` }));
    const msg = formatApprovalMessage({ id: "1", xlsmPath: "C:/w/Book.xlsm", macros: ["Module1.Main"], matches }, t);
    expect(msg).toContain("Book.xlsm");
    expect(msg).toContain("Module1.Main");
    expect(msg).toContain("Module1:20: Kill 19");
    expect(msg).not.toContain("Module1:21:");
    expect(msg).toContain("3");
  });

  it("handles backslash paths and joins macros with a comma", () => {
    const msg = formatApprovalMessage({ id: "1", xlsmPath: "C:\w\Book.xlsm", macros: ["A", "B"], matches: [] }, t);
    expect(msg).toContain("Book.xlsm");
    expect(msg).not.toContain("C:\\w");
    expect(msg).toContain("A, B");
  });
});

describe("useVbaRunApproval", () => {
  it("asks with showConfirm and replies granted=true", async () => {
    showConfirm.mockResolvedValue(true);
    renderHook(() => useVbaRunApproval());
    await emit({ id: "req1", xlsmPath: "C:/w/Book.xlsm", macros: ["Main"], matches: [] });
    expect(listen).toHaveBeenCalledWith("vba-run-approval-request", expect.any(Function));
    expect(showConfirm).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "warning", signal: expect.any(AbortSignal) }),
    );
    expect(invoke).toHaveBeenCalledWith("vba_run_approval_reply", { id: "req1", granted: true });
  });

  it("replies granted=false when the user declines", async () => {
    showConfirm.mockResolvedValue(false);
    renderHook(() => useVbaRunApproval());
    await emit({ id: "req2", xlsmPath: "C:/w/Book.xlsm", macros: ["Main"], matches: [] });
    expect(invoke).toHaveBeenCalledWith("vba_run_approval_reply", { id: "req2", granted: false });
  });

  it("does not throw when the reply invoke fails", async () => {
    showConfirm.mockResolvedValue(true);
    invoke.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    renderHook(() => useVbaRunApproval());
    await emit({ id: "req3", xlsmPath: "C:/w/Book.xlsm", macros: [], matches: [] });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("unlistens on unmount", async () => {
    const { unmount } = renderHook(() => useVbaRunApproval());
    await Promise.resolve();
    await Promise.resolve();
    unmount();
    await Promise.resolve();
    expect(state.unlisten).toHaveBeenCalledTimes(1);
  });
});

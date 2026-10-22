// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { resetVbaRunBudget, resetVbaRunBudgetForSession, workbookForSession } from "../vba-run-budget";
import { useMacroChatStore } from "@/stores/macro-chat-store";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
});

describe("vba-run-budget", () => {
  it("finds the workbook bound to a session", () => {
    expect(workbookForSession("ses_1", { "c:/w/book.xlsm": "ses_1", "c:/w/other.xlsm": "ses_2" })).toBe("c:/w/book.xlsm");
    expect(workbookForSession("ses_9", { "c:/w/book.xlsm": "ses_1" })).toBeNull();
    expect(workbookForSession(null, { "c:/w/book.xlsm": "ses_1" })).toBeNull();
  });

  it("resets through the tauri command and swallows errors", async () => {
    invoke.mockRejectedValueOnce(new Error("x"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resetVbaRunBudget("C:/w/Book.xlsm")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("reset_vba_run_budget", { xlsmPath: "C:/w/Book.xlsm" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("resetVbaRunBudgetForSession uses the macro chat store binding", async () => {
    useMacroChatStore.getState().setSession("C:/w/Book.xlsm", "ses_1");
    await resetVbaRunBudgetForSession("ses_1");
    expect(invoke).toHaveBeenCalledWith("reset_vba_run_budget", { xlsmPath: "c:/w/book.xlsm" });
  });

  it("resetVbaRunBudgetForSession is a no-op when no workbook is bound", async () => {
    await resetVbaRunBudgetForSession("ses_unbound");
    expect(invoke).not.toHaveBeenCalled();
  });
});

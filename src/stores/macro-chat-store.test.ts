// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { useMacroChatStore, workbookKey } from "./macro-chat-store";

describe("macro-chat-store", () => {
  beforeEach(() => {
    useMacroChatStore.setState({ sessionByWorkbook: {}, splitRatio: 50, lockedByWorkbook: {} });
  });

  it("normalizes workbook keys (separators and case)", () => {
    expect(workbookKey("C:\\Work\\Book.XLSM")).toBe("c:/work/book.xlsm");
  });

  it("stores and clears the session per workbook", () => {
    const s = useMacroChatStore.getState();
    s.setSession("C:/w/Book.xlsm", "ses_1");
    expect(useMacroChatStore.getState().getSession("c:\\w\\book.xlsm")).toBe("ses_1");
    s.setSession("C:/w/Book.xlsm", null);
    expect(useMacroChatStore.getState().getSession("C:/w/Book.xlsm")).toBeNull();
    expect(useMacroChatStore.getState().sessionByWorkbook).toEqual({});
  });

  it("tracks lock state per workbook without persisting it", () => {
    useMacroChatStore.getState().setLocked("C:/w/Book.xlsm", true);
    expect(useMacroChatStore.getState().isLocked("C:/w/Book.xlsm")).toBe(true);
    const persisted = useMacroChatStore.persist.getOptions().partialize!(useMacroChatStore.getState());
    expect(persisted).not.toHaveProperty("lockedByWorkbook");
    expect(persisted).toHaveProperty("sessionByWorkbook");
    expect(persisted).toHaveProperty("splitRatio");
  });

  it("clamps the split ratio to 20..80", () => {
    useMacroChatStore.getState().setSplitRatio(5);
    expect(useMacroChatStore.getState().splitRatio).toBe(20);
    useMacroChatStore.getState().setSplitRatio(95);
    expect(useMacroChatStore.getState().splitRatio).toBe(80);
  });
});

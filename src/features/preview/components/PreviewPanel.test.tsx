// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPanel } from "./PreviewPanel";
import { useTabStore, type Tab } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";
import { useMacroChatStore } from "@/stores/macro-chat-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), exists: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("./OfficePreview", () => ({ OfficePreview: () => null }));
vi.mock("./MacroChatPane", () => ({ MacroChatPane: () => <div data-testid="macro-chat" /> }));

const tab: Tab = {
  id: "xlsm-tab",
  filePath: "C:/project/book.xlsm",
  folderPath: "C:/project",
  fileName: "book.xlsm",
  content: "",
  dirty: false,
  undoStack: [],
  redoStack: [],
  binaryData: new Uint8Array([1]),
  officeFileType: ".xlsm",
};

describe("PreviewPanel macro buttons", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_workbook_lock") return { locked: false, reason: null };
      if (cmd === "push_vba_modules") return { xlsmPath: tab.filePath, backupPath: "b", updated: ["Module1"], unchanged: [], added: ["Helpers"], removed: [], skipped: [] };
      if (cmd === "read_binary_file") return [1];
      return null;
    });
    useTabStore.setState({ tabs: [tab], activeTabId: tab.id, activeFolderPath: tab.folderPath });
    useUiStore.setState({ activeViewTab: "preview" });
    useMacroChatStore.setState({ splitRatio: 50, lockedByWorkbook: {} });
  });

  afterEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null, activeFolderPath: null });
  });

  it("shows no LLM toggle and pushes with the workbook path only", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<PreviewPanel previewRef={{ current: null }} />));
    expect(container.querySelector('[role="switch"]')).toBeNull();

    const buttons = [...container.querySelectorAll(".preview-panel__convert-bar button")];
    const importBtn = buttons.find((b) => b.textContent?.includes("取り込み") || b.textContent?.includes("Load"))!;
    expect(importBtn).toBeDefined();
    await act(async () => {
      (importBtn as HTMLButtonElement).click();
      // Let the awaited invoke chain inside the handler settle.
      await new Promise((r) => setTimeout(r, 0));
    });

    const pushCall = invoke.mock.calls.find((c) => c[0] === "push_vba_modules")!;
    expect(pushCall[1]).toEqual({ xlsmPath: tab.filePath });
    expect(container.querySelector(".preview-panel__convert-success")?.textContent).toContain("1");
    await act(async () => root.unmount());
  });

  it("splits an xlsm tab into sheet preview and macro chat", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<PreviewPanel previewRef={{ current: null }} />));
    expect(container.querySelector(".preview-panel__macro-split")).not.toBeNull();
    expect(container.querySelector('[data-testid="macro-chat"]')).not.toBeNull();
    const left = container.querySelector<HTMLElement>(".preview-panel__macro-left")!;
    expect(left.style.flexBasis).toBe("50%");
    await act(async () => root.unmount());
  });

  it("does not split a plain xlsx tab", async () => {
    useTabStore.setState({ tabs: [{ ...tab, id: "x", filePath: "C:/project/plain.xlsx", fileName: "plain.xlsx", officeFileType: ".xlsx" }], activeTabId: "x" });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<PreviewPanel previewRef={{ current: null }} />));
    expect(container.querySelector(".preview-panel__macro-split")).toBeNull();
    expect(container.querySelector('[data-testid="macro-chat"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("disables the import button while Excel holds the workbook", async () => {
    useMacroChatStore.getState().setLocked(tab.filePath, true);
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<PreviewPanel previewRef={{ current: null }} />));
    // Let the dynamic fs import and macros-dir existence check settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".preview-panel__convert-bar button")];
    const importBtn = buttons.find((b) => b.textContent?.includes("取り込み") || b.textContent?.includes("Load"))!;
    expect(importBtn.disabled).toBe(true);
    expect(importBtn.title.length).toBeGreaterThan(0);
    await act(async () => root.unmount());
    useMacroChatStore.getState().setLocked(tab.filePath, false);
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPanel } from "./PreviewPanel";
import { useSettingsStore } from "@/stores/settings-store";
import { useTabStore, type Tab } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(false) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), exists: vi.fn().mockResolvedValue(false) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("./OfficePreview", () => ({ OfficePreview: () => null }));

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

describe("PreviewPanel VBA import switch", () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [tab], activeTabId: tab.id, activeFolderPath: tab.folderPath });
    useUiStore.setState({ activeViewTab: "preview" });
    useSettingsStore.setState({ allowLlmVbaImport: false });
  });

  afterEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null, activeFolderPath: null });
    useSettingsStore.setState({ allowLlmVbaImport: false });
  });

  it("toggles once per click, Enter, and Space", async () => {
    const original = useSettingsStore.getState().setAllowLlmVbaImport;
    const setAllowLlmVbaImport = vi.fn(original);
    useSettingsStore.setState({ setAllowLlmVbaImport });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<PreviewPanel previewRef={{ current: null }} />));
    const getSwitch = () => container.querySelector<HTMLElement>('[role="switch"]')!;
    const expectState = (enabled: boolean) => {
      expect(getSwitch().getAttribute("aria-checked")).toBe(String(enabled));
      expect(getSwitch().classList.contains("preview-panel__switch--on")).toBe(enabled);
    };

    expect(getSwitch().hasAttribute("data-switch")).toBe(true);
    expect(getSwitch().getAttribute("aria-label")).toBeTruthy();
    expect(getSwitch().querySelector("[data-switch-thumb]")).not.toBeNull();
    expectState(false);

    await act(async () => getSwitch().click());
    expect(setAllowLlmVbaImport).toHaveBeenCalledTimes(1);
    expectState(true);

    await act(async () => getSwitch().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(setAllowLlmVbaImport).toHaveBeenCalledTimes(2);
    expectState(false);

    await act(async () => getSwitch().dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(setAllowLlmVbaImport).toHaveBeenCalledTimes(3);
    expectState(true);

    await act(async () => root.unmount());
  });
});

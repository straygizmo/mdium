// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../FileTree", () => ({ FileTree: () => <div data-testid="file-tree" /> }));
vi.mock("../OutlinePanel", () => ({ OutlinePanel: () => <div data-testid="outline" /> }));
vi.mock("@/features/rag/components/RagPanel", () => ({ RagPanel: () => <div data-testid="rag" /> }));
vi.mock("@/features/agent-chat/components/AgentChatPanel", () => ({
  AgentChatPanel: () => <div data-testid="agent-chat" />,
}));
vi.mock("@/features/git/components/GitPanel", () => ({ GitPanel: () => <div data-testid="git" /> }));
vi.mock("@/features/replacement/components/ReplacementPanel", () => ({
  ReplacementPanel: () => <div data-testid="replacement" />,
}));
vi.mock("@/features/export/components/BatchConvertModal", () => ({ BatchConvertModal: () => null }));
vi.mock("@/features/workflow/components/WorkflowPanel", () => ({
  WorkflowPanel: () => <div data-testid="workflow-panel" />,
}));

import { useTabStore } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";
import { LeftPanel, type FileFilterProps } from "../LeftPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
const filterProps: FileFilterProps = {
  showAll: true,
  activateShowAll: noop,
  filterDocx: false,
  filterXls: false,
  filterPptx: false,
  filterKm: false,
  filterImages: false,
  filterPdf: false,
  toggleFilterDocx: noop,
  toggleFilterXls: noop,
  toggleFilterPptx: noop,
  toggleFilterKm: noop,
  toggleFilterImages: noop,
  toggleFilterPdf: noop,
  showDocxBtn: false,
  showXlsBtn: false,
  showPptxBtn: false,
  showKmBtn: false,
  showPdfBtn: false,
};

describe("LeftPanel workflow entry", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useTabStore.setState({ activeFolderPath: "C:/w", folderLeftPanel: {} });
    useUiStore.setState({ leftPanel: "folder" });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useTabStore.setState({ activeFolderPath: null, folderLeftPanel: {} });
    useUiStore.setState({ leftPanel: "folder" });
  });

  it("switches to the workflows panel from its activity button", async () => {
    await act(async () =>
      root.render(
        <LeftPanel
          {...filterProps}
          onFileSelect={noop}
          onRefresh={noop}
          onNewFile={noop}
          onNewFolder={noop}
          previewRef={{ current: null }}
        />,
      ),
    );
    const title = i18n.t("title", { ns: "workflow" });
    const button = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
    expect(button).not.toBeNull();
    expect(container.querySelector('[data-testid="workflow-panel"]')).toBeNull();

    await act(async () => button!.click());

    expect(useUiStore.getState().leftPanel).toBe("workflow");
    expect(useTabStore.getState().folderLeftPanel["C:/w"]).toBe("workflow");
    expect(button!.className).toContain("left-panel__activity-btn--active");
    expect(container.querySelector('[data-testid="workflow-panel"]')).not.toBeNull();
    expect(container.querySelector(".left-panel__section-header-title")?.textContent).toBe(title);
  });
});

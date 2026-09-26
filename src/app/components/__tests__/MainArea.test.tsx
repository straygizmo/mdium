// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";

vi.mock("@/features/workflow/components/Workspace", () => ({
  Workspace: () => <div data-testid="workspace" />,
}));

import { useTabStore } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";
import { MainArea } from "../MainArea";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MainArea", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useUiStore.setState({ leftPanel: "folder" });
    useTabStore.setState({ activeFolderPath: "C:/w" });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useUiStore.setState({ leftPanel: "folder" });
    useTabStore.setState({ activeFolderPath: null });
  });

  it("shows the workspace for the workflows panel and keeps the editor mounted", async () => {
    await act(async () =>
      root.render(
        <MainArea>
          <div data-testid="editor" />
        </MainArea>,
      ),
    );
    const editor = container.querySelector<HTMLElement>('[data-testid="editor"]');
    const content = container.querySelector<HTMLElement>(".app__main-content");
    expect(editor).not.toBeNull();
    expect(content!.style.display).toBe("contents");
    expect(container.querySelector('[data-testid="workspace"]')).toBeNull();

    await act(async () => useUiStore.setState({ leftPanel: "workflow" }));
    expect(container.querySelector('[data-testid="workspace"]')).not.toBeNull();
    // The editor stays in the tree, only hidden.
    expect(container.querySelector('[data-testid="editor"]')).toBe(editor);
    expect(content!.style.display).toBe("none");

    const onResize = vi.fn();
    window.addEventListener("resize", onResize);
    await act(async () => useUiStore.setState({ leftPanel: "git" }));
    window.removeEventListener("resize", onResize);
    expect(container.querySelector('[data-testid="workspace"]')).toBeNull();
    expect(container.querySelector('[data-testid="editor"]')).toBe(editor);
    expect(content!.style.display).toBe("contents");
    // Content hidden at zero size gets a chance to relayout.
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it("keeps the welcome content when no folder is open", async () => {
    useTabStore.setState({ activeFolderPath: null });
    useUiStore.setState({ leftPanel: "workflow" });
    await act(async () =>
      root.render(
        <MainArea>
          <div data-testid="welcome" />
        </MainArea>,
      ),
    );
    expect(container.querySelector('[data-testid="workspace"]')).toBeNull();
    expect(container.querySelector<HTMLElement>(".app__main-content")!.style.display).toBe("contents");
    expect(container.querySelector('[data-testid="welcome"]')).not.toBeNull();
  });
});

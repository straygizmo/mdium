// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";

vi.mock("@/features/workflow/components/Workspace", () => ({
  Workspace: () => <div data-testid="workspace" />,
}));

import { useUiStore } from "@/stores/ui-store";
import { MainArea } from "../MainArea";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MainArea", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useUiStore.setState({ leftPanel: "folder" });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useUiStore.setState({ leftPanel: "folder" });
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

    await act(async () => useUiStore.setState({ leftPanel: "git" }));
    expect(container.querySelector('[data-testid="workspace"]')).toBeNull();
    expect(container.querySelector('[data-testid="editor"]')).toBe(editor);
    expect(content!.style.display).toBe("contents");
  });
});

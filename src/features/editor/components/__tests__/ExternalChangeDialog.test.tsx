// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/shared/i18n";
import { ExternalChangeDialog } from "../ExternalChangeDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ExternalChangeDialog", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
  });

  it("shows the diff through the unified diff view", async () => {
    const container = document.createElement("div");
    root = createRoot(container);
    const noop = () => {};
    await act(async () => {
      root?.render(
        <ExternalChangeDialog
          filePath="C:/docs/note.md"
          currentContent={"a\nold\nc\n"}
          externalContent={"a\nnew\nc\n"}
          onAcceptExternal={noop}
          onKeepCurrent={noop}
          onClose={noop}
        />,
      );
    });
    expect(container.querySelector(".unified-diff")).toBeNull();

    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === i18n.t("editor:externalChangeShowDiff"),
    );
    await act(async () => { toggle?.click(); });

    const removed = container.querySelectorAll(".unified-diff__line--removed");
    const added = container.querySelectorAll(".unified-diff__line--added");
    expect(Array.from(removed).map((l) => l.textContent)).toEqual(["-old"]);
    expect(Array.from(added).map((l) => l.textContent)).toEqual(["+new"]);
    expect(container.querySelector(".unified-diff__line--header")?.textContent).toMatch(/^@@ /);
  });
});

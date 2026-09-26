// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/shared/i18n";
import { UnifiedDiffView } from "./UnifiedDiffView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("UnifiedDiffView", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;

  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
  });

  async function render(diff: string, maxLines?: number) {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(<UnifiedDiffView diff={diff} maxLines={maxLines} />);
    });
  }

  function lineClass(el: Element): string {
    return Array.from(el.classList).find((c) => c.startsWith("unified-diff__line--")) ?? "";
  }

  it("classifies each line by its kind", async () => {
    const diff = [
      "diff --git a/f b/f",
      "index 1234..5678 100644",
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,2 @@",
      " same",
      "-old",
      "+new",
      "--- removed sql comment",
      "+++ added marker",
    ].join("\n");
    await render(diff);

    const lines = Array.from(container.querySelectorAll(".unified-diff__line"));
    expect(lines.map((l) => l.textContent)).toEqual(diff.split("\n"));
    expect(lines.map(lineClass)).toEqual([
      "unified-diff__line--meta",
      "unified-diff__line--meta",
      "unified-diff__line--meta",
      "unified-diff__line--meta",
      "unified-diff__line--header",
      "unified-diff__line--context",
      "unified-diff__line--removed",
      "unified-diff__line--added",
      "unified-diff__line--removed",
      "unified-diff__line--added",
    ]);
    expect(container.querySelector(".unified-diff__truncated")).toBeNull();
  });

  it("caps rendered lines and shows a truncation note", async () => {
    const diff = Array.from({ length: 12 }, (_, i) => `+line ${i}`).join("\n");
    await render(diff, 5);

    expect(container.querySelectorAll(".unified-diff__line")).toHaveLength(5);
    const note = container.querySelector(".unified-diff__truncated");
    expect(note?.textContent).toBe(i18n.t("common:truncatedLines", { count: 7 }));
    expect(note?.textContent).toContain("7");
  });
});

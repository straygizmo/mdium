import { describe, it, expect } from "vitest";
import { layoutToStructure, structureToLayout } from "../xmind-structure";

describe("layout <-> structureClass mapping", () => {
  const cases: Array<[string, string]> = [
    ["right", "org.xmind.ui.logic.right"],
    ["left", "org.xmind.ui.logic.left"],
    ["mind", "org.xmind.ui.map.unbalanced"],
    ["bottom", "org.xmind.ui.org-chart.down"],
    ["filetree", "org.xmind.ui.tree.right"],
  ];

  it.each(cases)("layout %s -> structureClass %s", (layout, structure) => {
    expect(layoutToStructure(layout)).toBe(structure);
  });

  it.each(cases)("structureClass %s -> layout %s (reverse)", (layout, structure) => {
    expect(structureToLayout(structure)).toBe(layout);
  });

  it("maps map.clockwise/unbalanced family to mind", () => {
    expect(structureToLayout("org.xmind.ui.map.clockwise")).toBe("mind");
    expect(structureToLayout("org.xmind.ui.map")).toBe("mind");
  });

  it("maps org-chart.up to bottom and tree.left to filetree", () => {
    expect(structureToLayout("org.xmind.ui.org-chart.up")).toBe("bottom");
    expect(structureToLayout("org.xmind.ui.tree.left")).toBe("filetree");
  });

  it("falls back to right for unknown / undefined", () => {
    expect(structureToLayout("org.xmind.ui.unknown.thing")).toBe("right");
    expect(structureToLayout(undefined)).toBe("right");
    expect(structureToLayout("")).toBe("right");
  });

  it("falls back to logic.right for unknown layout", () => {
    expect(layoutToStructure("nonsense")).toBe("org.xmind.ui.logic.right");
  });
});

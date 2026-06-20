// @vitest-environment node
import { describe, it, expect } from "vitest";
import { collectConvertibleFiles, buildConvertibleTree, pruneTreeByFilter } from "../collectConvertibleFiles";
import type { FileEntry } from "@/shared/types";

const tree: FileEntry[] = [
  { name: "deck.pptx", path: "/r/deck.pptx", is_dir: false } as FileEntry,
  { name: "doc.docx", path: "/r/doc.docx", is_dir: false } as FileEntry,
];

describe("collectConvertibleFiles: pptx", () => {
  it("detects .pptx as type pptx", () => {
    const files = collectConvertibleFiles(tree);
    expect(files.find((f) => f.name === "deck.pptx")?.type).toBe("pptx");
  });

  it("filters the convertible tree by pptx", () => {
    const built = buildConvertibleTree(tree);
    const pruned = pruneTreeByFilter(built, "pptx");
    expect(pruned).toHaveLength(1);
    expect(pruned[0].name).toBe("deck.pptx");
  });
});

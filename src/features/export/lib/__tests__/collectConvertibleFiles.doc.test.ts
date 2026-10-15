// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  collectConvertibleFiles,
  buildConvertibleTree,
  pruneTreeByFilter,
  pruneTreeByDoc,
} from "../collectConvertibleFiles";
import type { FileEntry } from "@/shared/types";

const tree: FileEntry[] = [
  {
    name: "sub",
    path: "/r/sub",
    is_dir: true,
    children: [
      { name: "legacy.doc", path: "/r/sub/legacy.doc", is_dir: false } as FileEntry,
      { name: "legacy.md", path: "/r/sub/legacy.md", is_dir: false } as FileEntry,
    ],
  } as FileEntry,
  { name: "old.DOC", path: "/r/old.DOC", is_dir: false } as FileEntry,
  { name: "doc.docx", path: "/r/doc.docx", is_dir: false } as FileEntry,
  { name: "deck.pptx", path: "/r/deck.pptx", is_dir: false } as FileEntry,
];

describe("collectConvertibleFiles: doc", () => {
  it("detects .doc (case-insensitive) as type doc", () => {
    const files = collectConvertibleFiles(tree);
    expect(files.find((f) => f.name === "old.DOC")?.type).toBe("doc");
    expect(files.find((f) => f.name === "legacy.doc")?.type).toBe("doc");
  });

  it("does not mistake .docx for .doc", () => {
    const files = collectConvertibleFiles(tree);
    expect(files.find((f) => f.name === "doc.docx")?.type).toBe("docx");
  });

  it("detects a sibling .md for a .doc", () => {
    const files = collectConvertibleFiles(tree);
    expect(files.find((f) => f.name === "legacy.doc")?.hasExistingMdSibling).toBe(true);
    expect(files.find((f) => f.name === "old.DOC")?.hasExistingMdSibling).toBe(false);
  });

  it("includes .doc under the docx filter tab", () => {
    const built = buildConvertibleTree(tree);
    const pruned = pruneTreeByFilter(built, "docx");
    const names = pruned.flatMap((n) => (n.isDir ? n.children!.map((c) => c.name) : [n.name]));
    expect(names).toEqual(["legacy.doc", "old.DOC", "doc.docx"]);
  });
});

describe("pruneTreeByDoc", () => {
  it("removes .doc files and emptied folders when includeDoc is false", () => {
    const built = buildConvertibleTree(tree);
    const pruned = pruneTreeByDoc(built, false);
    expect(pruned.map((n) => n.name)).toEqual(["doc.docx", "deck.pptx"]);
  });

  it("returns the tree unchanged when includeDoc is true", () => {
    const built = buildConvertibleTree(tree);
    expect(pruneTreeByDoc(built, true)).toBe(built);
  });
});

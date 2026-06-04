// @vitest-environment node
import { describe, it, expect } from "vitest";
import { pruneTreeByHasMd } from "../collectConvertibleFiles";
import type { ConvertibleTreeNode } from "../collectConvertibleFiles";

const tree: ConvertibleTreeNode[] = [
  {
    name: "sub",
    path: "/r/sub",
    isDir: true,
    children: [
      { name: "a.docx", path: "/r/sub/a.docx", isDir: false, children: null, fileType: "docx", hasExistingMdSibling: true, hasExistingMdInMdium: false },
      { name: "b.pdf", path: "/r/sub/b.pdf", isDir: false, children: null, fileType: "pdf", hasExistingMdSibling: false, hasExistingMdInMdium: true },
    ],
  },
  { name: "c.xlsx", path: "/r/c.xlsx", isDir: false, children: null, fileType: "xlsx", hasExistingMdSibling: false, hasExistingMdInMdium: false },
];

describe("pruneTreeByHasMd", () => {
  it("keeps only sibling-md files when inMdium=false", () => {
    const r = pruneTreeByHasMd(tree, false);
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("sub");
    expect(r[0].children).toHaveLength(1);
    expect(r[0].children![0].name).toBe("a.docx");
  });

  it("keeps only mdium-md files when inMdium=true", () => {
    const r = pruneTreeByHasMd(tree, true);
    expect(r).toHaveLength(1);
    expect(r[0].children).toHaveLength(1);
    expect(r[0].children![0].name).toBe("b.pdf");
  });

  it("drops folders with no matching descendants", () => {
    const r = pruneTreeByHasMd([
      {
        name: "x", path: "/x", isDir: true, children: [
          { name: "c.xlsx", path: "/x/c.xlsx", isDir: false, children: null, fileType: "xlsx", hasExistingMdSibling: false, hasExistingMdInMdium: false },
        ],
      },
    ], false);
    expect(r).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import type { FileEntry } from "@/shared/types";
import { expandedDirPaths, isRemotePath, replaceDirChildren } from "../remote-path";

const root = "ftp://me@example.com:21";

function dir(path: string, children: FileEntry[] | null): FileEntry {
  return { name: path.split("/").pop() ?? "", path, is_dir: true, children };
}

function file(path: string): FileEntry {
  return { name: path.split("/").pop() ?? "", path, is_dir: false, children: null };
}

describe("isRemotePath", () => {
  it("detects ftp URIs only", () => {
    expect(isRemotePath(`${root}/a.md`)).toBe(true);
    expect(isRemotePath("C:\\docs\\a.md")).toBe(false);
    expect(isRemotePath("/home/me/ftp/a.md")).toBe(false);
    expect(isRemotePath(null)).toBe(false);
  });
});

describe("expandedDirPaths", () => {
  it("keeps only expanded directories", () => {
    expect(expandedDirPaths({ [`${root}/a`]: true, [`${root}/b`]: false })).toEqual([`${root}/a`]);
    expect(expandedDirPaths(undefined)).toEqual([]);
  });
});

describe("replaceDirChildren", () => {
  it("fills a nested directory that was not loaded yet", () => {
    const tree = [dir(`${root}/a`, [dir(`${root}/a/b`, null)]), file(`${root}/x.md`)];
    const loaded = [file(`${root}/a/b/c.md`)];
    const next = replaceDirChildren(tree, `${root}/a/b`, loaded);
    expect(next[0].children?.[0].children).toEqual(loaded);
    expect(next[1]).toBe(tree[1]);
    // The original tree is left untouched.
    expect(tree[0].children?.[0].children).toBeNull();
  });

  it("does not descend into siblings sharing a name prefix", () => {
    const tree = [dir(`${root}/a`, []), dir(`${root}/ab`, null)];
    const next = replaceDirChildren(tree, `${root}/ab`, [file(`${root}/ab/z.md`)]);
    expect(next[0]).toBe(tree[0]);
    expect(next[1].children).toHaveLength(1);
  });
});

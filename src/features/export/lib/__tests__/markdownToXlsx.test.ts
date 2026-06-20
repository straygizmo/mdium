// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri fs plugin before importing the module under test.
const readFileMock = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

import {
  collectRelativeImagePaths,
  markdownToXlsx,
} from "../markdownToXlsx";

describe("collectRelativeImagePaths", () => {
  it("returns only relative image paths, excluding remote and data URIs", () => {
    const md = [
      "![a](images/a.png)",
      "![b](https://example.com/b.png)",
      "![c](http://example.com/c.png)",
      "![d](data:image/png;base64,XXXX)",
      "![e](./sub/e.jpg)",
    ].join("\n\n");
    expect(collectRelativeImagePaths(md)).toEqual(["images/a.png", "./sub/e.jpg"]);
  });

  it("deduplicates repeated paths", () => {
    const md = "![a](x.png)\n\n![a again](x.png)";
    expect(collectRelativeImagePaths(md)).toEqual(["x.png"]);
  });
});

describe("markdownToXlsx", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("returns ZIP-signature bytes for a simple document", async () => {
    const bytes = await markdownToXlsx("# Title\n\ntext\n");
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("resolves relative images against the file's directory", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await markdownToXlsx("![a](img/a.png)", { filePath: "/docs/note.md" });
    expect(readFileMock).toHaveBeenCalledWith("/docs/img/a.png");
  });

  it("skips images that cannot be read without throwing", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    const bytes = await markdownToXlsx("![a](missing.png)", { filePath: "/docs/note.md" });
    expect(bytes[0]).toBe(0x50);
  });

  it("does not read files when there is no filePath", async () => {
    await markdownToXlsx("![a](img/a.png)");
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("resolves images against current dir when filePath has no directory", async () => {
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await markdownToXlsx("![a](img/a.png)", { filePath: "note.md" });
    expect(readFileMock).toHaveBeenCalledWith("./img/a.png");
  });
});

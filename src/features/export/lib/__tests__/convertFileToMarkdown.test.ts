// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const docxToMarkdown = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../docxToMarkdown", () => ({ docxToMarkdown }));

import { convertFileToMarkdown, WordUnavailableError } from "../convertFileToMarkdown";
import type { ConvertibleFile } from "../collectConvertibleFiles";

const labels = { slideFallback: (n: number) => `Slide ${n}`, notes: "Notes" };

function file(name: string, type: ConvertibleFile["type"]): ConvertibleFile {
  return {
    name,
    path: `C:\\docs\\${name}`,
    type,
    hasExistingMdSibling: false,
    hasExistingMdInMdium: false,
  };
}

beforeEach(() => {
  invoke.mockReset();
  docxToMarkdown.mockReset();
  docxToMarkdown.mockResolvedValue({ mdPath: "C:\\docs\\out.md" });
});

describe("convertFileToMarkdown: doc", () => {
  it("converts .doc through Word first, then feeds the produced .docx to the docx converter", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "convert_doc_to_docx") return "C:\\docs\\legacy.docx";
      if (cmd === "read_binary_file") return [1, 2, 3];
      throw new Error(`unexpected command ${cmd}`);
    });

    const result = await convertFileToMarkdown(file("legacy.doc", "doc"), false, labels);

    expect(invoke).toHaveBeenCalledWith("convert_doc_to_docx", { path: "C:\\docs\\legacy.doc" });
    expect(invoke).toHaveBeenCalledWith("read_binary_file", { path: "C:\\docs\\legacy.docx" });
    expect(docxToMarkdown).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "C:\\docs\\legacy.docx", false);
    expect(result).toEqual({ mdPath: "C:\\docs\\out.md" });
  });

  it("surfaces the Word conversion error without touching the docx converter", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "convert_doc_to_docx") throw "Word automation failed: file is locked";
      return [];
    });

    await expect(convertFileToMarkdown(file("legacy.doc", "doc"), false, labels)).rejects.toThrow(
      "Word automation failed: file is locked"
    );
    expect(docxToMarkdown).not.toHaveBeenCalled();
  });

  it("maps the desktop side's WORD_NOT_AVAILABLE marker to a typed error", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "convert_doc_to_docx") throw "WORD_NOT_AVAILABLE: Word.Application could not be created";
      return [];
    });

    await expect(convertFileToMarkdown(file("legacy.doc", "doc"), false, labels)).rejects.toBeInstanceOf(
      WordUnavailableError
    );
  });
});

describe("convertFileToMarkdown: docx", () => {
  it("does not call Word for a .docx", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_binary_file") return [9];
      throw new Error(`unexpected command ${cmd}`);
    });

    const result = await convertFileToMarkdown(file("modern.docx", "docx"), true, labels);

    expect(invoke.mock.calls.map(([c]) => c)).toEqual(["read_binary_file"]);
    expect(docxToMarkdown).toHaveBeenCalledWith(new Uint8Array([9]), "C:\\docs\\modern.docx", true);
    expect(result).toEqual({ mdPath: "C:\\docs\\out.md" });
  });
});

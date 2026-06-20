// @vitest-environment node
import { describe, it, expect } from "vitest";
import { getCsvExt, getMindmapExt, getKityMinderImportExt, isCodeFile, getPptxExt } from "../constants";

describe("getCsvExt", () => {
  it("returns .csv for .csv", () => expect(getCsvExt("data.csv")).toBe(".csv"));
  it("returns .tsv for .tsv", () => expect(getCsvExt("data.tsv")).toBe(".tsv"));
  it("is case-insensitive", () => expect(getCsvExt("DATA.CSV")).toBe(".csv"));
  it("returns null for other", () => expect(getCsvExt("x.txt")).toBeNull());
  it("returns null for no extension", () => expect(getCsvExt("README")).toBeNull());
});

describe("isCodeFile", () => {
  it("returns false for .csv", () => expect(isCodeFile("x.csv")).toBe(false));
  it("returns false for .tsv", () => expect(isCodeFile("x.tsv")).toBe(false));
  it("returns false for .md", () => expect(isCodeFile("x.md")).toBe(false));
  it("returns true for .ts", () => expect(isCodeFile("x.ts")).toBe(true));
});

describe("mindmap extension detection after .xmind migration", () => {
  it("treats .xmind as the mindmap extension", () => {
    expect(getMindmapExt("a.xmind")).toBe(".xmind");
  });
  it("no longer treats .km as an editable mindmap extension", () => {
    expect(getMindmapExt("a.km")).toBeNull();
  });
  it("detects .km as a KityMinder import source", () => {
    expect(getKityMinderImportExt("a.km")).toBe(".km");
    expect(getKityMinderImportExt("a.xmind")).toBeNull();
  });
  it("is case-insensitive for import detection", () => {
    expect(getKityMinderImportExt("A.KM")).toBe(".km");
  });
  it("does not treat .km or .xmind as code files", () => {
    expect(isCodeFile("a.xmind")).toBe(false);
    expect(isCodeFile("a.km")).toBe(false);
  });
});

describe("getPptxExt", () => {
  it("matches .pptx case-insensitively", () => {
    expect(getPptxExt("/a/Deck.PPTX")).toBe(".pptx");
    expect(getPptxExt("/a/deck.pptx")).toBe(".pptx");
  });
  it("returns null for non-pptx", () => {
    expect(getPptxExt("/a/deck.docx")).toBeNull();
    expect(getPptxExt("/a/deck.md")).toBeNull();
  });
});

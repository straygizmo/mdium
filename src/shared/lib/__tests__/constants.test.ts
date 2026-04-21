// @vitest-environment node
import { describe, it, expect } from "vitest";
import { getCsvExt, isCodeFile } from "../constants";

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

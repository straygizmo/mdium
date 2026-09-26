import { describe, expect, it, vi } from "vitest";
import { isCommandError, sameRoot } from "../errors";

describe("workflow errors helpers", () => {
  describe("isCommandError", () => {
    it("accepts objects with string code and message", () => {
      expect(isCommandError({ code: "X", message: "" })).toBe(true);
      expect(isCommandError({ code: "X" })).toBe(false);
      expect(isCommandError(new Error("x"))).toBe(false);
      expect(isCommandError(null)).toBe(false);
      expect(isCommandError("X")).toBe(false);
    });
  });

  describe("sameRoot", () => {
    it("matches identical roots", () => {
      expect(sameRoot("C:/repo", "C:/repo")).toBe(true);
      expect(sameRoot("/a/b", "/a/c")).toBe(false);
    });

    it("compares case-insensitively only on Windows", () => {
      try {
        vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
        expect(sameRoot("C:/Repo", "c:/repo")).toBe(true);
        vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
        expect(sameRoot("/home/Repo", "/home/repo")).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

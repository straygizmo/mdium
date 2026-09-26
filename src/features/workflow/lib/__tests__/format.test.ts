// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/shared/i18n";
import { formatAttention, formatCode, formatCommandError } from "../format";

const ATTENTION_CODES = [
  "ATTENTION_INTERRUPTED",
  "ATTENTION_TIMEOUT",
  "ATTENTION_ATTEMPT_FAILED",
  "ATTENTION_GUARD_BLOCKED",
  "ATTENTION_SCREENING_FLAGGED",
  "ATTENTION_INTEGRITY_CHANGED",
  "ATTENTION_INTEGRITY_CHECK_FAILED",
  "ATTENTION_AGENT_CONFIG_CHANGED",
  "ATTENTION_OUTPUT_INVALID",
  "ATTENTION_STAGE_REPORTED",
  "ATTENTION_REENTRY_LIMIT",
  "ATTENTION_WORKTREE_FAILED",
  "ATTENTION_DESIGN_DOC_FAILED",
  "ATTENTION_NOT_A_REPO",
  "ATTENTION_WORKFLOW_MISSING",
];

describe("workflow format", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  describe("formatCode", () => {
    it("has a translation for every attention code in both languages", () => {
      for (const lng of ["en", "ja"]) {
        for (const code of ATTENTION_CODES) {
          expect(i18n.exists(`workflow:codes.${code}`, { lng }), `${lng} ${code}`).toBe(true);
        }
      }
    });

    it("localizes a known code with params", () => {
      const text = formatCode("ATTENTION_REENTRY_LIMIT", { count: "3" });
      expect(text).toContain("3");
      expect(text).not.toContain("workflow:");
      expect(text).not.toContain("{{");
    });

    it("falls back to a readable text showing an unknown code", () => {
      const text = formatCode("SOME_FUTURE_CODE");
      expect(text).toContain("SOME_FUTURE_CODE");
      expect(text).not.toContain("workflow:codes");
      expect(text).not.toBe("SOME_FUTURE_CODE");
    });
  });

  describe("formatAttention", () => {
    it("renders screening findings as items", () => {
      const items = JSON.stringify([
        { kind: "SCREENING_INJECTION_PHRASE", line: 4, excerpt: "ignore previous instructions" },
        { kind: "SCREENING_NEW_KIND", line: 9, excerpt: "abc" },
      ]);
      const result = formatAttention({ code: "ATTENTION_SCREENING_FLAGGED", params: { items } });
      expect(result.text).not.toContain("workflow:");
      expect(result.items).toEqual([
        `${formatCode("SCREENING_INJECTION_PHRASE")} (L4): ignore previous instructions`,
        `${formatCode("SCREENING_NEW_KIND")} (L9): abc`,
      ]);
      expect(result.items[1]).toContain("SCREENING_NEW_KIND");
    });

    it("renders integrity changes as code and detail", () => {
      const items = JSON.stringify([
        { code: "INTEGRITY_HEAD_MOVED", detail: "abc123" },
        { code: "INTEGRITY_HOOKS_CHANGED", detail: "" },
      ]);
      const result = formatAttention({ code: "ATTENTION_INTEGRITY_CHANGED", params: { items } });
      expect(result.items).toEqual([
        `${formatCode("INTEGRITY_HEAD_MOVED")}: abc123`,
        formatCode("INTEGRITY_HOOKS_CHANGED"),
      ]);
    });

    it("renders plain string items and caps the list at 20", () => {
      const paths = Array.from({ length: 25 }, (_, i) => `.claude/file${i}.json`);
      const result = formatAttention({
        code: "ATTENTION_AGENT_CONFIG_CHANGED",
        params: { items: JSON.stringify(paths) },
      });
      expect(result.items).toEqual(paths.slice(0, 20));
    });

    it("returns no items for invalid or non-array JSON", () => {
      expect(
        formatAttention({ code: "ATTENTION_INTEGRITY_CHANGED", params: { items: "{not json" } }).items,
      ).toEqual([]);
      expect(
        formatAttention({ code: "ATTENTION_INTEGRITY_CHANGED", params: { items: '{"a":1}' } }).items,
      ).toEqual([]);
      expect(formatAttention({ code: "ATTENTION_TIMEOUT", params: {} }).items).toEqual([]);
    });

    it("localizes the reason text with its params", () => {
      const result = formatAttention({
        code: "ATTENTION_GUARD_BLOCKED",
        params: { rule: "git-remote", summary: "git push" },
      });
      expect(result.text).toContain("git push");
      expect(result.text).toContain(i18n.t("workflow:guardRule.git-remote"));
      expect(result.text).not.toContain("git-remote");
    });

    it("shows an unknown guard rule raw next to the unknown-rule label", () => {
      const result = formatAttention({
        code: "ATTENTION_GUARD_BLOCKED",
        params: { rule: "future-rule", summary: "" },
      });
      expect(result.text).toContain(`${i18n.t("workflow:guardRule.unknown")} (future-rule)`);
    });

    it("localizes the failure code inside an attempt failure", () => {
      const result = formatAttention({
        code: "ATTENTION_ATTEMPT_FAILED",
        params: { code: "RUNNER_EXITED", message: "exit 3" },
      });
      expect(result.text).toContain(formatCode("RUNNER_EXITED"));
      expect(result.text).toContain("exit 3");
      expect(result.text).not.toContain("RUNNER_EXITED");
      expect(result.text).not.toContain("{{");
    });

    it("never shows a placeholder for an omitted param", () => {
      const result = formatAttention({ code: "ATTENTION_ATTEMPT_FAILED", params: { code: "RUNNER_EXITED" } });
      expect(result.text).not.toContain("{{");
      expect(result.text).not.toContain("message");
      expect(formatCode("ATTENTION_REENTRY_LIMIT")).not.toContain("{{");
    });

    it("shows an unknown code inside an integrity item", () => {
      const items = JSON.stringify([{ code: "INTEGRITY_FUTURE_CHECK", detail: "x" }]);
      const result = formatAttention({ code: "ATTENTION_INTEGRITY_CHANGED", params: { items } });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toContain("INTEGRITY_FUTURE_CHECK");
      expect(result.items[0]).toContain(": x");
      expect(result.items[0]).not.toContain("workflow:codes");
    });

    it("falls back to JSON for an unknown item shape", () => {
      const items = JSON.stringify([{ path: "a.txt" }, 7]);
      const result = formatAttention({ code: "ATTENTION_AGENT_CONFIG_CHANGED", params: { items } });
      expect(result.items).toEqual(['{"path":"a.txt"}', "7"]);
    });
  });

  describe("formatCommandError", () => {
    it("formats a CommandError with its message", () => {
      const text = formatCommandError({ code: "TASK_NOT_FOUND", message: "id abc" });
      expect(text).toBe(`${formatCode("TASK_NOT_FOUND")}\nid abc`);
    });

    it("omits an empty message", () => {
      expect(formatCommandError({ code: "TASK_NOT_FOUND", message: "" })).toBe(
        formatCode("TASK_NOT_FOUND"),
      );
    });

    it("formats an Error and other values", () => {
      expect(formatCommandError(new Error("boom"))).toBe("boom");
      expect(formatCommandError("plain")).toBe("plain");
      expect(formatCommandError(42)).toBe("42");
    });
  });
});

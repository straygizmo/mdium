import { describe, it, expect } from "vitest";
import { isAzureRefusal } from "../provider-detection";

describe("isAzureRefusal", () => {
  it("matches the canonical Azure content-filter refusal", () => {
    expect(
      isAzureRefusal("I'm sorry, but I cannot assist with that request."),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isAzureRefusal("I'M SORRY, BUT I CAN'T HELP WITH THAT."),
    ).toBe(true);
  });

  it("accepts 'I am sorry' alternate phrasing", () => {
    expect(
      isAzureRefusal("I am sorry, but I cannot help with that request."),
    ).toBe(true);
  });

  it("accepts 'can't assist' variant", () => {
    expect(
      isAzureRefusal("I'm sorry, but I can't assist with this."),
    ).toBe(true);
  });

  it("trims leading and trailing whitespace", () => {
    expect(
      isAzureRefusal("\n  I'm sorry, but I cannot assist with that.  \n"),
    ).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isAzureRefusal("")).toBe(false);
  });

  it("returns false when only apology is present", () => {
    expect(
      isAzureRefusal("I'm sorry for the confusion. Here's the answer..."),
    ).toBe(false);
  });

  it("returns false when only refusal phrase is present (no apology)", () => {
    expect(
      isAzureRefusal("The system cannot assist with malformed input."),
    ).toBe(false);
  });

  it("returns false for long legitimate responses containing both phrases", () => {
    const longText =
      "Here is a detailed answer. ".repeat(20) +
      "I'm sorry if this is confusing, but note that the API cannot assist with this edge case. " +
      "Continuing: ".repeat(10);
    expect(longText.length).toBeGreaterThan(300);
    expect(isAzureRefusal(longText)).toBe(false);
  });

  it("returns false for null-ish input", () => {
    expect(isAzureRefusal(undefined as unknown as string)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { generateSrt } from "../srt-generator";
import type { TimingEntry } from "../../types";

describe("generateSrt", () => {
  it("generates valid SRT from timing entries", () => {
    const timingData: TimingEntry[] = [
      { startMs: 0, endMs: 1500, text: "こんにちは" },
      { startMs: 1500, endMs: 3000, text: "世界" },
    ];

    const result = generateSrt(timingData);

    expect(result).toBe(
      "1\n" +
        "00:00:00,000 --> 00:00:01,500\n" +
        "こんにちは\n" +
        "\n" +
        "2\n" +
        "00:00:01,500 --> 00:00:03,000\n" +
        "世界\n",
    );
  });

  it("generates SRT from plain text and duration when no timing data", () => {
    const result = generateSrt(undefined, "Hello world", 4000);

    expect(result).toBe(
      "1\n" +
        "00:00:00,000 --> 00:00:04,000\n" +
        "Hello world\n",
    );
  });

  it("returns empty string for no input", () => {
    expect(generateSrt()).toBe("");
    expect(generateSrt([])).toBe("");
    expect(generateSrt(undefined, "", 5000)).toBe("");
    expect(generateSrt(undefined, "text", 0)).toBe("");
    expect(generateSrt(undefined, "text", -1)).toBe("");
  });

  it("handles time format correctly for large values", () => {
    const timingData: TimingEntry[] = [
      { startMs: 3_661_500, endMs: 3_723_000, text: "one hour plus" },
    ];

    const result = generateSrt(timingData);

    expect(result).toBe(
      "1\n" +
        "01:01:01,500 --> 01:02:03,000\n" +
        "one hour plus\n",
    );
  });
});

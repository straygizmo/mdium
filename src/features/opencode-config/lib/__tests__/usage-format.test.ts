import { describe, it, expect } from "vitest";
import { formatTokenCount, formatUsageCost } from "../usage-format";

describe("formatUsageCost", () => {
  it("formats small costs with 3 significant digits", () => {
    expect(formatUsageCost(0.0423)).toBe("$0.0423");
    expect(formatUsageCost(0.001234)).toBe("$0.00123");
  });
  it("formats larger costs", () => {
    expect(formatUsageCost(1.5)).toBe("$1.5");
    expect(formatUsageCost(12.34)).toBe("$12.3");
  });
  it("formats zero", () => {
    expect(formatUsageCost(0)).toBe("$0");
  });
});

describe("formatTokenCount", () => {
  it("shows small counts as-is", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });
  it("abbreviates thousands", () => {
    expect(formatTokenCount(12_345)).toBe("12.3k");
    expect(formatTokenCount(1_000)).toBe("1.0k");
  });
  it("abbreviates millions", () => {
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});

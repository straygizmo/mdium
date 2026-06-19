import { describe, it, expect } from "vitest";
import {
  computeFitZoom,
  validateResizeInput,
  followAspect,
  presetDimensions,
  RESIZE_MIN,
  RESIZE_MAX,
} from "../image-transform";

describe("computeFitZoom", () => {
  it("scales a large image down to fit the container", () => {
    expect(computeFitZoom(800, 600, 1600, 1200)).toBeCloseTo(0.5);
  });
  it("never upscales beyond 1 for a small image", () => {
    expect(computeFitZoom(800, 600, 100, 100)).toBe(1);
  });
  it("uses the smaller axis ratio", () => {
    // width ratio 0.5, height ratio 0.25 -> min = 0.25
    expect(computeFitZoom(800, 300, 1600, 1200)).toBeCloseTo(0.25);
  });
  it("returns 1 for non-positive image dimensions", () => {
    expect(computeFitZoom(800, 600, 0, 0)).toBe(1);
  });
});

describe("validateResizeInput", () => {
  it("accepts integers within range", () => {
    expect(validateResizeInput(800, 600)).toBe(true);
    expect(validateResizeInput(RESIZE_MIN, RESIZE_MAX)).toBe(true);
  });
  it("rejects below min, above max, zero, negative", () => {
    expect(validateResizeInput(0, 600)).toBe(false);
    expect(validateResizeInput(800, RESIZE_MAX + 1)).toBe(false);
    expect(validateResizeInput(-5, 600)).toBe(false);
  });
  it("rejects non-integers and NaN", () => {
    expect(validateResizeInput(800.5, 600)).toBe(false);
    expect(validateResizeInput(NaN, 600)).toBe(false);
  });
});

describe("followAspect", () => {
  it("derives height from width keeping the ratio", () => {
    expect(followAspect("w", 800, 1600, 1200)).toEqual({ width: 800, height: 600 });
  });
  it("derives width from height keeping the ratio", () => {
    expect(followAspect("h", 300, 1600, 1200)).toEqual({ width: 400, height: 300 });
  });
  it("rounds to integers", () => {
    expect(followAspect("w", 100, 333, 1000)).toEqual({ width: 100, height: 300 });
  });
});

describe("presetDimensions", () => {
  it("computes a percentage of the base size, rounded", () => {
    expect(presetDimensions(1600, 1200, 50)).toEqual({ width: 800, height: 600 });
    expect(presetDimensions(1601, 1200, 50)).toEqual({ width: 801, height: 600 });
    expect(presetDimensions(800, 600, 200)).toEqual({ width: 1600, height: 1200 });
  });
});

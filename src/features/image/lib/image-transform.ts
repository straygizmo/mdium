// Pure, DOM-free helpers for image crop/resize math. Unit-testable in node.

export const RESIZE_MIN = 1;
export const RESIZE_MAX = 10000;

/**
 * Zoom factor that fits an image into a container without upscaling.
 * Returns 1 when image dimensions are non-positive (defensive).
 */
export function computeFitZoom(
  containerW: number,
  containerH: number,
  imgW: number,
  imgH: number,
): number {
  if (imgW <= 0 || imgH <= 0) return 1;
  return Math.min(containerW / imgW, containerH / imgH, 1);
}

/** True when both dimensions are integers within [min, max]. */
export function validateResizeInput(
  width: number,
  height: number,
  min: number = RESIZE_MIN,
  max: number = RESIZE_MAX,
): boolean {
  const ok = (v: number) => Number.isInteger(v) && v >= min && v <= max;
  return ok(width) && ok(height);
}

/** Given a changed dimension, return both dimensions preserving the base aspect ratio. */
export function followAspect(
  dim: "w" | "h",
  value: number,
  baseW: number,
  baseH: number,
): { width: number; height: number } {
  if (dim === "w") {
    return { width: value, height: Math.round((value * baseH) / baseW) };
  }
  return { width: Math.round((value * baseW) / baseH), height: value };
}

/** Scale the base size by a percentage, rounded to integers. */
export function presetDimensions(
  baseW: number,
  baseH: number,
  percent: number,
): { width: number; height: number } {
  return {
    width: Math.round((baseW * percent) / 100),
    height: Math.round((baseH * percent) / 100),
  };
}

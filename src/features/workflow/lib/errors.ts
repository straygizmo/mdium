/**
 * Pure workflow helpers without i18n: the command client imports these, so
 * this module must stay a leaf (no i18n or other app state imports).
 */
import type { CommandError } from "@/shared/types/workflow";

/** The entity changed in the meantime; callers refresh silently instead of reporting it. */
export const TRANSITION_CONFLICT = "TRANSITION_CONFLICT";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCommandError(e: unknown): e is CommandError {
  return isRecord(e) && typeof e.code === "string" && typeof e.message === "string";
}

export function isWindows(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
}

/**
 * Compares project roots (case-insensitively on Windows). Both values must
 * already be backend-normalized roots (the `workflow_attach_project` result
 * or an event's `projectRoot`); no path normalization happens here.
 */
export function sameRoot(a: string, b: string): boolean {
  if (a === b) return true;
  return isWindows() && a.toLowerCase() === b.toLowerCase();
}

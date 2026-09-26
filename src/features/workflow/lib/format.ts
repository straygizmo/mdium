import i18n from "@/shared/i18n";
import type { AttentionReason, CommandError } from "@/shared/types/workflow";

/** Maximum number of list items shown for an attention reason. */
const MAX_ITEMS = 20;

/**
 * Localizes a machine code (attention reason, error code, finding kind).
 * Unknown codes fall back to a generic text that still shows the raw code,
 * so a newer backend never produces a blank or an i18n key path.
 */
export function formatCode(code: string, params?: Record<string, string>): string {
  const key = `workflow:codes.${code}`;
  if (code && i18n.exists(key)) {
    return i18n.t(key, { ...params }).trim();
  }
  return i18n.t("workflow:codes.unknown", { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Renders one entry of an `items` JSON array as a display line. */
function formatItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (isRecord(item)) {
    // Screening finding: { kind, line, excerpt }.
    if (typeof item.kind === "string") {
      const excerpt = typeof item.excerpt === "string" ? item.excerpt : "";
      return `${formatCode(item.kind)} (L${String(item.line ?? "?")}): ${excerpt}`;
    }
    // Integrity change: { code, detail }.
    if (typeof item.code === "string") {
      const detail = typeof item.detail === "string" ? item.detail : "";
      return formatCode(item.code) + (detail ? `: ${detail}` : "");
    }
  }
  return JSON.stringify(item) ?? String(item);
}

/** Parses the `items` param (a JSON array string) into display lines. */
function parseItems(raw: string | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, MAX_ITEMS).map(formatItem);
}

/** Localizes an attention reason; list params become `items` (max 20). */
export function formatAttention(reason: AttentionReason): { text: string; items: string[] } {
  const params = reason.params ?? {};
  return {
    text: formatCode(reason.code, params),
    items: parseItems(params.items),
  };
}

export function isCommandError(e: unknown): e is CommandError {
  return isRecord(e) && typeof e.code === "string" && typeof e.message === "string";
}

/** Display text for a rejected command: the localized code plus its detail. */
export function formatCommandError(err: unknown): string {
  if (isCommandError(err)) {
    const text = formatCode(err.code);
    return err.message ? `${text}\n${err.message}` : text;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function isWindows(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
}

/** Compares normalized project roots (case-insensitively on Windows). */
export function sameRoot(a: string, b: string): boolean {
  if (a === b) return true;
  return isWindows() && a.toLowerCase() === b.toLowerCase();
}

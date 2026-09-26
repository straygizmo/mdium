import i18n from "@/shared/i18n";
import type { AttentionReason } from "@/shared/types/workflow";
import { isCommandError, isRecord } from "./errors";

export { isCommandError, sameRoot } from "./errors";

/** Maximum number of list items shown for an attention reason. */
const MAX_ITEMS = 20;

/** Renders a missing param as "" instead of leaving `{{name}}` in the text. */
const missingInterpolationHandler = () => "";

/**
 * Localizes a machine code (attention reason, error code, finding kind).
 * Unknown codes fall back to a generic text that still shows the raw code,
 * so a newer backend never produces a blank or an i18n key path.
 */
export function formatCode(code: string, params?: Record<string, string>): string {
  const key = `workflow:codes.${code}`;
  if (code && i18n.exists(key)) {
    return i18n.t(key, { ...params, missingInterpolationHandler }).trim();
  }
  return i18n.t("workflow:codes.unknown", { code });
}

/** Localizes a guard rule id; unknown ids show the raw id after the generic label. */
function formatGuardRule(rule: string | undefined): string {
  const unknown = i18n.t("workflow:guardRule.unknown");
  if (!rule || rule === "unknown") return unknown;
  const key = `workflow:guardRule.${rule}`;
  return i18n.exists(key) ? i18n.t(key) : `${unknown} (${rule})`;
}

/** Renders one entry of an `items` JSON array as a display line. */
function formatItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (isRecord(item)) {
    // Screening finding: { kind, line, excerpt }.
    if (typeof item.kind === "string") {
      const excerpt = typeof item.excerpt === "string" ? item.excerpt : "";
      return i18n.t("workflow:format.finding", {
        kind: formatCode(item.kind),
        line: String(item.line ?? "?"),
        excerpt,
      });
    }
    // Integrity change: { code, detail }.
    if (typeof item.code === "string") {
      const detail = typeof item.detail === "string" ? item.detail : "";
      return formatCode(item.code) + (detail ? `: ${detail}` : "");
    }
  }
  return JSON.stringify(item) ?? String(item);
}

/**
 * Parses the `items` param (a JSON array string) into display lines: at most
 * `MAX_ITEMS`, followed by a localized "and N more" line when some are cut off.
 */
function parseItems(raw: string | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const lines = parsed.slice(0, MAX_ITEMS).map(formatItem);
  const rest = parsed.length - MAX_ITEMS;
  if (rest > 0) lines.push(i18n.t("workflow:format.moreItems", { count: rest }));
  return lines;
}

/**
 * Localizes an attention reason; list params become `items` (max 20, plus
 * an "and N more" line).
 * Code-bearing params are localized too: `codeText` from `params.code` and
 * `ruleText` from `params.rule` (guard rules).
 */
export function formatAttention(reason: AttentionReason): { text: string; items: string[] } {
  const params = reason.params ?? {};
  const derived: Record<string, string> = {
    ...params,
    codeText: params.code ? formatCode(params.code) : "",
    ruleText: formatGuardRule(params.rule),
  };
  return {
    text: formatCode(reason.code, derived),
    items: parseItems(params.items),
  };
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

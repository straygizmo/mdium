import type { ReplacementRule, ReplacementSettings } from "@/shared/types";

interface Pair {
  search: string;
  replace: string;
}

export interface ApplyResult {
  text: string;
  count: number;
}

/**
 * Build the active search/replace pairs for a direction, sorted so that
 * longer search strings match first (prevents partial replacement when one
 * rule's string contains another's, e.g. "社名A支店" vs "社名A").
 */
function activePairs(
  settings: ReplacementSettings,
  direction: "forward" | "reverse",
): Pair[] {
  if (!settings.enabled) return [];
  return settings.rules
    .filter((r) => r.enabled && r.from.length > 0 && r.to.length > 0)
    .map((r) =>
      direction === "forward"
        ? { search: r.from, replace: r.to }
        : { search: r.to, replace: r.from },
    )
    .sort((a, b) => b.search.length - a.search.length);
}

/**
 * Single-pass scan replacement. Replaced output is never re-scanned, so a
 * rule whose `to` equals another rule's `from` cannot cause double
 * replacement. Literal, case-sensitive matching.
 */
function applyPairs(text: string, pairs: Pair[]): ApplyResult {
  if (pairs.length === 0 || text.length === 0) return { text, count: 0 };
  let out = "";
  let count = 0;
  let i = 0;
  scan: while (i < text.length) {
    for (const p of pairs) {
      if (text.startsWith(p.search, i)) {
        out += p.replace;
        i += p.search.length;
        count++;
        continue scan;
      }
    }
    out += text[i];
    i++;
  }
  return { text: out, count };
}

export function applyForwardWithCount(
  text: string,
  settings: ReplacementSettings,
): ApplyResult {
  return applyPairs(text, activePairs(settings, "forward"));
}

export function applyForward(text: string, settings: ReplacementSettings): string {
  return applyForwardWithCount(text, settings).text;
}

export function applyReverseWithCount(
  text: string,
  settings: ReplacementSettings,
): ApplyResult {
  return applyPairs(text, activePairs(settings, "reverse"));
}

export function applyReverse(text: string, settings: ReplacementSettings): string {
  return applyReverseWithCount(text, settings).text;
}

/**
 * Detect `to` values shared by multiple enabled rules — reverse replacement
 * is ambiguous for those. Used by the UI to show a warning.
 */
export function findDuplicateTos(rules: ReplacementRule[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rules) {
    if (!r.enabled || !r.to) continue;
    counts.set(r.to, (counts.get(r.to) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([to]) => to);
}

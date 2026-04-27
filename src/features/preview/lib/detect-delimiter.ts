import Papa from "papaparse";
import { type CsvDelimiter } from "./delimiter";

/**
 * PapaParse's auto-detector probes ',', '\t', '|', and ';' (not ':'). When
 * none of those is a clear winner it returns ',' by default. To still pick
 * up colon-delimited files, run a focused colon fallback only when the
 * comma-based parse produced single-column rows (i.e. the comma is not
 * actually splitting anything) — this avoids misclassifying a comma CSV
 * that happens to contain timestamps with colons.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  if (text.trim() === "") return ",";
  const result = Papa.parse<string[]>(text, {
    preview: 10,
    skipEmptyLines: false,
  });
  const detected = result.meta.delimiter;

  // Trust PapaParse for the four delimiters it actually probes (other than
  // comma, which is its default fallback and may not reflect real intent).
  if (detected === "\t" || detected === ";" || detected === "|") {
    return detected;
  }

  // PapaParse said comma (or something we don't ship a tokenizer for).
  // If the comma-parse produced multi-column rows, comma is real.
  const rows = result.data;
  if (rows.some((r) => r.length > 1)) return ",";

  // Otherwise check whether colon is the actual delimiter.
  if (looksLikeColonDelimited(text)) return ":";

  return ",";
}

/**
 * Returns true when the first 10 non-empty lines all contain the same
 * non-zero number of colons outside double-quoted regions. Conservative on
 * purpose — we'd rather fall back to comma than misclassify a comma file
 * with stray colons.
 */
function looksLikeColonDelimited(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, 10);
  if (lines.length === 0) return false;
  const counts = lines.map(countColonsOutsideQuotes);
  if (counts[0] < 1) return false;
  return counts.every((c) => c === counts[0]);
}

function countColonsOutsideQuotes(line: string): number {
  let count = 0;
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      // RFC 4180 escaped quote inside a quoted field stays in-quote.
      if (inQuote && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === ":") count += 1;
  }
  return count;
}

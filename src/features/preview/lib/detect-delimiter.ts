import Papa from "papaparse";
import { ALL_DELIMITERS, type CsvDelimiter } from "./delimiter";

const SUPPORTED: ReadonlySet<string> = new Set<string>(ALL_DELIMITERS);

/**
 * Detect the column delimiter for CSV-family files at open time.
 *
 * Strategy: hand the first 10 lines to PapaParse with no delimiter so it
 * runs its own auto-detection, then check `meta.delimiter`. If PapaParse
 * picked one of the five we support, return it; otherwise fall back to
 * comma. Single-shot, pure function, never throws.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  if (text.trim() === "") return ",";
  const result = Papa.parse<string[]>(text, {
    preview: 10,
    skipEmptyLines: false,
  });
  const detected = result.meta.delimiter;
  if (typeof detected === "string" && SUPPORTED.has(detected)) {
    return detected as CsvDelimiter;
  }
  return ",";
}

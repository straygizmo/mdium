/**
 * Set of column delimiters the CSV viewer auto-detects and renders with
 * rainbow column coloring. Limited to a small enumerated set so that we
 * can pre-register a Monaco language id per delimiter (rainbow tokens are
 * scoped per-language).
 */
export type CsvDelimiter = "," | "\t" | ";" | "|" | ":";

export const ALL_DELIMITERS: readonly CsvDelimiter[] = [
  ",",
  "\t",
  ";",
  "|",
  ":",
];

/**
 * Maps each supported delimiter to the Monaco language id that will tokenize
 * it. The tokenizer is the same in all five — only the delimiter character
 * differs — but Monaco scopes token providers per language id.
 */
export const DELIMITER_LANGUAGE_ID: Record<CsvDelimiter, string> = {
  ",": "csv",
  "\t": "tsv",
  ";": "scsv",
  "|": "psv",
  ":": "colsv",
};

import type { ReplacementRule } from "@/shared/types";

export interface CsvRowError {
  line: number;
  reason: "columnCount" | "boolValue";
}

export interface ParsedRulesCsv {
  rows: Array<{ from: string; to: string; enabled: boolean }>;
  errors: CsvRowError[];
}

interface CsvRecord {
  fields: string[];
  /** 1-based line number where this record starts. */
  line: number;
}

/**
 * RFC4180-style CSV tokenizer. Handles quoted fields containing commas,
 * escaped quotes ("") and embedded newlines. Accepts CRLF and LF.
 */
function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let fieldHadQuotes = false;
  let recordHadContent = false;
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endField = () => {
    fields.push(field);
    field = "";
    if (fieldHadQuotes) recordHadContent = true;
    fieldHadQuotes = false;
  };
  const endRecord = () => {
    endField();
    // Skip blank lines (a single empty unquoted field).
    if (recordHadContent || fields.length > 1 || fields[0] !== "") {
      records.push({ fields, line: recordLine });
    }
    fields = [];
    recordHadContent = false;
    recordLine = line;
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === "\n") line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      fieldHadQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      recordHadContent = true;
      i++;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      line++;
      endRecord();
      i += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      line++;
      endRecord();
      i++;
      continue;
    }
    field += ch;
    recordHadContent = true;
    i++;
  }
  if (field !== "" || fields.length > 0 || fieldHadQuotes) {
    endRecord();
  }
  return records;
}

function parseBool(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

/**
 * Parse a rules CSV: header row (skipped, content not validated) followed by
 * 3-column records "from,to,enabled". Malformed rows are reported in
 * `errors` with their 1-based line numbers; valid rows are still returned.
 */
export function parseRulesCsv(text: string): ParsedRulesCsv {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = parseCsvRecords(body);
  const rows: ParsedRulesCsv["rows"] = [];
  const errors: CsvRowError[] = [];
  // records[0] is the header — skip it.
  for (const record of records.slice(1)) {
    if (record.fields.length !== 3) {
      errors.push({ line: record.line, reason: "columnCount" });
      continue;
    }
    const enabled = parseBool(record.fields[2]);
    if (enabled === null) {
      errors.push({ line: record.line, reason: "boolValue" });
      continue;
    }
    rows.push({ from: record.fields[0], to: record.fields[1], enabled });
  }
  return { rows, errors };
}

/**
 * Merge imported rows into existing rules. Rows whose `from` matches an
 * existing rule overwrite its `to`/`enabled` (keeping the id); others are
 * appended. Re-importing the same CSV is a no-op (idempotent).
 */
export function mergeRules(
  existing: ReplacementRule[],
  rows: ParsedRulesCsv["rows"],
): { rules: ReplacementRule[]; added: number; updated: number } {
  const rules = existing.map((r) => ({ ...r }));
  const byFrom = new Map(rules.map((r) => [r.from, r]));
  let added = 0;
  let updated = 0;
  for (const row of rows) {
    const hit = byFrom.get(row.from);
    if (hit) {
      if (hit.to !== row.to || hit.enabled !== row.enabled) {
        hit.to = row.to;
        hit.enabled = row.enabled;
        updated++;
      }
    } else {
      const rule: ReplacementRule = {
        id: crypto.randomUUID(),
        from: row.from,
        to: row.to,
        enabled: row.enabled,
      };
      rules.push(rule);
      byFrom.set(rule.from, rule);
      added++;
    }
  }
  return { rules, added, updated };
}

export const RULES_CSV_HEADER = "置換前文字列,置換後文字列,有効";

function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize rules to the same 3-column CSV format accepted by
 * parseRulesCsv (round-trip safe). CRLF line endings for Excel. The caller
 * prepends a BOM ("﻿") when writing to disk.
 */
export function exportRulesCsv(rules: ReplacementRule[]): string {
  const lines = [
    RULES_CSV_HEADER,
    ...rules.map(
      (r) =>
        `${escapeCsvField(r.from)},${escapeCsvField(r.to)},${r.enabled ? "true" : "false"}`,
    ),
  ];
  return lines.join("\r\n") + "\r\n";
}

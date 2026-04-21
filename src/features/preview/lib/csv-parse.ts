import Papa from "papaparse";

export interface CsvParseError {
  row: number;
  message: string;
}

export interface CsvParseResult {
  rows: string[][];
  errors: CsvParseError[];
  maxColumns: number;
}

export function parseCsv(text: string, delimiter: "," | "\t"): CsvParseResult {
  if (text === "") {
    return { rows: [], errors: [], maxColumns: 0 };
  }
  const result = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: false,
  });
  const rows = result.data;
  let maxColumns = 0;
  for (const row of rows) {
    if (row.length > maxColumns) maxColumns = row.length;
  }
  const errors: CsvParseError[] = result.errors.map((e) => ({
    row: e.row ?? -1,
    message: e.message,
  }));
  return { rows, errors, maxColumns };
}

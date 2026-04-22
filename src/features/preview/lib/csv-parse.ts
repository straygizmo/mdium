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

function toResult(rows: string[][], parseErrors: Papa.ParseError[]): CsvParseResult {
  let maxColumns = 0;
  for (const row of rows) {
    if (row.length > maxColumns) maxColumns = row.length;
  }
  const errors: CsvParseError[] = parseErrors.map((e) => ({
    row: e.row ?? -1,
    message: e.message,
  }));
  return { rows, errors, maxColumns };
}

export function parseCsv(text: string, delimiter: "," | "\t"): CsvParseResult {
  if (text === "") {
    return { rows: [], errors: [], maxColumns: 0 };
  }
  const result = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: false,
  });
  return toResult(result.data, result.errors);
}

// Worker-backed variant: offloads parsing to a Web Worker so the main thread
// stays responsive for large files (e.g. 50k+ row CSVs).
export function parseCsvAsync(
  text: string,
  delimiter: "," | "\t",
): Promise<CsvParseResult> {
  if (text === "") {
    return Promise.resolve({ rows: [], errors: [], maxColumns: 0 });
  }
  return new Promise((resolve) => {
    Papa.parse<string[]>(text, {
      worker: true,
      delimiter,
      skipEmptyLines: false,
      complete: (result) => resolve(toResult(result.data, result.errors)),
    });
  });
}

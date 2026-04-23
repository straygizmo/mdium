import Papa from "papaparse";
import CsvParseWorker from "./csv-parse.worker?worker";
import type { CsvWorkerRequest, CsvWorkerResponse } from "./csv-parse.worker";

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

// Shared worker instance. Vite bundles the worker script as a regular module
// asset (no blob URL), so this works under Tauri's CSP unlike Papa's built-in
// `worker: true` which relies on `URL.createObjectURL(new Blob(...))`.
let sharedWorker: Worker | null = null;
let nextRequestId = 0;

function getWorker(): Worker {
  if (!sharedWorker) sharedWorker = new CsvParseWorker();
  return sharedWorker;
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
  const id = nextRequestId++;
  const worker = getWorker();
  return new Promise<CsvParseResult>((resolve, reject) => {
    const onMessage = (event: MessageEvent<CsvWorkerResponse>) => {
      if (event.data.id !== id) return;
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      resolve({
        rows: event.data.rows,
        errors: event.data.errors,
        maxColumns: event.data.maxColumns,
      });
    };
    const onError = (event: ErrorEvent) => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      reject(event.error ?? new Error(event.message));
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    const request: CsvWorkerRequest = { id, text, delimiter };
    worker.postMessage(request);
  });
}

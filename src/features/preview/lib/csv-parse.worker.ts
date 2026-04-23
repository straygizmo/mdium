import Papa from "papaparse";

export interface CsvWorkerRequest {
  id: number;
  text: string;
  delimiter: "," | "\t";
}

export interface CsvWorkerResponse {
  id: number;
  rows: string[][];
  errors: { row: number; message: string }[];
  maxColumns: number;
}

self.onmessage = (event: MessageEvent<CsvWorkerRequest>) => {
  const { id, text, delimiter } = event.data;
  const result = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: false,
  });
  const rows = result.data;
  let maxColumns = 0;
  for (const row of rows) {
    if (row.length > maxColumns) maxColumns = row.length;
  }
  const response: CsvWorkerResponse = {
    id,
    rows,
    errors: result.errors.map((e) => ({
      row: e.row ?? -1,
      message: e.message,
    })),
    maxColumns,
  };
  (self as unknown as Worker).postMessage(response);
};

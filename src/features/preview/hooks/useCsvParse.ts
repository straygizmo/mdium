import { useEffect, useState } from "react";
import { parseCsvAsync, type CsvParseResult } from "../lib/csv-parse";
import type { CsvDelimiter } from "../lib/delimiter";

const EMPTY_RESULT: CsvParseResult = { rows: [], errors: [], maxColumns: 0 };

export function useCsvParse(
  content: string,
  delimiter: CsvDelimiter,
  debounceMs = 150,
): CsvParseResult {
  const [debounced, setDebounced] = useState(content);
  const [result, setResult] = useState<CsvParseResult>(EMPTY_RESULT);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(content), debounceMs);
    return () => clearTimeout(handle);
  }, [content, debounceMs]);

  useEffect(() => {
    let cancelled = false;
    parseCsvAsync(debounced, delimiter)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("CSV worker parse failed:", err);
        setResult(EMPTY_RESULT);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, delimiter]);

  return result;
}

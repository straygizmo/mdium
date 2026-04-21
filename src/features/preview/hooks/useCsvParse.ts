import { useEffect, useMemo, useState } from "react";
import { parseCsv, type CsvParseResult } from "../lib/csv-parse";

export function useCsvParse(
  content: string,
  delimiter: "," | "\t",
  debounceMs = 150,
): CsvParseResult {
  const [debounced, setDebounced] = useState(content);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(content), debounceMs);
    return () => clearTimeout(handle);
  }, [content, debounceMs]);

  return useMemo(
    () => parseCsv(debounced, delimiter),
    [debounced, delimiter],
  );
}

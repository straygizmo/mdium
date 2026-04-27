import type * as monaco from "monaco-editor";

export class CsvTokenState implements monaco.languages.IState {
  constructor(
    public readonly column: number,
    public readonly inQuote: boolean,
  ) {}

  clone(): monaco.languages.IState {
    return new CsvTokenState(this.column, this.inQuote);
  }

  equals(other: monaco.languages.IState): boolean {
    if (!(other instanceof CsvTokenState)) return false;
    return other.column === this.column && other.inQuote === this.inQuote;
  }
}

interface CsvToken {
  startIndex: number;
  type: string;
}

export interface CsvLineResult {
  tokens: CsvToken[];
  endState: CsvTokenState;
}

function colToken(column: number): string {
  return `col${column % 10}`;
}

/**
 * Tokenize a single physical line. State carries column index and quote flag
 * across lines, so quoted multi-line cells are colored correctly.
 *
 * End-of-line behavior: if we are NOT in a quote, the next line resets the
 * column to 0 (a CSV logical row ended). If we ARE in a quote, column is
 * preserved (the same logical cell continues).
 */
export function tokenizeCsvLine(
  line: string,
  startState: CsvTokenState,
  delimiter: string,
): CsvLineResult {
  const tokens: CsvToken[] = [];
  // If the previous line ended outside a quote, this line is a new CSV row —
  // reset the column counter to 0. If it ended inside a quote, carry the
  // column forward so the same logical cell keeps its color.
  let column = startState.inQuote ? startState.column : 0;
  let inQuote = startState.inQuote;
  let i = 0;
  let pendingStart = 0;
  let pendingType: string | null = null;

  const emit = (start: number, type: string) => {
    if (pendingType === type) return;
    if (pendingType !== null) {
      tokens.push({ startIndex: pendingStart, type: pendingType });
    }
    pendingStart = start;
    pendingType = type;
  };

  while (i < line.length) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          emit(i, colToken(column));
          i += 2;
          continue;
        }
        emit(i, colToken(column));
        inQuote = false;
        i += 1;
        continue;
      }
      emit(i, colToken(column));
      i += 1;
      continue;
    }
    // not in quote
    if (ch === '"') {
      emit(i, colToken(column));
      inQuote = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      emit(i, "delimiter");
      column += 1;
      i += 1;
      continue;
    }
    emit(i, colToken(column));
    i += 1;
  }

  if (pendingType !== null) {
    tokens.push({ startIndex: pendingStart, type: pendingType });
  }

  // Preserve the actual column reached so callers can inspect progress.
  // The column-reset for fresh rows happens at the START of the next call
  // (when startState.inQuote is false) rather than here, so cross-line state
  // is always accurate.
  const endState = new CsvTokenState(column, inQuote);
  return { tokens, endState };
}

export function registerCsvLanguages(monacoInstance: typeof monaco): void {
  const register = (id: string, delimiter: string) => {
    if (monacoInstance.languages.getLanguages().some((l) => l.id === id)) return;
    monacoInstance.languages.register({ id });
    monacoInstance.languages.setTokensProvider(id, {
      getInitialState: () => new CsvTokenState(0, false),
      tokenize: (line, state) => {
        const result = tokenizeCsvLine(
          line,
          state as CsvTokenState,
          delimiter,
        );
        return {
          tokens: result.tokens.map((t) => ({
            startIndex: t.startIndex,
            scopes: t.type,
          })),
          endState: result.endState,
        };
      },
    });
  };
  register("csv", ",");
  register("tsv", "\t");
}

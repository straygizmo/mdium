import { useRef, useCallback, useEffect } from "react";

const MAX_UNDO = 50;
const DEBOUNCE_MS = 300;

/**
 * Custom undo/redo for a controlled textarea input.
 * Snapshots are debounced so rapid typing doesn't flood the stack.
 */
export function useInputUndoRedo(
  input: string,
  setInput: (v: string) => void
) {
  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);
  const skipNextSnapshotRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSnapshotRef = useRef(input);
  const inputRef = useRef(input);
  inputRef.current = input;

  // Debounced snapshot: record input changes after 300ms of inactivity
  useEffect(() => {
    if (skipNextSnapshotRef.current) {
      skipNextSnapshotRef.current = false;
      lastSnapshotRef.current = input;
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      if (input !== lastSnapshotRef.current) {
        const stack = undoStackRef.current;
        stack.push(lastSnapshotRef.current);
        if (stack.length > MAX_UNDO) stack.shift();
        redoStackRef.current = [];
        lastSnapshotRef.current = input;
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [input]);

  const undo = useCallback(() => {
    // Flush any pending debounced snapshot first
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (inputRef.current !== lastSnapshotRef.current) {
      const stack = undoStackRef.current;
      stack.push(lastSnapshotRef.current);
      if (stack.length > MAX_UNDO) stack.shift();
      lastSnapshotRef.current = inputRef.current;
    }

    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack.pop()!;
    redoStackRef.current.push(inputRef.current);
    skipNextSnapshotRef.current = true;
    lastSnapshotRef.current = prev;
    setInput(prev);
  }, [setInput]);

  const redo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const next = stack.pop()!;
    undoStackRef.current.push(inputRef.current);
    skipNextSnapshotRef.current = true;
    lastSnapshotRef.current = next;
    setInput(next);
  }, [setInput]);

  const reset = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    lastSnapshotRef.current = inputRef.current;
    skipNextSnapshotRef.current = true;
  }, []);

  return { undo, redo, reset };
}

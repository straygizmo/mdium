import { useRef, useCallback } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

const MAX_HISTORY = 100;

interface InputHistoryState {
  history: string[];
  addEntry: (text: string) => void;
}

export const useInputHistoryStore = create<InputHistoryState>()(
  persist(
    (set) => ({
      history: [],
      addEntry: (text: string) => {
        set((s) => {
          const filtered = s.history.filter((h) => h !== text);
          const updated = [...filtered, text].slice(-MAX_HISTORY);
          return { history: updated };
        });
      },
    }),
    { name: "opencode-input-history" }
  )
);

/**
 * Hook for navigating input history with arrow keys.
 */
export function useInputHistoryNav(
  input: string,
  setInput: (value: string) => void
) {
  const indexRef = useRef(-1);
  const savedInputRef = useRef("");
  const inputRef = useRef(input);
  inputRef.current = input;

  const resetNav = useCallback(() => {
    indexRef.current = -1;
    savedInputRef.current = "";
  }, []);

  const handleHistoryKey = useCallback(
    (e: React.KeyboardEvent): boolean => {
      const history = useInputHistoryStore.getState().history;
      if (history.length === 0) return false;

      if (e.key === "ArrowUp") {
        // Only trigger history when the input is empty; otherwise let the
        // caret move naturally. Continue navigating if already in history.
        if (indexRef.current === -1 && inputRef.current !== "") return false;
        e.preventDefault();
        if (indexRef.current === -1) {
          savedInputRef.current = inputRef.current;
        }
        const nextIndex = Math.min(indexRef.current + 1, history.length - 1);
        indexRef.current = nextIndex;
        setInput(history[history.length - 1 - nextIndex]);
        return true;
      }

      if (e.key === "ArrowDown") {
        if (indexRef.current === -1) return false;
        e.preventDefault();
        const nextIndex = indexRef.current - 1;
        if (nextIndex < 0) {
          indexRef.current = -1;
          setInput(savedInputRef.current);
        } else {
          indexRef.current = nextIndex;
          setInput(history[history.length - 1 - nextIndex]);
        }
        return true;
      }

      return false;
    },
    [setInput]
  );

  return { handleHistoryKey, resetNav };
}

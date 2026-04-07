import { create } from "zustand";

export type DialogKind = "info" | "warning" | "error";

interface DialogEntry {
  id: number;
  type: "message" | "confirm" | "prompt";
  title?: string;
  text: string;
  kind?: DialogKind;
  defaultValue?: string;
  resolve: (value: boolean | string | null) => void;
}

interface DialogState {
  dialogs: DialogEntry[];
  _nextId: number;
  _push: (entry: Omit<DialogEntry, "id">) => void;
  _remove: (id: number) => void;
}

export const useDialogStore = create<DialogState>((set, get) => ({
  dialogs: [],
  _nextId: 1,
  _push: (entry) => {
    const id = get()._nextId;
    set((s) => ({
      dialogs: [...s.dialogs, { ...entry, id }],
      _nextId: id + 1,
    }));
  },
  _remove: (id) => {
    set((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) }));
  },
}));

/** Show an informational / warning / error message dialog. Resolves when user clicks OK. */
export function showMessage(
  text: string,
  options?: { title?: string; kind?: DialogKind },
): Promise<void> {
  return new Promise((resolve) => {
    useDialogStore.getState()._push({
      type: "message",
      text,
      title: options?.title,
      kind: options?.kind,
      resolve: () => resolve(),
    });
  });
}

/** Show a confirm dialog (OK / Cancel). Resolves to true if confirmed. */
export function showConfirm(
  text: string,
  options?: { title?: string; kind?: DialogKind },
): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState()._push({
      type: "confirm",
      text,
      title: options?.title,
      kind: options?.kind,
      resolve: (v) => resolve(v as boolean),
    });
  });
}

/** Show a prompt dialog with text input. Resolves to the input value, or null if cancelled. */
export function showPrompt(
  text: string,
  options?: { title?: string; defaultValue?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState()._push({
      type: "prompt",
      text,
      title: options?.title,
      defaultValue: options?.defaultValue ?? "",
      resolve: (v) => resolve(v as string | null),
    });
  });
}

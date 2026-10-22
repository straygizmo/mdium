import { invoke } from "@tauri-apps/api/core";
import { useMacroChatStore } from "@/stores/macro-chat-store";

/** Returns the stored (workbookKey-normalized) workbook key bound to the session, or null. */
export function workbookForSession(
  sessionId: string | null,
  sessionByWorkbook: Record<string, string>,
): string | null {
  if (!sessionId) return null;
  for (const [key, value] of Object.entries(sessionByWorkbook)) {
    if (value === sessionId) return key;
  }
  return null;
}

/** Clears the vba_run budget and remembered approvals for a workbook. Never throws. */
export async function resetVbaRunBudget(xlsmPath: string): Promise<void> {
  try {
    await invoke("reset_vba_run_budget", { xlsmPath });
  } catch (e) {
    console.warn("[vba-run-budget] reset failed", e);
  }
}

/** Resets the budget of the workbook bound to the session; no-op when none is bound. */
export async function resetVbaRunBudgetForSession(sessionId: string | null): Promise<void> {
  const key = workbookForSession(sessionId, useMacroChatStore.getState().sessionByWorkbook);
  if (key) await resetVbaRunBudget(key);
}

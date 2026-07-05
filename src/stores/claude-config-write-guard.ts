import { showMessage } from "@/stores/dialog-store";
import i18n from "@/shared/i18n";

// Wrap a write operation so any failure is reported to the user once, via the
// app-wide error modal, and then re-thrown for the caller to react to. This is
// the single place Claude-config write failures are surfaced.
export async function guardWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await showMessage(`${i18n.t("claude-config:saveFailed")}: ${String(e)}`, { kind: "error" });
    throw e;
  }
}

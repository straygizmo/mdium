import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { showConfirm } from "@/stores/dialog-store";

export interface VbaRunApprovalRequest {
  id: string;
  xlsmPath: string;
  macros: string[];
  matches: { module: string; line: number; text: string }[];
}

/** How long the dialog stays open; the Rust side gives up after the same time. */
export const VBA_RUN_APPROVAL_TIMEOUT_MS = 120_000;
/** Maximum number of side-effect lines listed in the dialog. */
export const VBA_RUN_APPROVAL_MAX_LINES = 20;

/** Builds the dialog body text. Pure; exported for tests. */
export function formatApprovalMessage(
  req: VbaRunApprovalRequest,
  t: TFunction<"editor">,
): string {
  // Built with fromCharCode to avoid a backslash escape in source.
  const fileName =
    req.xlsmPath.split("/").pop()?.split(String.fromCharCode(92)).pop() || req.xlsmPath;
  const lines = req.matches
    .slice(0, VBA_RUN_APPROVAL_MAX_LINES)
    .map((m) => `${m.module}:${m.line}: ${m.text}`);
  if (req.matches.length > VBA_RUN_APPROVAL_MAX_LINES) {
    lines.push(
      t("vbaRunApprovalMore", {
        count: req.matches.length - VBA_RUN_APPROVAL_MAX_LINES,
      }),
    );
  }
  return t("vbaRunApprovalBody", {
    fileName,
    macros: req.macros.join(", "),
    matches: lines.join("\n"),
  });
}

/**
 * Asks the user to approve macro runs whose code has side-effecting calls.
 * Rust emits `vba-run-approval-request` and blocks until
 * `vba_run_approval_reply` arrives. Mount once near the app root.
 */
export function useVbaRunApproval(): void {
  const { t } = useTranslation("editor");

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    listen<VbaRunApprovalRequest>("vba-run-approval-request", (event) => {
      if (disposed) return;
      const req = event.payload;
      void (async () => {
        let granted = false;
        try {
          granted = await showConfirm(formatApprovalMessage(req, t), {
            title: t("vbaRunApprovalTitle"),
            kind: "warning",
            signal: AbortSignal.timeout(VBA_RUN_APPROVAL_TIMEOUT_MS),
          });
        } catch (e) {
          console.error("[vba-run] approval dialog failed:", e);
        }
        try {
          await invoke("vba_run_approval_reply", { id: req.id, granted });
        } catch (e) {
          console.error("[vba-run] approval reply failed:", e);
        }
      })();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [t]);
}

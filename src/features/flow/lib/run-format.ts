import type { TFunction } from "i18next";
import type { FlowRunError, Reason } from "@/shared/types/flow-run";
import type { FlowIssue } from "@/shared/types/flow";
import { issueParams } from "../components/FlowIssueList";

/** Localizes a reason code: `reason.*`, then `issue.*`, else the code itself. */
export function describeReason(t: TFunction, reason: Reason): string {
  const params = issueParams({ code: reason.code as FlowIssue["code"], path: "", params: reason.params ?? {} });
  for (const ns of ["reason", "issue"]) {
    const key = `${ns}.${reason.code}`;
    const text = t(key, { ...params, defaultValue: "", interpolation: { escapeValue: false } });
    if (text) return text;
  }
  return reason.code;
}

/** Localizes an operation failure (its code), plus its details. */
export function describeError(t: TFunction, error: FlowRunError): { message: string; details: string[] } {
  const message = t(`runError.${error.code}`, { defaultValue: error.code });
  const details = (error.details ?? []).map((d) => {
    const text = describeReason(t, d);
    const path = typeof d.params?.path === "string" ? d.params.path : "";
    // Validation issues don't mention their location; add it.
    return path && !text.includes(path) ? `${text} (${path})` : text;
  });
  return { message, details };
}

/** USD with up to 4 decimals (no trailing zeros beyond 2). */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const fixed = value.toFixed(4).replace(/0+$/, "");
  const [whole, frac = ""] = fixed.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

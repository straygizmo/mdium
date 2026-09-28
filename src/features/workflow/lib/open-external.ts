import { invoke } from "@tauri-apps/api/core";
import i18n from "@/shared/i18n";
import { showMessage } from "@/stores/dialog-store";
import { formatCommandError } from "./format";

/** Whether `text` contains whitespace or a control character (code 0x20 and below, or DEL). */
function hasUnsafeChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The normalized URL an untrusted link may be opened with, or null. Only
 * absolute http/https URLs without whitespace or control characters qualify.
 * The backend opens the URL without a shell and percent-encodes commas, so
 * other characters are passed through unchanged.
 */
export function externalUrl(href: string): string | null {
  let url: URL;
  try {
    // No base URL: relative links fail to parse and are never opened.
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (hasUnsafeChar(url.href)) return null;
  return url.href;
}

/**
 * Opens an untrusted URL in the external browser when `externalUrl` accepts
 * it. A refused URL or a failed open is shown in an error dialog titled by
 * the i18n key `errorTitleKey` (with namespace). Resolves to whether the URL
 * was opened.
 */
export async function openExternal(href: string, errorTitleKey: string): Promise<boolean> {
  const fail = (detail: string) => void showMessage(detail, { title: i18n.t(errorTitleKey), kind: "error" });
  const url = externalUrl(href);
  if (!url) {
    fail(href);
    return false;
  }
  try {
    await invoke("open_external_url", { url });
    return true;
  } catch (err) {
    fail(formatCommandError(err));
    return false;
  }
}

import { invoke } from "@tauri-apps/api/core";
import i18n from "@/shared/i18n";

/** Install guide for Node.js (required by Slidev / video generation). */
export const NODE_INSTALL_URL = "https://nodejs.org/";

/** Install guide for the opencode CLI (required by AI chat). */
export const OPENCODE_INSTALL_URL = "https://opencode.ai/docs/";

export interface EnsureCommandOptions {
  /** i18n key (ns: common) for the "not found" message. */
  messageKey: string;
  /** i18n key (ns: common) for the "open the install guide?" prompt line. */
  promptKey: string;
  /** External URL opened when the user accepts the install guide. */
  installUrl: string;
}

/**
 * Verify that an external command is available on PATH before launching a
 * feature that depends on it. When the command is missing, notify the user with
 * a localized message and offer to open the install guide in the browser.
 *
 * Returns true when the command exists (caller may proceed), false otherwise.
 * Errors from the availability check are treated as "missing" (safe side) so a
 * broken probe never silently launches a feature that will hang or fail.
 */
export async function ensureCommand(
  command: string,
  opts: EnsureCommandOptions,
): Promise<boolean> {
  let exists = false;
  try {
    exists = await invoke<boolean>("check_command_exists", { name: command });
  } catch {
    exists = false;
  }

  if (exists) return true;

  const message = `${i18n.t(opts.messageKey, { ns: "common" })}\n\n${i18n.t(opts.promptKey, { ns: "common" })}`;
  if (confirm(message)) {
    try {
      await invoke("open_external_url", { url: opts.installUrl });
    } catch {
      // Opening the browser is best-effort; ignore failures.
    }
  }
  return false;
}

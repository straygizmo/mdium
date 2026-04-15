import { invoke } from "@tauri-apps/api/core";

/**
 * Detects Azure OpenAI content-filter refusal responses.
 * Requires both an apology marker and a refusal phrase, with a length
 * guard to avoid matching long legitimate responses that happen to
 * contain these phrases in passing.
 */
export function isAzureRefusal(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().trim().replace(/\u2019/g, "'");
  if (normalized.length > 300) return false;
  const hasSorry =
    normalized.includes("i'm sorry") || normalized.includes("i am sorry");
  const hasRefusal =
    normalized.includes("cannot assist") ||
    normalized.includes("can't assist") ||
    normalized.includes("cannot help") ||
    normalized.includes("can't help");
  return hasSorry && hasRefusal;
}

async function getHomeSep(): Promise<{ home: string; sep: string }> {
  const home = await invoke<string>("get_home_dir");
  const sep = home.includes("\\") ? "\\" : "/";
  return { home, sep };
}

/**
 * Returns true when the current opencode session is likely backed by Azure.
 *
 * Detection strategy:
 * 1. Read ~/.config/opencode/config.json and check whether `model` starts
 *    with "azure/". If `model` is present but non-Azure, return false
 *    without falling back — opencode's own config is authoritative.
 * 2. If config.json is missing / unparsable / has no `model` field,
 *    fall back to mdium's own AI settings (`aiSettings.provider === "azure"`).
 *
 * No caching: called only from the refusal path, which is rare.
 */
export async function isAzureProviderActive(): Promise<boolean> {
  try {
    const { home, sep } = await getHomeSep();
    const configPath = `${home}${sep}.config${sep}opencode${sep}config.json`;
    const raw = await invoke<string>("read_text_file", { path: configPath });
    const config = JSON.parse(raw);
    if (typeof config.model === "string") {
      return config.model.startsWith("azure/");
    }
  } catch {
    // fall through to fallback
  }
  // Dynamic import: settings-store transitively loads i18n, which touches
  // localStorage at module evaluation time and breaks vitest. Deferring
  // the import to this fallback path avoids the test-env issue and costs
  // nothing on the happy path.
  const { useSettingsStore } = await import("@/stores/settings-store");
  const settings = useSettingsStore.getState();
  return settings.aiSettings?.provider === "azure";
}

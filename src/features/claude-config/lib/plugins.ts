// Pure helpers for the Claude "Plugins" settings tab. No I/O here — the store
// wires these to Tauri file commands. Kept side-effect-free for unit testing.

export interface InstalledPluginRecord {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha: string;
}

export interface PluginListItem {
  key: string; // "name@marketplace"
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
}

/** Split a "name@marketplace" key on the last "@". */
export function parsePluginKey(key: string): { name: string; marketplace: string } {
  const at = key.lastIndexOf("@");
  if (at <= 0) return { name: key, marketplace: "" };
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}

/** A key absent from enabledPlugins is enabled by default; only explicit false disables. */
export function isPluginEnabled(enabledPlugins: Record<string, boolean>, key: string): boolean {
  return enabledPlugins[key] !== false;
}

/** Merge the installed set with the enabled map into a sorted display list. */
export function mergePluginList(
  installed: Record<string, InstalledPluginRecord[]>,
  enabledPlugins: Record<string, boolean>,
): PluginListItem[] {
  return Object.entries(installed)
    .map(([key, records]) => {
      const { name, marketplace } = parsePluginKey(key);
      const record = records.find((r) => r.scope === "user") ?? records[0];
      return {
        key,
        name,
        marketplace,
        version: record?.version ?? "",
        enabled: isPluginEnabled(enabledPlugins, key),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Return a new enabledPlugins map with `key` set to `enabled`, other keys preserved. */
export function toggleEnabledPlugins(
  enabledPlugins: Record<string, boolean>,
  key: string,
  enabled: boolean,
): Record<string, boolean> {
  return { ...enabledPlugins, [key]: enabled };
}

/** Read the `plugins` map out of installed_plugins.json raw text. */
export function extractInstalledPlugins(raw: string): Record<string, InstalledPluginRecord[]> {
  try {
    const json = JSON.parse(raw);
    return json?.plugins ?? {};
  } catch {
    return {};
  }
}

/** Read the `enabledPlugins` map out of settings.json raw text. */
export function extractEnabledPlugins(raw: string): Record<string, boolean> {
  try {
    const json = JSON.parse(raw);
    return json?.enabledPlugins ?? {};
  } catch {
    return {};
  }
}

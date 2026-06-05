export interface BuiltinPluginEntry {
  /** Canonical package spec written to the opencode `plugin` array. */
  spec: string;
  /** i18n key (in the "opencode-config" namespace) for the UI description. */
  descriptionKey: string;
  /** Documentation URL opened from the 🔗 link. */
  docsUrl: string;
}

// The oh-my-opencode plugin is published under the npm name `oh-my-openagent`
// (the package was renamed; `oh-my-opencode` is an alias of the same release).
export const BUILTIN_PLUGINS: Record<string, BuiltinPluginEntry> = {
  superpowers: {
    spec: "superpowers@git+https://github.com/obra/superpowers.git#v5.1.0",
    descriptionKey: "pluginDesc_superpowers",
    docsUrl: "https://github.com/obra/superpowers/blob/main/docs/README.opencode.md",
  },
  "oh-my-opencode": {
    spec: "oh-my-openagent",
    descriptionKey: "pluginDesc_oh-my-opencode",
    docsUrl: "https://ohmyopencode.com/",
  },
};

/** True if the given spec string belongs to a built-in plugin. */
export function isBuiltinPlugin(spec: string): boolean {
  return Object.values(BUILTIN_PLUGINS).some((e) => e.spec === spec);
}

/** Return a new array with `spec` appended if not already present (dedup). */
export function addPluginSpec(list: string[], spec: string): string[] {
  return list.includes(spec) ? [...list] : [...list, spec];
}

/** Return a new array with all occurrences of `spec` removed. */
export function removePluginSpec(list: string[], spec: string): string[] {
  return list.filter((p) => p !== spec);
}

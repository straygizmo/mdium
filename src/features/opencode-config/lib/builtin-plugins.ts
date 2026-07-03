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
    spec: "superpowers@git+https://github.com/obra/superpowers.git#v6.1.1",
    descriptionKey: "pluginDesc_superpowers",
    docsUrl: "https://github.com/obra/superpowers/blob/main/docs/README.opencode.md",
  },
  "oh-my-opencode": {
    spec: "oh-my-openagent",
    descriptionKey: "pluginDesc_oh-my-opencode",
    docsUrl: "https://ohmyopencode.com/",
  },
};

/** Strip the trailing `#<ref>` (tag/branch pin) from a plugin spec. */
export function basePluginSpec(spec: string): string {
  const hash = spec.indexOf("#");
  return hash === -1 ? spec : spec.slice(0, hash);
}

/** True if the given spec string belongs to a built-in plugin (any pinned version). */
export function isBuiltinPlugin(spec: string): boolean {
  return getBuiltinPluginIdBySpec(spec) !== undefined;
}

/** Built-in plugin ids whose spec (any pinned version) is not present in the current plugin array. */
export function getMissingBuiltinPlugins(currentPlugins: string[]): string[] {
  const present = new Set(currentPlugins.map(basePluginSpec));
  return Object.keys(BUILTIN_PLUGINS).filter(
    (id) => !present.has(basePluginSpec(BUILTIN_PLUGINS[id].spec)),
  );
}

/** Find the built-in plugin id whose spec matches (ignoring the version pin), or undefined if none. */
export function getBuiltinPluginIdBySpec(spec: string): string | undefined {
  const base = basePluginSpec(spec);
  return Object.keys(BUILTIN_PLUGINS).find(
    (id) => basePluginSpec(BUILTIN_PLUGINS[id].spec) === base,
  );
}

/** Return a new array with `spec` appended if not already present (dedup). */
export function addPluginSpec(list: string[], spec: string): string[] {
  return list.includes(spec) ? [...list] : [...list, spec];
}

/** Return a new array with all occurrences of `spec` removed. */
export function removePluginSpec(list: string[], spec: string): string[] {
  return list.filter((p) => p !== spec);
}

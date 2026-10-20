export interface CodexModel {
  slug: string;
  displayName: string;
}

/**
 * Parse the model list Codex caches in ~/.codex/models_cache.json. Hidden
 * models are skipped and the rest are ordered by the CLI's priority field.
 * Malformed input yields an empty list.
 */
export function parseCodexModels(raw: string): CodexModel[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const models = (json as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
    .filter((m) => typeof m.slug === "string" && m.slug !== "" && m.visibility !== "hide")
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
    .map((m) => ({
      slug: m.slug as string,
      displayName: typeof m.display_name === "string" && m.display_name ? m.display_name : (m.slug as string),
    }));
}

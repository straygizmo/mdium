export type RagErrorKind =
  | "modelMissing"
  | "network"
  | "download"
  | "engine"
  | "generic"
  | null;

// Map the raw build/embed error strings to a single UI category. Order matters:
// a missing model (download unavailable) takes priority so the manual-placement
// guidance is shown instead of a generic network message.
export function classifyRagError(
  buildError: string | null,
  embedError: string | null
): RagErrorKind {
  const has = (s: string) =>
    (buildError?.includes(s) ?? false) || (embedError?.includes(s) ?? false);
  if (has("MODEL_MISSING")) return "modelMissing";
  if (has("NETWORK_ERROR")) return "network";
  if (has("DOWNLOAD_ERROR")) return "download";
  if (has("ENGINE_CRASH")) return "engine";
  if (buildError || embedError) return "generic";
  return null;
}

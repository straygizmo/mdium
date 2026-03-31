/**
 * Extract a filename prefix from a .video.json path.
 *
 * "C:/docs/my-presentation.video.json" → "my-presentation"
 * Falls back to "video" when no path is provided.
 */
export function videoFilePrefix(filePath: string | null | undefined): string {
  if (!filePath) return "video";
  const name = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  // Strip .video.json, .video.jsonc, or .md (case-insensitive)
  const stripped = name.replace(/\.video\.jsonc?$|\.md$/i, "");
  return stripped || "video";
}

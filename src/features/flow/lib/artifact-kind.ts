/** How the preview renders an artifact, derived from its media type. */
export type ArtifactKind = "image" | "video" | "audio" | "text" | "json" | "other";

/** How many bytes of a text artifact the preview loads. */
export const TEXT_PREVIEW_BYTES = 256 * 1024;

export function artifactKind(mediaType: string): ArtifactKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType === "application/json") return "json";
  if (mediaType.startsWith("text/")) return "text";
  return "other";
}

/** Fetches at most `maxBytes` of a text artifact; rejects on a failed response. */
export async function fetchTextHead(
  url: string,
  maxBytes: number = TEXT_PREVIEW_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  const response = await fetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` } });
  if (!response.ok) throw new Error(`artifact fetch failed: ${response.status}`);
  const text = await response.text();
  let truncated = false;
  if (response.status === 206) {
    // "Content-Range: bytes 0-3/12345" -> total after the slash.
    const total = Number(response.headers.get("Content-Range")?.split("/")[1]);
    truncated = Number.isFinite(total) && total > maxBytes;
  }
  if (text.length > maxBytes) return { text: text.slice(0, maxBytes), truncated: true };
  return { text, truncated };
}

/** Re-indents JSON text with two spaces, or returns null when it does not parse. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

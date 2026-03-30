/**
 * Split narration text into segments by Japanese period (。) and newlines.
 * Empty segments are filtered out.
 */
export function splitNarration(text: string): string[] {
  // First split by newlines
  const lines = text.split(/\n/);
  const segments: string[] = [];

  for (const line of lines) {
    // Then split each line by 。 (keep the 。 attached to the preceding text)
    const parts = line.split(/(?<=。)/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
    }
  }

  return segments;
}

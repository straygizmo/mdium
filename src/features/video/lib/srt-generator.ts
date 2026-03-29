import type { TimingEntry } from "../types";

/**
 * Formats a millisecond timestamp as SRT time: HH:MM:SS,mmm
 */
function formatSrtTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const milliseconds = ms % 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const mmm = String(milliseconds).padStart(3, "0");

  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Generates an SRT subtitle string from timing data or a fallback text/duration.
 *
 * - If `timingData` has entries, generates SRT from each entry.
 * - If no timing data but `fallbackText` and `fallbackDurationMs` > 0, generates
 *   a single entry spanning the full duration.
 * - Otherwise returns an empty string.
 */
export function generateSrt(
  timingData?: TimingEntry[],
  fallbackText?: string,
  fallbackDurationMs?: number,
): string {
  if (timingData && timingData.length > 0) {
    return timingData
      .map((entry, index) => {
        const start = formatSrtTime(entry.startMs);
        const end = formatSrtTime(entry.endMs);
        return `${index + 1}\n${start} --> ${end}\n${entry.text}\n`;
      })
      .join("\n");
  }

  if (fallbackText && fallbackDurationMs && fallbackDurationMs > 0) {
    const start = formatSrtTime(0);
    const end = formatSrtTime(fallbackDurationMs);
    return `1\n${start} --> ${end}\n${fallbackText}\n`;
  }

  return "";
}

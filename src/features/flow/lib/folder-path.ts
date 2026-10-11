/** Normalizes a folder path for comparison: `/` separators, no trailing slash, lower case. */
export function normalizeFolder(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when two folder paths name the same folder despite spelling differences. */
export function sameFolder(a: string, b: string): boolean {
  return normalizeFolder(a) === normalizeFolder(b);
}

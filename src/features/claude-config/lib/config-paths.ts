/** Path separator already used by an absolute path ("\" on Windows paths, "/" otherwise). */
export function pathSep(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

/** Join path segments using the separator of the base path. */
export function joinPath(base: string, ...parts: string[]): string {
  return [base, ...parts].join(pathSep(base));
}

/**
 * Shorten an absolute path inside the project to start at the project folder name.
 * e.g. C:\Users\me\Works\Demo\.mcp.json → Demo\.mcp.json
 */
export function toRelativeProjectPath(folderPath: string, fullPath: string): string {
  const sep = pathSep(folderPath);
  const parentIdx = folderPath.lastIndexOf(sep);
  if (parentIdx >= 0) {
    const parent = folderPath.substring(0, parentIdx + 1);
    if (fullPath.startsWith(parent)) {
      return fullPath.substring(parent.length);
    }
  }
  return fullPath;
}

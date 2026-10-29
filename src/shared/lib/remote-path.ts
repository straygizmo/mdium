import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "@/shared/types";

/**
 * Remote (FTP) items are addressed as `ftp://user@host:port/path`. The Rust
 * file commands route these URIs to the FTP backend, so most code can treat
 * them like local paths. Code that talks to plugin-fs directly must go through
 * the helpers below instead.
 */
export const REMOTE_SCHEME = "ftp://";

/** Error prefix returned by the backend when the server copy changed. */
export const REMOTE_CHANGED_ERROR = "FTP_REMOTE_CHANGED";

export function isRemotePath(path: string | null | undefined): boolean {
  return !!path && path.startsWith(REMOTE_SCHEME);
}

/** Read a local or remote file as bytes. */
export async function readFileBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  if (isRemotePath(path)) {
    const bytes = await invoke<number[]>("read_binary_file", { path });
    return new Uint8Array(bytes);
  }
  const { readFile } = await import("@tauri-apps/plugin-fs");
  return readFile(path);
}

/**
 * Write bytes to a local or remote file. For remote files `force` overwrites
 * the server copy even if it changed since it was read.
 */
export async function writeFileBytes(path: string, data: Uint8Array, force = false): Promise<void> {
  if (isRemotePath(path)) {
    await invoke("write_binary_file", { path, data: Array.from(data), force });
    return;
  }
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, data);
}

/** Paths of directories explicitly expanded in a folder (for remote reloads). */
export function expandedDirPaths(expanded: Record<string, boolean> | undefined): string[] {
  return Object.entries(expanded ?? {})
    .filter(([, open]) => open)
    .map(([path]) => path);
}

/** Return a copy of `tree` with the children of `dirPath` replaced. */
export function replaceDirChildren(
  tree: FileEntry[],
  dirPath: string,
  children: FileEntry[],
): FileEntry[] {
  return tree.map((entry) => {
    if (entry.path === dirPath) return { ...entry, children };
    if (entry.is_dir && entry.children && dirPath.startsWith(entry.path + "/")) {
      return { ...entry, children: replaceDirChildren(entry.children, dirPath, children) };
    }
    return entry;
  });
}

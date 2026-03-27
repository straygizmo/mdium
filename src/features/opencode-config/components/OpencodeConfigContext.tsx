import { createContext, useContext } from "react";

interface OpencodeConfigContextValue {
  useRelativePaths: boolean;
}

const OpencodeConfigContext = createContext<OpencodeConfigContextValue>({
  useRelativePaths: false,
});

export const OpencodeConfigProvider = OpencodeConfigContext.Provider;

export function useOpencodeConfigContext() {
  return useContext(OpencodeConfigContext);
}

/**
 * Convert an absolute project path to a relative path showing only the folder name.
 * e.g. C:\Users\mtmar\Desktop\Works\Demo\.opencode\tools\ → Demo\.opencode\tools\
 */
export function toRelativeProjectPath(activeFolderPath: string, fullPath: string): string {
  const sep = activeFolderPath.includes("\\") ? "\\" : "/";
  const parentIdx = activeFolderPath.lastIndexOf(sep);
  if (parentIdx >= 0) {
    const parent = activeFolderPath.substring(0, parentIdx + 1);
    if (fullPath.startsWith(parent)) {
      return fullPath.substring(parent.length);
    }
  }
  return fullPath;
}

export interface GitFileEntry {
  path: string;
  status: string;
  staged: boolean;
}

/**
 * Parse `git status --porcelain=v1` output into GitFileEntry[].
 *
 * Porcelain format: XY <path> or XY <old> -> <new> for renames/copies.
 * X = staging area status, Y = working tree status.
 * Space means unchanged in that area.
 */
export function parseStatusPorcelain(output: string): GitFileEntry[] {
  const entries: GitFileEntry[] = [];
  if (!output.trim()) return entries;

  for (const line of output.split("\n")) {
    if (line.length < 3) continue;

    const x = line[0]; // staging area
    const y = line[1]; // working tree
    let filePath = line.slice(3);

    // Handle renames/copies: "R  old -> new" or "C  old -> new"
    const arrowIdx = filePath.indexOf(" -> ");
    if (arrowIdx !== -1) {
      filePath = filePath.slice(arrowIdx + 4);
    }

    // Staged entry (X is non-space and not '?')
    if (x !== " " && x !== "?") {
      entries.push({ path: filePath, status: x, staged: true });
    }

    // Unstaged entry (Y is non-space)
    if (y !== " ") {
      // Untracked: both X and Y are '?'
      const status = x === "?" && y === "?" ? "??" : y;
      entries.push({ path: filePath, status, staged: false });
    }
  }

  return entries;
}

/**
 * Parse `git branch -a --no-color` output.
 * Returns { current, branches } where branches includes local and remote names.
 */
export function parseBranchList(output: string): {
  current: string;
  branches: string[];
} {
  let current = "";
  const branches: string[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip HEAD reference lines like "remotes/origin/HEAD -> origin/main"
    if (trimmed.includes("->")) continue;

    const isCurrent = trimmed.startsWith("* ");
    const name = isCurrent ? trimmed.slice(2) : trimmed;

    // Strip "remotes/origin/" prefix for remote branches
    const displayName = name.replace(/^remotes\/origin\//, "");

    if (isCurrent) {
      current = displayName;
    }

    // Avoid duplicates (local and remote with same name)
    if (!branches.includes(displayName)) {
      branches.push(displayName);
    }
  }

  return { current, branches };
}

export interface RawCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  parents: string[];
  refs: string[];
}

/**
 * Parse output from git log --format="<hash>%H<author>%an<date>%aI<message>%s<parents>%P<refs>%D"
 */
export function parseLogOutput(output: string): RawCommit[] {
  const commits: RawCommit[] = [];
  if (!output.trim()) return commits;

  for (const line of output.split("\n")) {
    if (!line.includes("<hash>")) continue;

    const extract = (tag: string, nextTag: string): string => {
      const start = line.indexOf(`<${tag}>`) + tag.length + 2;
      const end = line.indexOf(`<${nextTag}>`);
      return end > start ? line.slice(start, end) : "";
    };

    const hash = extract("hash", "author");
    const author = extract("author", "date");
    const date = extract("date", "message");
    const message = extract("message", "parents");
    const parentsStr = extract("parents", "refs");
    const refsStart = line.indexOf("<refs>") + 6;
    const refsStr = refsStart > 6 ? line.slice(refsStart) : "";

    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      author,
      date,
      message,
      parents: parentsStr.trim() ? parentsStr.trim().split(" ") : [],
      refs: refsStr.trim()
        ? refsStr.split(",").map((r) => r.trim()).filter(Boolean)
        : [],
    });
  }

  return commits;
}

export interface CommitFileEntry {
  status: string;
  path: string;
}

/**
 * Parse output from git diff-tree --no-commit-id --name-status -r <hash>
 */
export function parseDiffTree(output: string): CommitFileEntry[] {
  const entries: CommitFileEntry[] = [];
  if (!output.trim()) return entries;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "M\tpath/to/file" or "A\tpath/to/file"
    const tabIdx = trimmed.indexOf("\t");
    if (tabIdx === -1) continue;
    entries.push({
      status: trimmed.slice(0, tabIdx),
      path: trimmed.slice(tabIdx + 1),
    });
  }

  return entries;
}

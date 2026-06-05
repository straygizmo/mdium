// .opencode/tools/folder_glob.ts
//
// Folder-scoped glob for the built-in `rag` agent. opencode's own glob escapes
// the open folder when it is not a git repo (its worktree collapses to "/"), so
// this tool delegates to the running mdium app over its local HTTP bridge. mdium
// always searches ONLY the folder currently open in the active tab — never its
// parents or other folders.
import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

async function readBridgeInfo(): Promise<{ port: number; token: string } | null> {
  const path = join(homedir(), ".config", "opencode", ".mdium-bridge.json");
  try {
    const info = JSON.parse(await readFile(path, "utf-8"));
    if (typeof info?.port === "number" && typeof info?.token === "string") return info;
    return null;
  } catch {
    return null;
  }
}

export default tool({
  description:
    "Find files by glob pattern within the folder currently open in mdium (the " +
    "active tab's folder). Always scoped to that folder — never its parents or " +
    "other folders. Use after rag_search to locate additional files by name.",
  args: {
    pattern: tool.schema
      .string()
      .describe(
        "Glob pattern, e.g. '**/*.md' or 'report-*.txt'. '**' matches any depth; " +
          "a pattern with no '/' matches by file name at any depth."
      ),
    limit: tool.schema.number().optional().describe("Max files to return (default 1000)."),
  },
  async execute(args) {
    const bridge = await readBridgeInfo();
    if (!bridge) {
      return "Cannot reach mdium (no active connection). Open the mdium app and connect opencode for this folder.";
    }
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${bridge.port}/glob`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ pattern: args.pattern, limit: args.limit }),
      });
    } catch (e: any) {
      return `Failed to reach mdium: ${e?.message ?? e}.`;
    }
    let data: any;
    try {
      data = await res.json();
    } catch {
      return `mdium returned a non-JSON response (HTTP ${res.status}).`;
    }
    if (!res.ok || data?.ok === false) {
      return `glob failed: ${data?.error ?? `HTTP ${res.status}`}`;
    }
    const files: string[] = data?.files ?? [];
    if (files.length === 0) return `No files match "${args.pattern}" in the open folder.`;
    return files.join("\n");
  },
});

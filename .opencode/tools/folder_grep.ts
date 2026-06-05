// .opencode/tools/folder_grep.ts
//
// Folder-scoped grep for the built-in `rag` agent. Delegates to the running
// mdium app over its local HTTP bridge, which searches ONLY the folder currently
// open in the active tab — never its parents or other folders.
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
    "Search file contents by regular expression within the folder currently open " +
    "in mdium (the active tab's folder). Always scoped to that folder — never its " +
    "parents or other folders. Use after rag_search for exact keyword matches.",
  args: {
    pattern: tool.schema.string().describe("Regular expression to search for in file contents."),
    include: tool.schema
      .string()
      .optional()
      .describe("Optional glob to limit which files are searched, e.g. '**/*.md'."),
    case_insensitive: tool.schema
      .boolean()
      .optional()
      .describe("Match case-insensitively. Defaults to false."),
    limit: tool.schema.number().optional().describe("Max matches to return (default 500)."),
  },
  async execute(args) {
    const bridge = await readBridgeInfo();
    if (!bridge) {
      return "Cannot reach mdium (no active connection). Open the mdium app and connect opencode for this folder.";
    }
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${bridge.port}/grep`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({
          pattern: args.pattern,
          include: args.include,
          case_insensitive: args.case_insensitive,
          limit: args.limit,
        }),
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
      return `grep failed: ${data?.error ?? `HTTP ${res.status}`}`;
    }
    const matches: Array<{ file: string; line_number: number; line: string }> = data?.matches ?? [];
    if (matches.length === 0) return `No matches for "${args.pattern}" in the open folder.`;
    return matches.map((m) => `${m.file}:${m.line_number}: ${m.line}`).join("\n");
  },
});

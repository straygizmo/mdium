// .opencode/tools/rag_search.ts
//
// Thin client for mdium's RAG search. Instead of embedding the query itself
// (which would require @huggingface/transformers + the model weights inside the
// opencode runtime), this tool delegates to the running mdium app over its local
// HTTP bridge. mdium embeds the query with the user's *configured* model and runs
// the same hybrid (vector + BM25) search as the in-app RAG panel, then returns
// the results. This keeps the tool dependency-free and always consistent with
// the app's settings.
import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

interface BridgeInfo {
  port: number;
  token: string;
}

// mdium writes this sidecar on every opencode connection (port/token change per
// run). It lives at the global opencode config root regardless of where this
// tool file is installed, so resolve it from the home directory.
async function readBridgeInfo(): Promise<BridgeInfo | null> {
  const path = join(homedir(), ".config", "opencode", ".mdium-bridge.json");
  try {
    const raw = await readFile(path, "utf-8");
    const info = JSON.parse(raw);
    if (typeof info?.port === "number" && typeof info?.token === "string") {
      return info as BridgeInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export default tool({
  description:
    "Search the RAG index for documents relevant to a query. Delegates to the " +
    "running mdium app, which embeds the query with the user's configured model " +
    "and runs hybrid (vector + BM25) search over the project's .mdium indexes — " +
    "the same ranking as the mdium RAG panel. Returns matching chunks with file " +
    "path, heading, content, line number, and relevance score.",
  args: {
    query: tool.schema.string().describe("The search query"),
    search_mode: tool.schema
      .string()
      .optional()
      .describe(
        "'hybrid' fuses vector similarity with BM25 keyword ranking; 'vector' " +
          "uses embedding similarity only. Defaults to the app's configured mode."
      ),
    bm25_weight: tool.schema
      .number()
      .optional()
      .describe(
        "Hybrid mode only: weight of the BM25 keyword rank vs the vector rank, " +
          "0.0-1.0. Defaults to the app's configured value. Higher favors keywords."
      ),
    top_k: tool.schema
      .number()
      .optional()
      .describe("Number of top results to return. Defaults to the app's configured value."),
  },
  async execute(args, context) {
    const bridge = await readBridgeInfo();
    if (!bridge) {
      return (
        "Cannot reach mdium (no active connection). Make sure the mdium app is " +
        "open and connected to opencode for this folder.\n" +
        "Falling back: use the built-in file search tools (glob, grep, read)."
      );
    }

    let res: Response;
    try {
      // Bound the call so the tool never hangs if mdium is unreachable. The
      // bridge resolves within ~120s even on a slow first model load.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 150_000);
      try {
        res = await fetch(`http://127.0.0.1:${bridge.port}/rag/search`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bridge.token}`,
          },
          body: JSON.stringify({
            folder_path: context.worktree,
            query: args.query,
            limit: args.top_k,
            search_mode: args.search_mode,
            bm25_weight: args.bm25_weight,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e: any) {
      return (
        `Failed to reach mdium RAG bridge: ${e?.message ?? e}.\n` +
        "Make sure the mdium app is open. Falling back: use glob, grep, read."
      );
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      return `mdium RAG bridge returned a non-JSON response (HTTP ${res.status}).`;
    }

    if (!res.ok || data?.ok === false) {
      const msg = data?.error ?? `HTTP ${res.status}`;
      return `RAG search failed: ${msg}\nFalling back: use glob, grep, read.`;
    }

    const results = data?.results ?? [];
    if (results.length === 0) {
      return (
        `No documents found related to "${args.query}".\n` +
        "Try searching directly with the built-in file search tools (glob, grep, read)."
      );
    }

    return JSON.stringify(results, null, 2);
  },
});

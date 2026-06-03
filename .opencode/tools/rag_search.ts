// .opencode/tools/rag_search.ts
import { tool } from "@opencode-ai/plugin";

// ─── Lazy-loaded dependencies ───
let Database: any = null;
let pipelineInstance: any = null;
let loadedModelName: string | null = null;

// Model short name → HuggingFace model ID
const MODEL_MAP: Record<string, string> = {
  "multilingual-e5-large": "Xenova/multilingual-e5-large",
  "multilingual-e5-base": "Xenova/multilingual-e5-base",
  "multilingual-e5-small": "Xenova/multilingual-e5-small",
  "ruri-v3-30m-ONNX": "sirasagi62/ruri-v3-30m-ONNX",
  "ruri-v3-130m-ONNX": "sirasagi62/ruri-v3-130m-ONNX",
};

function resolveModelName(shortName: string): string {
  return MODEL_MAP[shortName] ?? `Xenova/${shortName}`;
}

function getPrefix(modelName: string, type: "query" | "passage"): string {
  if (modelName.includes("ruri")) {
    return type === "query" ? "Search query: " : "Search document: ";
  }
  return type === "query" ? "query: " : "passage: ";
}

async function getEmbedding(text: string, modelName: string): Promise<number[]> {
  if (!pipelineInstance || loadedModelName !== modelName) {
    const { pipeline } = await import("@huggingface/transformers");
    pipelineInstance = await pipeline("feature-extraction", modelName, {
      dtype: "q8",
    } as any);
    loadedModelName = modelName;
  }
  const prefix = getPrefix(modelName, "query");
  const result = await pipelineInstance(`${prefix}${text}`, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(result.data as Float32Array);
}

function cosineSimilarity(a: number[], b: Float64Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface SearchResult {
  file: string;
  heading: string;
  content: string;
  line_number: number;
  score: number;
  db_source: string;
}

function searchDb(
  dbPath: string,
  queryEmbedding: number[],
  topK: number,
  minScore: number
): SearchResult[] {
  if (!Database) {
    Database = require("bun:sqlite").Database;
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }

  try {
    const rows = db
      .query("SELECT file, heading, text, line, embedding FROM chunks WHERE embedding IS NOT NULL")
      .all() as { file: string; heading: string; text: string; line: number; embedding: Buffer }[];

    const results: SearchResult[] = [];
    for (const row of rows) {
      const buf = row.embedding;
      const embedding = new Float64Array(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength / 8
      );
      const score = cosineSimilarity(queryEmbedding, embedding);
      if (score >= minScore) {
        results.push({
          file: row.file,
          heading: row.heading,
          content: row.text,
          line_number: row.line,
          score: Math.round(score * 1000) / 1000,
          db_source: dbPath,
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function findRagDbs(rootDir: string): Promise<Map<string, string[]>> {
  const { readdir } = await import("fs/promises");
  const { join } = await import("path");
  const dbsByModel = new Map<string, string[]>();

  async function scan(dir: string, depth: number) {
    if (depth > 10) return;

    // Check for .mdium directory
    const mdiumDir = join(dir, ".mdium");
    try {
      const files = await readdir(mdiumDir);
      for (const file of files) {
        if (file.startsWith("rag_") && file.endsWith(".db")) {
          const modelShort = file.slice(4, -3); // "rag_xxx.db" → "xxx"
          const dbPath = join(mdiumDir, file);
          if (!dbsByModel.has(modelShort)) dbsByModel.set(modelShort, []);
          dbsByModel.get(modelShort)!.push(dbPath);
        }
      }
    } catch {
      // .mdium dir doesn't exist — skip
    }

    // Recurse into subdirectories
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          entry.name !== "node_modules" &&
          entry.name !== "target"
        ) {
          await scan(join(dir, entry.name), depth + 1);
        }
      }
    } catch {
      // permission error etc — skip
    }
  }

  await scan(rootDir, 0);
  return dbsByModel;
}

export default tool({
  description:
    "Search the RAG vector database for documents relevant to a query. " +
    "Searches across all indexed folders and subfolders in the project. " +
    "Returns matching document chunks with file path, heading, content, line number, and relevance score.",
  args: {
    query: tool.schema.string().describe("The search query"),
    top_k: tool.schema
      .number()
      .optional()
      .describe("Number of top results to return (default: 5)"),
    min_score: tool.schema
      .number()
      .optional()
      .describe("Minimum similarity score threshold 0.0-1.0 (default: 0.1)"),
  },
  async execute(args, context) {
    const topK = args.top_k ?? 5;
    const minScore = args.min_score ?? 0.1;
    const rootDir = context.worktree;

    // Find all RAG databases grouped by model
    const dbsByModel = await findRagDbs(rootDir);

    if (dbsByModel.size === 0) {
      return (
        "RAG index not found. Please use built-in file search tools (glob, grep, read) to search instead.\n" +
        "For better accuracy, create an index via the RAG settings in mdium."
      );
    }

    // Search across all DBs, grouped by model
    const allResults: SearchResult[] = [];
    const warnings: string[] = [];
    for (const [modelShort, dbPaths] of dbsByModel) {
      const modelName = resolveModelName(modelShort);
      let queryEmbedding: number[];
      try {
        queryEmbedding = await getEmbedding(args.query, modelName);
      } catch (e: any) {
        warnings.push(`Failed to load model "${modelName}" (skipped ${dbPaths.length} DB(s)): ${e.message ?? e}`);
        continue;
      }

      for (const dbPath of dbPaths) {
        const results = searchDb(dbPath, queryEmbedding, topK, minScore);
        allResults.push(...results);
      }
    }

    // Sort all results by score and take top K
    allResults.sort((a, b) => b.score - a.score);
    const topResults = allResults.slice(0, topK);

    const warningText = warnings.length > 0 ? "\n\n⚠️ " + warnings.join("\n⚠️ ") : "";

    if (topResults.length === 0) {
      return (
        `No documents found related to "${args.query}" (min_score: ${minScore}).\n` +
        "Try searching directly with built-in file search tools (glob, grep, read)." +
        warningText
      );
    }

    return JSON.stringify(topResults, null, 2) + warningText;
  },
});

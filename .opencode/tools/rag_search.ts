// .opencode/tools/rag_search.ts
import { tool } from "@opencode-ai/plugin";

// ─── Lazy-loaded dependencies ───
let Database: any = null;
let pipelineInstance: any = null;
let loadedModelName: string | null = null;

// RRF constant — must match RRF_K in src-tauri/src/commands/rag.rs so the agent
// tool and the in-app panel rank hybrid results identically.
const RRF_K = 60;

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

// Build an FTS5 MATCH query from free text for the trigram tokenizer.
//
// Splits on whitespace, keeps terms of >= 3 Unicode code points (the trigram
// tokenizer needs at least 3 characters to index), wraps each term in double
// quotes (doubling any embedded quote to escape it), and joins with `OR`.
// Returns null when no term qualifies, so the caller can skip BM25 entirely.
// Mirrors build_fts_query in src-tauri/src/commands/rag.rs.
function buildFtsQuery(queryText: string): string | null {
  const terms = queryText
    .split(/\s+/)
    .filter((t) => t.length > 0)
    // [...t].length counts Unicode code points, matching Rust's chars().count().
    .filter((t) => [...t].length >= 3)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return terms.length === 0 ? null : terms.join(" OR ");
}

interface Candidate {
  file: string;
  heading: string;
  content: string;
  line_number: number;
  cosine: number;
  bm25: number | null;
  db_source: string;
}

// Reciprocal Rank Fusion of a vector score (cosine, larger = better) and an
// optional BM25 score (smaller = better, per SQLite bm25()). Returns
// {index, score} pairs sorted by fused score descending, truncated to `limit`.
// `bm25Weight` in [0,1] splits weight between the two ranks (vector weight =
// 1 - bm25Weight). Items without a BM25 match contribute only the vector term.
// Mirrors fuse_rrf in src-tauri/src/commands/rag.rs.
function fuseRrf(
  items: { cosine: number; bm25: number | null }[],
  bm25Weight: number,
  k: number,
  limit: number
): { index: number; score: number }[] {
  const n = items.length;

  // Vector ranks: sort indices by cosine descending (1-based).
  const byCos = Array.from({ length: n }, (_, i) => i);
  byCos.sort((a, b) => items[b].cosine - items[a].cosine);
  const vecRank = new Array<number>(n).fill(0);
  byCos.forEach((idx, rank) => {
    vecRank[idx] = rank + 1;
  });

  // BM25 ranks: only matched items, ascending (smaller = better), 1-based.
  const byBm = Array.from({ length: n }, (_, i) => i).filter(
    (i) => items[i].bm25 !== null
  );
  byBm.sort((a, b) => (items[a].bm25 as number) - (items[b].bm25 as number));
  const bmRank = new Array<number>(n).fill(0); // 0 = no BM25 match
  byBm.forEach((idx, rank) => {
    bmRank[idx] = rank + 1;
  });

  const wV = 1 - bm25Weight;
  const wB = bm25Weight;
  const scored = Array.from({ length: n }, (_, i) => {
    let s = wV / (k + vecRank[i]);
    if (bmRank[i] > 0) s += wB / (k + bmRank[i]);
    return { index: i, score: s };
  });
  // Array.prototype.sort is stable in ECMAScript, so equal scores keep their
  // original index order — matching Rust's stable tie-breaking.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Collect every chunk in `dbPath` as a candidate with its cosine score, and fill
// in BM25 scores for the rows matching `ftsQuery` (if any). rowid is unique only
// within a single DB, so BM25 is resolved here before candidates from other DBs
// are appended. Mirrors search_collect_db in src-tauri/src/commands/rag.rs.
function collectDb(
  dbPath: string,
  queryEmbedding: number[],
  ftsQuery: string | null,
  out: Candidate[]
): void {
  if (!Database) {
    Database = require("bun:sqlite").Database;
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return;
  }

  try {
    const rows = db
      .query(
        "SELECT id, file, heading, text, line, embedding FROM chunks WHERE embedding IS NOT NULL"
      )
      .all() as {
      id: number;
      file: string;
      heading: string;
      text: string;
      line: number;
      embedding: Uint8Array;
    }[];

    // chunks.id (== chunks_fts rowid) → index into `out`, so the BM25 scores
    // resolved below can be attached to the right candidate.
    const rowidToIdx = new Map<number, number>();
    for (const row of rows) {
      const buf = row.embedding;
      const embedding = new Float64Array(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength / 8
      );
      const cosine = cosineSimilarity(queryEmbedding, embedding);
      rowidToIdx.set(row.id, out.length);
      out.push({
        file: row.file,
        heading: row.heading,
        content: row.text,
        line_number: row.line,
        cosine,
        bm25: null,
        db_source: dbPath,
      });
    }

    if (ftsQuery) {
      try {
        const matches = db
          .query(
            "SELECT rowid, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ?"
          )
          .all(ftsQuery) as { rowid: number; score: number }[];
        for (const m of matches) {
          const idx = rowidToIdx.get(m.rowid);
          if (idx !== undefined) out[idx].bm25 = m.score;
        }
      } catch {
        // FTS table missing (legacy DB) or BM25 unsupported — leave bm25 null so
        // this DB's candidates fall back to vector-only ranking.
      }
    }
  } catch {
    // Malformed/locked DB — skip it.
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
    "Defaults to hybrid search, fusing embedding (vector) similarity with BM25 " +
    "keyword ranking via Reciprocal Rank Fusion — the same ranking as the mdium " +
    "RAG panel. Returns matching document chunks with file path, heading, " +
    "content, line number, and relevance score.",
  args: {
    query: tool.schema.string().describe("The search query"),
    search_mode: tool.schema
      .string()
      .optional()
      .describe(
        "'hybrid' (default) fuses vector similarity with BM25 keyword ranking; " +
          "'vector' uses embedding cosine similarity only"
      ),
    bm25_weight: tool.schema
      .number()
      .optional()
      .describe(
        "Hybrid mode only: weight of the BM25 keyword rank vs the vector rank, " +
          "0.0-1.0 (default: 0.5). Higher favors exact keyword matches"
      ),
    top_k: tool.schema
      .number()
      .optional()
      .describe("Number of top results to return (default: 5)"),
    min_score: tool.schema
      .number()
      .optional()
      .describe(
        "Vector mode only: minimum cosine similarity threshold 0.0-1.0 " +
          "(default: 0.1). Ignored in hybrid mode, where scores are RRF scores"
      ),
  },
  async execute(args, context) {
    const topK = args.top_k ?? 5;
    const minScore = args.min_score ?? 0.1;
    // Default to hybrid, matching the in-app panel and the Rust rag_search command.
    const mode = args.search_mode === "vector" ? "vector" : "hybrid";
    const weight = Math.min(1, Math.max(0, args.bm25_weight ?? 0.5));
    const rootDir = context.worktree;

    // Only build an FTS query in hybrid mode; null disables BM25 collection.
    const ftsQuery = mode === "hybrid" ? buildFtsQuery(args.query) : null;

    // Find all RAG databases grouped by model
    const dbsByModel = await findRagDbs(rootDir);

    if (dbsByModel.size === 0) {
      return (
        "RAG index not found. Please use built-in file search tools (glob, grep, read) to search instead.\n" +
        "For better accuracy, create an index via the RAG settings in mdium."
      );
    }

    // Collect candidates across every DB. BM25 is resolved per-DB inside
    // collectDb (rowid is DB-local); cosine is computed with each model's query
    // embedding. The merged list is ranked globally afterwards.
    const candidates: Candidate[] = [];
    const warnings: string[] = [];
    for (const [modelShort, dbPaths] of dbsByModel) {
      const modelName = resolveModelName(modelShort);
      let queryEmbedding: number[];
      try {
        queryEmbedding = await getEmbedding(args.query, modelName);
      } catch (e: any) {
        warnings.push(
          `Failed to load model "${modelName}" (skipped ${dbPaths.length} DB(s)): ${e.message ?? e}`
        );
        continue;
      }

      for (const dbPath of dbPaths) {
        collectDb(dbPath, queryEmbedding, ftsQuery, candidates);
      }
    }

    const warningText =
      warnings.length > 0 ? "\n\n⚠️ " + warnings.join("\n⚠️ ") : "";

    // Hybrid only applies when an FTS query was built (>= 3-char terms present);
    // otherwise fall back to vector-only ranking, like the Rust command.
    const useHybrid = mode === "hybrid" && ftsQuery !== null;

    let topResults: {
      file: string;
      heading: string;
      content: string;
      line_number: number;
      score: number;
      db_source: string;
    }[];

    if (useHybrid) {
      const ranked = fuseRrf(
        candidates.map((c) => ({ cosine: c.cosine, bm25: c.bm25 })),
        weight,
        RRF_K,
        topK
      );
      topResults = ranked.map(({ index, score }) => {
        const c = candidates[index];
        return {
          file: c.file,
          heading: c.heading,
          content: c.content,
          line_number: c.line_number,
          // RRF scores are small; keep more precision than the cosine output.
          score: Math.round(score * 1e6) / 1e6,
          db_source: c.db_source,
        };
      });
    } else {
      // Vector-only ranking. min_score filters only when the caller explicitly
      // requested vector mode — a hybrid request that degraded to vector (no
      // qualifying FTS terms) keeps all candidates, matching the in-app panel.
      let vec = candidates.slice().sort((a, b) => b.cosine - a.cosine);
      if (mode === "vector") {
        vec = vec.filter((c) => c.cosine >= minScore);
      }
      topResults = vec.slice(0, topK).map((c) => ({
        file: c.file,
        heading: c.heading,
        content: c.content,
        line_number: c.line_number,
        score: Math.round(c.cosine * 1000) / 1000,
        db_source: c.db_source,
      }));
    }

    if (topResults.length === 0) {
      const hint =
        mode === "vector"
          ? `No documents found related to "${args.query}" (min_score: ${minScore}).\n`
          : `No documents found related to "${args.query}".\n`;
      return (
        hint +
        "Try searching directly with built-in file search tools (glob, grep, read)." +
        warningText
      );
    }

    return JSON.stringify(topResults, null, 2) + warningText;
  },
});

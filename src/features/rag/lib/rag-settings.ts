import type { RagSettings } from "@/shared/types";

/** Default RAG settings. Hybrid (vector + BM25) is on by default. */
export const DEFAULT_RAG_SETTINGS: RagSettings = {
  embeddingModel: "Xenova/multilingual-e5-base",
  minChunkLength: 0,
  fileExtensions: ".md",
  retrieveTopK: 5,
  retrieveMinScore: 0.1,
  searchMode: "hybrid",
  bm25Weight: 0.5,
};

/**
 * Merge persisted (possibly legacy) RAG settings over the defaults so that
 * fields added in later versions (searchMode, bm25Weight) always have a value.
 */
export function normalizeRagSettings(s?: Partial<RagSettings>): RagSettings {
  return { ...DEFAULT_RAG_SETTINGS, ...(s ?? {}) };
}

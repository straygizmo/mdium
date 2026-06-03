import type { RagSettings } from "@/shared/types";

type EmbeddingModel = RagSettings["embeddingModel"];

/** Default embedding model for non-Japanese UIs. */
const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = "Xenova/multilingual-e5-base";
/** Japanese-optimized embedding model (ruri-v3-30m). */
const JA_EMBEDDING_MODEL: EmbeddingModel = "sirasagi62/ruri-v3-30m-ONNX";

/** Default embedding model for the UI language: Japanese → ruri-v3-30m. */
export function defaultEmbeddingModelForLanguage(language?: string): EmbeddingModel {
  return language === "ja" ? JA_EMBEDDING_MODEL : DEFAULT_EMBEDDING_MODEL;
}

/** Default RAG settings. Hybrid (vector + BM25) is on by default. */
export const DEFAULT_RAG_SETTINGS: RagSettings = {
  embeddingModel: DEFAULT_EMBEDDING_MODEL,
  minChunkLength: 0,
  fileExtensions: ".md",
  retrieveTopK: 5,
  retrieveMinScore: 0.1,
  searchMode: "hybrid",
  bm25Weight: 0.5,
};

/**
 * Language-aware defaults: Japanese setups default to the ruri-v3-30m embedding
 * model, which handles Japanese far better than multilingual-e5.
 */
export function getDefaultRagSettings(language?: string): RagSettings {
  return {
    ...DEFAULT_RAG_SETTINGS,
    embeddingModel: defaultEmbeddingModelForLanguage(language),
  };
}

/**
 * Merge persisted (possibly legacy) RAG settings over the language-aware
 * defaults so that fields added in later versions (searchMode, bm25Weight)
 * always have a value, and fresh installs pick the language-appropriate model.
 * A persisted `embeddingModel` is always preserved (never overridden), so an
 * existing index is never invalidated by a default change.
 */
export function normalizeRagSettings(
  s?: Partial<RagSettings>,
  language?: string
): RagSettings {
  return { ...getDefaultRagSettings(language), ...(s ?? {}) };
}

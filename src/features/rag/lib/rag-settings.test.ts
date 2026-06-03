import { describe, it, expect } from "vitest";
import {
  DEFAULT_RAG_SETTINGS,
  normalizeRagSettings,
  getDefaultRagSettings,
  defaultEmbeddingModelForLanguage,
} from "./rag-settings";

describe("normalizeRagSettings", () => {
  it("fills hybrid defaults for legacy settings without the new fields", () => {
    const legacy = {
      embeddingModel: "Xenova/multilingual-e5-base",
      minChunkLength: 0,
      fileExtensions: ".md",
      retrieveTopK: 5,
      retrieveMinScore: 0.1,
    };
    const r = normalizeRagSettings(legacy as any);
    expect(r.searchMode).toBe("hybrid");
    expect(r.bm25Weight).toBe(0.5);
    expect(r.embeddingModel).toBe("Xenova/multilingual-e5-base");
  });

  it("preserves explicit values", () => {
    const r = normalizeRagSettings({ searchMode: "vector", bm25Weight: 0.8 } as any);
    expect(r.searchMode).toBe("vector");
    expect(r.bm25Weight).toBe(0.8);
  });

  it("returns the full default object for undefined input", () => {
    expect(normalizeRagSettings(undefined)).toEqual(DEFAULT_RAG_SETTINGS);
  });
});

describe("language-aware embedding default", () => {
  const RURI = "sirasagi62/ruri-v3-30m-ONNX";
  const E5 = "Xenova/multilingual-e5-base";

  it("defaults Japanese setups to ruri-v3-30m", () => {
    expect(defaultEmbeddingModelForLanguage("ja")).toBe(RURI);
    expect(getDefaultRagSettings("ja").embeddingModel).toBe(RURI);
    expect(normalizeRagSettings(undefined, "ja").embeddingModel).toBe(RURI);
  });

  it("defaults non-Japanese (and unknown) setups to multilingual-e5-base", () => {
    expect(defaultEmbeddingModelForLanguage("en")).toBe(E5);
    expect(defaultEmbeddingModelForLanguage(undefined)).toBe(E5);
    expect(getDefaultRagSettings("en").embeddingModel).toBe(E5);
    expect(normalizeRagSettings(undefined, "en").embeddingModel).toBe(E5);
  });

  it("never overrides a persisted embeddingModel, even for Japanese", () => {
    // An existing index must keep matching its model after a default change.
    expect(normalizeRagSettings({ embeddingModel: E5 } as any, "ja").embeddingModel).toBe(E5);
  });
});

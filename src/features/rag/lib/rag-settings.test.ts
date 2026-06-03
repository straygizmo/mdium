import { describe, it, expect } from "vitest";
import { DEFAULT_RAG_SETTINGS, normalizeRagSettings } from "./rag-settings";

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

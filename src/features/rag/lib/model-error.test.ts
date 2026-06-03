import { describe, it, expect } from "vitest";
import { classifyRagError } from "./model-error";

describe("classifyRagError", () => {
  it("returns null when there is no error", () => {
    expect(classifyRagError(null, null)).toBe(null);
  });
  it("detects a missing model from embedError", () => {
    expect(classifyRagError(null, "MODEL_MISSING")).toBe("modelMissing");
  });
  it("detects a missing model embedded in buildError text", () => {
    expect(classifyRagError("Error: MODEL_MISSING", null)).toBe("modelMissing");
  });
  it("prefers modelMissing over network", () => {
    expect(classifyRagError("MODEL_MISSING NETWORK_ERROR", null)).toBe("modelMissing");
  });
  it("detects network, download, engine, and generic", () => {
    expect(classifyRagError(null, "NETWORK_ERROR")).toBe("network");
    expect(classifyRagError("DOWNLOAD_ERROR:x", null)).toBe("download");
    expect(classifyRagError("ENGINE_CRASH:123", null)).toBe("engine");
    expect(classifyRagError("something else", null)).toBe("generic");
  });
});

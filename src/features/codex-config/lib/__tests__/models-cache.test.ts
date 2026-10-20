import { describe, expect, it } from "vitest";
import { parseCodexModels } from "../models-cache";

describe("parseCodexModels", () => {
  it("lists visible models ordered by priority with display names", () => {
    const raw = JSON.stringify({
      models: [
        { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", priority: 0 },
        { slug: "gpt-b", display_name: "Model B", visibility: "list", priority: 2 },
        { slug: "gpt-a", display_name: "", priority: 1 },
        { slug: "", display_name: "No slug" },
        "junk",
      ],
    });
    expect(parseCodexModels(raw)).toEqual([
      { slug: "gpt-a", displayName: "gpt-a" },
      { slug: "gpt-b", displayName: "Model B" },
    ]);
  });

  it("returns an empty list for malformed or unexpected input", () => {
    expect(parseCodexModels("not json")).toEqual([]);
    expect(parseCodexModels("{}")).toEqual([]);
    expect(parseCodexModels(JSON.stringify({ models: "x" }))).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { BUILTIN_COMMANDS } from "../builtin-commands";

describe("deploy-zenn-article frontmatter completion", () => {
  const tpl = BUILTIN_COMMANDS["deploy-zenn-article"].template;

  it("declares all required Zenn frontmatter fields", () => {
    const requiredLine = tpl.split("\n").find((l) => l.includes("Required fields:"));
    expect(requiredLine).toBeDefined();
    for (const field of ["title", "emoji", "type", "topics", "published"]) {
      expect(requiredLine).toContain(field);
    }
  });

  it("instructs inferring missing fields from the article body and confirming with the user", () => {
    const lower = tpl.toLowerCase();
    expect(lower).toContain("infer");
    expect(lower).toMatch(/confirm|correct/);
  });

  it("defaults published to false and never auto-publishes", () => {
    expect(tpl.toLowerCase()).toMatch(/default[^.]*false/);
  });

  it("writes the completed frontmatter back to both source and deploy targets", () => {
    expect(tpl).toContain("work/{slug}/index.md");
    expect(tpl).toContain("articles/{slug}.md");
  });
});

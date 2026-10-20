import { describe, it, expect } from "vitest";
import { BUILTIN_AGENTS, BUILTIN_CUSTOM_TOOLS } from "../builtin-registry";

describe("builtin RAG index tools", () => {
  for (const name of ["rag_status", "convert_office_docs", "rag_update_index"]) {
    it(`registers ${name}`, () => {
      const entry = BUILTIN_CUSTOM_TOOLS[name];
      expect(entry).toBeDefined();
      expect(entry.fileName).toBe(`${name}.ts`);
      expect(entry.content).toContain("mdium-tool-version: 1");
    });
  }

  it("requires all RAG tools in the rag agent", () => {
    const req = BUILTIN_AGENTS.rag.requiredBuiltinTools ?? [];
    for (const n of ["rag_search", "rag_status", "convert_office_docs", "rag_update_index"]) {
      expect(req).toContain(n);
    }
  });

  it("rag agent prompt is v3 and teaches the office-docs procedure", () => {
    const md = BUILTIN_AGENTS.rag.agentMd;
    expect(md).toContain("mdium-agent-version: 3");
    expect(md).toContain("rag_status");
    expect(md).toContain("## Office documents and index");
    for (const n of ["rag_status", "convert_office_docs", "rag_update_index"]) {
      expect(md).toContain(`  ${n}: true`);
    }
  });
});

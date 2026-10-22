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

  it("rag agent prompt orders rag_status before rag_search", () => {
    const md = BUILTIN_AGENTS.rag.agentMd;
    expect(md).not.toContain("rag_search\`: ALWAYS call this first");
    expect(md).not.toContain("ALWAYS call this first");
    expect(md).toContain("FIRST tool call MUST be \`rag_status\`");
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

describe("builtin VBA run tools", () => {
  for (const name of ["vba_run", "xlsx_read"]) {
    it(`registers ${name}`, () => {
      const entry = BUILTIN_CUSTOM_TOOLS[name];
      expect(entry).toBeDefined();
      expect(entry.fileName).toBe(`${name}.ts`);
      expect(entry.content).toContain("mdium-tool-version: 1");
    });
  }
  it("vba_run posts to /vba/run with an abort signal covering approval and run", () => {
    const src = BUILTIN_CUSTOM_TOOLS.vba_run.content;
    expect(src).toContain("/vba/run");
    expect(src).toContain("AbortSignal.timeout(");
    expect(src).toContain("allow_side_effects");
  });
  it("vba_run tells the agent not to retry when its own timeout fires", () => {
    const src = BUILTIN_CUSTOM_TOOLS.vba_run.content;
    expect(src).toContain('e?.name === "TimeoutError"');
    expect(src).toContain("did not finish within the client timeout");
  });
  it("xlsx_read posts to /xlsx/read", () => {
    expect(BUILTIN_CUSTOM_TOOLS.xlsx_read.content).toContain("/xlsx/read");
  });
});

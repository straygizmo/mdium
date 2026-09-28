// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMcpLine, handleMcpMessage, TOOL_NAME } from "../mcp-server";
import { buildPptx } from "./fixtures";

let dir: string;
let deck: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdium-mcp-"));
  deck = path.join(dir, "deck.pptx");
  fs.writeFileSync(deck, await buildPptx());
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(args: unknown) {
  return handleMcpMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: TOOL_NAME, arguments: args } });
}

function textOf(response: unknown): { text: string; isError?: boolean } {
  const result = (response as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { text: result.content[0].text, isError: result.isError };
}

describe("mdium-docs MCP server", () => {
  it("negotiates a supported protocol version and advertises tools", async () => {
    const init = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    const unknownVersion = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((unknownVersion as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
  });

  it("ignores notifications and rejects unknown methods", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await handleMcpLine("{not json")).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it("lists the convert_to_markdown tool", async () => {
    const list = await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    const tools = (list as { result: { tools: { name: string; inputSchema: { required: string[] } }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual([TOOL_NAME]);
    expect(tools[0].inputSchema.required).toEqual(["path"]);
  });

  it("returns the Markdown of a document", async () => {
    const { text, isError } = textOf(await call({ path: deck }));
    expect(isError).toBeUndefined();
    expect(text).toContain("## Roadmap");
  });

  it("truncates to max_chars and says so", async () => {
    const { text } = textOf(await call({ path: deck, max_chars: 5 }));
    expect(text.startsWith("## Ro")).toBe(true);
    expect(text).toContain("Truncated");
  });

  it("writes the Markdown when output_path is given", async () => {
    const out = path.join(dir, "out", "deck.md");
    const { text } = textOf(await call({ path: deck, output_path: out }));
    expect(text).toContain(`Markdown written to ${out}`);
    expect(fs.readFileSync(out, "utf8")).toContain("## Roadmap");
  });

  it("reports bad input as a tool error", async () => {
    expect(textOf(await call({ path: "relative.docx" })).isError).toBe(true);
    const missing = textOf(await call({ path: path.join(dir, "missing.docx") }));
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("Conversion failed");
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "other" } })).toMatchObject({
      error: { code: -32602 },
    });
  });
});

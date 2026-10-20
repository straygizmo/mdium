// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMcpHandler, toolText } from "../jsonrpc-server";

const tools = [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }];

function make() {
  const callTool = vi.fn(async (_name: string, args: unknown) => toolText(JSON.stringify(args)));
  const handler = createMcpHandler({
    serverName: "test",
    serverVersion: "1.2.3",
    listTools: () => tools,
    callTool,
  });
  return { handler, callTool };
}

describe("createMcpHandler", () => {
  it("echoes a supported protocol version on initialize", async () => {
    const { handler } = make();
    const res = await handler.handleMcpMessage({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" },
    });
    expect(res).toEqual({
      jsonrpc: "2.0", id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "test", version: "1.2.3" },
      },
    });
  });

  it("falls back to 2025-06-18 for an unknown protocol version", async () => {
    const { handler } = make();
    const res = await handler.handleMcpMessage({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" },
    });
    expect((res as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
  });

  it("answers ping with an empty result", async () => {
    const { handler } = make();
    expect(await handler.handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({
      jsonrpc: "2.0", id: 2, result: {},
    });
  });

  it("returns listTools() from tools/list", async () => {
    const { handler } = make();
    expect(await handler.handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" })).toEqual({
      jsonrpc: "2.0", id: 3, result: { tools },
    });
  });

  it("routes tools/call to callTool with params.arguments", async () => {
    const { handler, callTool } = make();
    const res = await handler.handleMcpMessage({
      jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { a: 1 } },
    });
    expect(callTool).toHaveBeenCalledWith("echo", { a: 1 });
    expect(res).toEqual({ jsonrpc: "2.0", id: 4, result: toolText('{"a":1}') });
  });

  it("returns -32602 for an unknown tool", async () => {
    const { handler, callTool } = make();
    const res = await handler.handleMcpMessage({
      jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" },
    });
    expect(res).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32602, message: "Unknown tool: nope" } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("returns -32601 for an unknown method", async () => {
    const { handler } = make();
    const res = await handler.handleMcpMessage({ jsonrpc: "2.0", id: 6, method: "foo/bar" });
    expect(res).toEqual({ jsonrpc: "2.0", id: 6, error: { code: -32601, message: "Method not found: foo/bar" } });
  });

  it("returns -32600 with null id for a non-object message", async () => {
    const { handler } = make();
    expect(await handler.handleMcpMessage(42)).toEqual({
      jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" },
    });
  });

  it("returns undefined for a notification", async () => {
    const { handler } = make();
    expect(await handler.handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });

  it("returns -32700 for a line that is not JSON", async () => {
    const { handler } = make();
    expect(await handler.handleMcpLine("{not json")).toEqual({
      jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" },
    });
  });

  it("handles a valid JSON line", async () => {
    const { handler } = make();
    const res = await handler.handleMcpLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }));
    expect(res).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });
});

describe("toolText", () => {
  it("marks errors only when asked", () => {
    expect(toolText("ok")).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(toolText("bad", true)).toEqual({ content: [{ type: "text", text: "bad" }], isError: true });
  });
});

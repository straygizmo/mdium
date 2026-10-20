// Entry point of the bundled mdium-rag MCP server
// (resources/mcp-servers/mdium-rag/dist/index.js, built by scripts/build-rag-mcp.mjs).
import { runStdioServer } from "../mcp-lib/stdio";
import { createRagServer } from "./mcp-server";

runStdioServer(createRagServer().handleMcpLine);

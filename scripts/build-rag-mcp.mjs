// scripts/build-rag-mcp.mjs
// Bundles the mdium-rag MCP server (sidecar/rag-mcp/mcp-main.ts) into one ESM
// file that MDium ships under resources/mcp-servers/ and runs with `node <path>`.
import { build } from "esbuild";

await build({
  entryPoints: ["sidecar/rag-mcp/mcp-main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "resources/mcp-servers/mdium-rag/dist/index.js",
  // Some bundled CJS dependencies call require() for Node built-ins; provide it in ESM.
  banner: {
    js: 'import { createRequire as createRagRequire } from "node:module"; const require = createRagRequire(import.meta.url);',
  },
  logLevel: "info",
});

// scripts/build-doc-converter.mjs
// Bundles the mdium-docs MCP server (sidecar/doc-converter/mcp-main.ts) and the
// shared Office/PDF -> Markdown converters into one ESM file that MDium ships
// under resources/mcp-servers/ and runs with `node <path>`.
import { build } from "esbuild";

await build({
  entryPoints: ["sidecar/doc-converter/mcp-main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "resources/mcp-servers/mdium-docs/dist/index.js",
  // Some bundled CJS dependencies call require() for Node built-ins; provide it in ESM.
  banner: {
    js: 'import { createRequire as createDocsRequire } from "node:module"; const require = createDocsRequire(import.meta.url);',
  },
  logLevel: "info",
});

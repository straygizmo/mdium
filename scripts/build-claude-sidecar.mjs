// scripts/build-claude-sidecar.mjs
// Bundles sidecar/claude-sidecar.ts (plus sidecar-core.ts, resolve-claude.ts,
// and the real @anthropic-ai/claude-agent-sdk) into a single CommonJS file
// that Tauri ships as a resource and spawns with `node <path>`.
import { build } from "esbuild";

await build({
  entryPoints: ["sidecar/claude-sidecar.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "resources/claude-sidecar/claude-sidecar.cjs",
  // The SDK's per-platform native binary packages must not be bundled;
  // we always pass pathToClaudeCodeExecutable so they are never loaded.
  external: ["@anthropic-ai/claude-agent-sdk-*"],
  // The SDK (built as ESM) uses `import.meta.url` (e.g. for
  // `createRequire(import.meta.url)`). esbuild's CJS output leaves that
  // expression as an unset `import_meta.url` reference, which throws at
  // runtime. Redirect it to a banner-defined shim that resolves to this
  // bundle's own file:// URL, matching what `import.meta.url` would have
  // been if the bundle were still ESM.
  define: {
    "import.meta.url": "importMetaUrl",
  },
  banner: {
    js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
  logLevel: "info",
});

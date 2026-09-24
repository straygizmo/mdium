// scripts/build-agent-runner.mjs
// Bundles sidecar/agent-runner/main.ts (with the Codex and Copilot SDKs) into a
// single ESM file that Tauri ships as a resource and spawns with `node <path>`.
// The provider CLIs themselves are NOT bundled; the runner uses the user's install.
import { build } from "esbuild";

await build({
  entryPoints: ["sidecar/agent-runner/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "resources/agent-runner/agent-runner.mjs",
  // koffi is only needed by the Copilot SDK's in-process transport, which we do not use.
  external: ["koffi", "@github/copilot-sdk-*", "@openai/codex-*"],
  // Some bundled CJS dependencies call require() for Node built-ins; provide it in ESM.
  banner: {
    js: 'import { createRequire as createRunnerRequire } from "node:module"; const require = createRunnerRequire(import.meta.url);',
  },
  logLevel: "info",
});

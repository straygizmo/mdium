// scripts/build-agent-runner.mjs
// Bundles sidecar/agent-runner/main.ts (with the Codex and Copilot SDKs) into a
// single ESM file that Tauri ships as a resource and spawns with `node <path>`.
// The provider CLIs themselves are NOT bundled; the runner uses the user's install.
import { build } from "esbuild";

// koffi is a native-binary FFI package used only by the Copilot SDK's
// in-process transport (ffiRuntimeHost.js), which this runner never uses
// (we always connect over stdio via RuntimeConnection.forStdio). It is
// statically imported there, so esbuild would otherwise bundle a hard
// `import koffi from "koffi"` that fails to resolve once the bundle is
// copied outside this repo's node_modules. Replace it with an empty stub
// module instead of leaving it external.
const stubKoffi = {
  name: "stub-koffi",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^koffi$/ }, () => ({ path: "koffi-stub", namespace: "koffi-stub" }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "koffi-stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["sidecar/agent-runner/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "resources/agent-runner/agent-runner.mjs",
  plugins: [stubKoffi],
  // Only the per-platform native binary packages must stay external: both
  // SDKs resolve them by a runtime-computed module name only inside their
  // own path-lookup fallback, which is never reached because the adapters
  // always pass an explicit CLI path (codexPathOverride / RuntimeConnection
  // path). A glob like "@openai/codex-*" would also match "@openai/codex-sdk"
  // itself (the SDK entry point), leaving it unresolved outside this repo;
  // scope the globs to the platform suffixes only.
  external: [
    "@openai/codex-win32-*",
    "@openai/codex-linux-*",
    "@openai/codex-darwin-*",
    "@github/copilot-sdk-win32-*",
    "@github/copilot-sdk-linux-*",
    "@github/copilot-sdk-darwin-*",
  ],
  // Some bundled CJS dependencies call require() for Node built-ins; provide it in ESM.
  banner: {
    js: 'import { createRequire as createRunnerRequire } from "node:module"; const require = createRunnerRequire(import.meta.url);',
  },
  logLevel: "info",
});

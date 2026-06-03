import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "node:fs";

// Serve the onnxruntime-web WASM backend (the exact version bundled with
// @huggingface/transformers) from the app's own local origin at `/ort/` instead
// of the jsDelivr CDN, so model loading works on a network-restricted machine.
//
// ORT loads its `.mjs` glue via a dynamic `import()`. Vite dev cannot serve
// `public/` assets through `import()` (it rewrites the request to `?import` and
// resolves it through the module graph, which 404s for public files). So this
// plugin serves `/ort/*` as a real dev-server route (configureServer) and emits
// the files into `dist/ort/` for the production build (generateBundle).
function ortWasm() {
  const files = [
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
  ];
  const srcDir = path.resolve(
    __dirname,
    "node_modules/@huggingface/transformers/dist"
  );
  const mimeFor = (name: string) =>
    name.endsWith(".wasm") ? "application/wasm" : "text/javascript";
  return {
    name: "ort-wasm",
    // Dev: serve /ort/<file> directly from node_modules. Registered here (not in
    // the returned post-hook) so it runs BEFORE Vite's module-transform
    // middleware and the dynamic import resolves to a real file, not the graph.
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (pathname.startsWith("/ort/")) {
          const name = pathname.slice("/ort/".length);
          if (files.includes(name)) {
            const full = path.join(srcDir, name);
            if (fs.existsSync(full)) {
              res.setHeader("Content-Type", mimeFor(name));
              fs.createReadStream(full).pipe(res);
              return;
            }
          }
        }
        next();
      });
    },
    // Build: emit the files into dist/ort/ so the production app serves them.
    generateBundle() {
      for (const f of files) {
        const src = path.join(srcDir, f);
        if (!fs.existsSync(src)) {
          throw new Error(`ort-wasm: missing source file ${src}`);
        }
        (this as any).emitFile({
          type: "asset",
          fileName: `ort/${f}`,
          source: fs.readFileSync(src),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), ortWasm()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  worker: {
    format: "es",
  },
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  optimizeDeps: {
    include: ["mermaid", "highlight.js", "docx", "marked", "katex", "monaco-editor"],
    exclude: [
      "@tauri-apps/api",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-fs",
      "@huggingface/transformers",
      "onnxruntime-web",
    ],
  },
  test: {
    // Exclude git worktrees under .claude/ so their duplicated test files are
    // not discovered alongside the real ones (which double-counts failures).
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});

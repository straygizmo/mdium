import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "node:fs";

// Copy the onnxruntime-web WASM backend (the exact version bundled with
// @huggingface/transformers) into public/ort so it is served from the app's
// own local origin instead of the jsDelivr CDN. Runs in both `vite` (dev) and
// `vite build` via the buildStart hook.
function copyOrtWasm() {
  const files = [
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
  ];
  const srcDir = path.resolve(
    __dirname,
    "node_modules/@huggingface/transformers/dist"
  );
  const destDir = path.resolve(__dirname, "public/ort");
  return {
    name: "copy-ort-wasm",
    buildStart() {
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of files) {
        const src = path.join(srcDir, f);
        if (!fs.existsSync(src)) {
          throw new Error(`copy-ort-wasm: missing source file ${src}`);
        }
        fs.copyFileSync(src, path.join(destDir, f));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyOrtWasm()],
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
});

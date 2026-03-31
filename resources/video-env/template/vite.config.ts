import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@open-motion/core": path.resolve(__dirname, "open-motion/core/src"),
      "@open-motion/components": path.resolve(__dirname, "open-motion/components/src"),
    },
  },
  // Prevent Vite from pre-bundling vendored open-motion packages from
  // node_modules — they are aliased to source directories and should go
  // through the normal transform pipeline instead.
  optimizeDeps: {
    exclude: ["@open-motion/core", "@open-motion/components"],
  },
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
});

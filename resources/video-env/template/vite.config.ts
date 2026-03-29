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
  server: {
    host: "127.0.0.1",
  },
});

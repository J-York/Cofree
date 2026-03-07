/**
 * Cofree - AI Programming Cafe
 * File: vite.config.ts
 * Milestone: 1
 * Task: 1.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Vite config for Tauri desktop development.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const toPosixPath = (id: string): string => id.replaceAll("\\", "/");


export default defineConfig(() => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2020", "chrome105", "safari13"],
    minify: process.env.TAURI_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = toPosixPath(id);

          if (normalizedId.includes("/src/orchestrator/")) {
            return "orchestrator";
          }

          if (
            normalizedId.includes("/node_modules/react-markdown/") ||
            normalizedId.includes("/node_modules/remark-gfm/")
          ) {
            return "markdown";
          }

          if (normalizedId.includes("/node_modules/")) {
            return "vendor";
          }

          return undefined;
        },
      },
    },
  }
}));

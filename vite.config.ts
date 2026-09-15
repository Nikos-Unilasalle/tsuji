import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  base: "./",
  plugins: [react()],

  // @xyflow/react pulls its own nested copy of react/react-dom as a
  // dependency (visible in `npm ls` even though npm dedupes it on disk) —
  // without this, Vite's dev-time dependency pre-bundler can resolve that
  // nested copy as a module instance distinct from the app's own, and every
  // hook inside ReactFlow throws "Invalid hook call" against the wrong
  // React. Forces one resolved instance regardless of which import path led
  // there.
  resolve: {
    dedupe: ["react", "react-dom"],
  },

  // Belt and suspenders alongside dedupe: force react/react-dom/@xyflow/react
  // into the SAME pre-bundle pass. A partial pre-bundle — some deps
  // optimized, others loaded as raw ESM straight from node_modules — is a
  // separate, well-documented way to end up with two live React module
  // instances even when dedupe is set and disk-level resolution is already
  // deduped.
  optimizeDeps: {
    include: ["react", "react-dom", "@xyflow/react"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "node",
    testTimeout: 15_000,
  },
}));

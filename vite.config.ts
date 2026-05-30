import { defineConfig } from "vite";
import { layerAliases } from "./scripts/aliases.ts";

// Cross-origin isolation: SharedArrayBuffer-backed worker buffers (OPFS cache,
// transfer-free reads) require COOP/COEP. Set in dev + preview so local headers
// mirror production; the prod host must send the same pair.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  resolve: {
    alias: layerAliases(import.meta.dirname),
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
  server: {
    headers: crossOriginIsolation,
  },
  preview: {
    headers: crossOriginIsolation,
  },
});

import { resolve } from "node:path";
import { defineConfig } from "vite";
import { layerAliases } from "./scripts/aliases.ts";

// Library build of the @webpic/embed facade (src/embed/index.ts) — the headless math + data
// surface, no render/ui/app. Deps are bundled (no externals) so `npm run size` measures what an
// embed actually costs a consumer; three.js appearing in dist-embed means a boundary leak.
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: layerAliases(import.meta.dirname),
  },
  build: {
    target: "esnext",
    outDir: "dist-embed",
    lib: {
      entry: resolve(import.meta.dirname, "src/embed/index.ts"),
      formats: ["es"],
      fileName: "embed",
    },
  },
});

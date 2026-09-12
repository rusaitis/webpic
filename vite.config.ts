import { existsSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { layerAliases } from "./scripts/aliases.ts";

// Dev-only shader hot-reload. The render worker imports the raymarch scene factory but isn't
// HMR-self-accepting, so a normal edit to its WGSL/TSL would bubble to a full page reload — losing the
// camera pose + the uploaded 64 MiB volume. Intercept the edit: fire a custom event the page's HMR
// client (app/shaderHmr.ts) forwards to the worker as `rebuildShader`, which re-imports the edited
// module and swaps the volume material in place. Return `[]` so Vite performs no default HMR/reload.
// (The deferred WESL toolchain replaces this with a `.wesl` → WGSL recompile step — see DESIGN
// §Build system & tooling; v0.1 HMRs the WGSL strings directly.)
function shaderHmr(): Plugin {
  const RAYMARCH_FILE = "/render/field/raymarchScene.ts";
  return {
    name: "webpic:shader-hmr",
    apply: "serve",
    handleHotUpdate(ctx) {
      if (!ctx.file.endsWith(RAYMARCH_FILE)) return;
      // "webpic:shader-hmr" — kept in sync with SHADER_HMR_EVENT in app/shaderHmr.ts.
      ctx.server.ws.send("webpic:shader-hmr", { timestamp: ctx.timestamp });
      return [];
    },
  };
}

// Cross-origin isolation: SharedArrayBuffer-backed worker buffers (OPFS cache,
// transfer-free reads) require COOP/COEP. Set in dev + preview so local headers
// mirror production; the prod host must send the same pair.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// `--mode lan` (dev:lan/preview:lan) serves HTTPS from mkcert certs: WebGPU and
// crossOriginIsolated need a secure context, which plain HTTP on a LAN IP is not.
// Run scripts/setup-lan-certs.sh once to generate .certs/.
function lanHttps(mode: string) {
  if (mode !== "lan") return undefined;
  if (!existsSync(".certs/cert.pem")) {
    throw new Error("lan mode needs TLS certs — run scripts/setup-lan-certs.sh");
  }
  return {
    cert: readFileSync(".certs/cert.pem"),
    key: readFileSync(".certs/key.pem"),
  };
}

// Relative asset URLs in the production build, so one artifact runs unchanged from a domain
// root, a GitHub Pages repo subpath, or a nested directory — nothing bakes in a deploy path.
// Safe here because the app is a single page with query-param state and no history routing.
// Dev keeps an absolute base (Vite's default) so the module graph resolves from `/`.
export default defineConfig(({ command, mode }) => {
  const https = lanHttps(mode);
  const serve = { headers: crossOriginIsolation, ...(https && { https }) };
  return {
    base: command === "build" ? "./" : "/",
    plugins: [shaderHmr()],
    resolve: {
      alias: layerAliases(import.meta.dirname),
    },
    build: {
      target: "esnext",
      sourcemap: true,
    },
    server: serve,
    preview: serve,
  };
});

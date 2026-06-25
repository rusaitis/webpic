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
  const RAYMARCH_FILE = "/render/volume/raymarchScene.ts";
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

export default defineConfig(({ mode }) => {
  const https = lanHttps(mode);
  const serve = { headers: crossOriginIsolation, ...(https && { https }) };
  return {
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

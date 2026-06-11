import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { layerAliases } from "./scripts/aliases.ts";

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

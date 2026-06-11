// The per-file `it.skipIf(!hasRealGpu)` guards would silently skip-green in a WebGPU-less
// browser (provider misconfig, wrong channel) — a gate must fail loudly instead.
// tests/ typechecks under the node tsconfig (no DOM lib), so probe via globalThis.
const g = globalThis as { navigator?: { gpu?: unknown }; OffscreenCanvas?: unknown };
if (g.navigator?.gpu === undefined) {
  throw new Error("gpu project launched a browser without WebGPU — check the Chrome channel");
}
if (g.OffscreenCanvas === undefined) {
  throw new Error("gpu project launched a browser without OffscreenCanvas");
}

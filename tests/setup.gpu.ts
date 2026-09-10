// A WebGPU-less browser (provider misconfig, wrong channel) must fail the gate loudly — a per-file
// skip guard would silently skip-green, so the suites carry none and this probe is the only gate.
// tests/ typechecks under the node tsconfig (no DOM lib), so probe via globalThis.
const g = globalThis as { navigator?: { gpu?: unknown }; OffscreenCanvas?: unknown };
if (g.navigator?.gpu === undefined) {
  throw new Error("gpu project launched a browser without WebGPU — check the Chrome channel");
}
if (g.OffscreenCanvas === undefined) {
  throw new Error("gpu project launched a browser without OffscreenCanvas");
}

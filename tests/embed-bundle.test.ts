import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The built artifact, not the source facade (tests/embed.test.ts covers that): a headless embedder
// gets whatever the bundle actually contains. Three.js leaking in would double the download, and a
// DOM or heavy-reader reference would break `import "@webpic/embed"` in node. Needs `npm run
// build:embed` first — `npm run check` and CI build before testing; a bare `vitest` run skips.
const DIST = join(import.meta.dirname, "..", "dist-embed");
const built = existsSync(DIST);

// zarrita lazy-imports the numcodecs wasm codecs only to decode a compressed chunk; their
// emscripten glue resolves its own URL through `document.currentScript`. Browser-only by
// construction and never reached by the headless entry, so the DOM check covers `embed.js`.
const DOM_ACCESS = /\b(?:document|window)\.[A-Za-z_$]/;
const THREE_MARKERS = [/\bTHREE\./, /BufferGeometry/, /Object3D/, /WebGPURenderer/, /from"three/];
const V02_READERS = [/duckdb/i, /h5wasm/i, /hyparquet/i];

function bundleFiles(): string[] {
  return built ? readdirSync(DIST).filter((name) => name.endsWith(".js")) : [];
}

describe.skipIf(!built)("dist-embed bundle", () => {
  const files = bundleFiles();

  it("emits the library entry", () => {
    expect(files).toContain("embed.js");
  });

  it("carries no three.js", () => {
    for (const file of files) {
      const code = readFileSync(join(DIST, file), "utf8");
      for (const marker of THREE_MARKERS) {
        expect(marker.test(code), `${file} matches ${marker.source}`).toBe(false);
      }
    }
  });

  it("carries no v0.2 reader dependency", () => {
    for (const file of files) {
      const code = readFileSync(join(DIST, file), "utf8");
      for (const marker of V02_READERS) {
        expect(marker.test(code), `${file} matches ${marker.source}`).toBe(false);
      }
    }
  });

  it("touches no DOM from the library entry", () => {
    const code = readFileSync(join(DIST, "embed.js"), "utf8");
    expect(DOM_ACCESS.test(code)).toBe(false);
  });
});

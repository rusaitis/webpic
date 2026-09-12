import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAYERS, type LayerName } from "../scripts/layers.ts";

// An API-doc block outside the published surface restates a signature that is already the spec, and a
// file header longer than six lines is design rationale that belongs in docs/DESIGN.md (CLAUDE.md
// §Comments & docs). Both are strict now: every undocumented layer is at zero JSDoc blocks, and the
// per-layer header ratchet reached the six-line limit on every layer, so it became the rule it was
// converging on.
const UNDOCUMENTED_LAYERS = [
  "render",
  "ui",
  "app",
  "store",
  "gpu",
  "shaders",
  "workers",
] as const satisfies readonly LayerName[];

// The @embed surface keeps its JSDoc — TypeDoc publishes it. Listing the complement makes a new
// layer a failing test until someone decides which side it is on.
const DOCUMENTED_LAYERS = [
  "schema",
  "containers",
  "coordinates",
  "numerics",
  "reductions",
  "derived",
  "diagnostics",
  "compute",
  "data",
  "remote",
  "embed",
] as const satisfies readonly LayerName[];

const HEADER_LIMIT = 6;

const ROOT = join(import.meta.dirname, "..");

function sourceFiles(layer: LayerName): string[] {
  return readdirSync(join(ROOT, "src", layer), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts") && !name.includes(".generated."))
    .map((name) => join(ROOT, "src", layer, name));
}

function jsdocBlocks(layer: LayerName): number {
  let count = 0;
  for (const file of sourceFiles(layer)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*\/\*\*/.test(line)) count += 1;
    }
  }
  return count;
}

// The header is the first unbroken run of top-level `//` lines; a blank line ends it. Imports and
// blank lines before it are skipped, so it reads the same whether it sits above or below them.
function headerLength(source: string): number {
  let length = 0;
  for (const line of source.split("\n")) {
    if (line.startsWith("//")) {
      length += 1;
    } else if (length > 0) {
      break;
    }
  }
  return length;
}

function longestHeader(layer: LayerName): { file: string; length: number } {
  let worst = { file: "", length: 0 };
  for (const file of sourceFiles(layer)) {
    const length = headerLength(readFileSync(file, "utf8"));
    if (length > worst.length) worst = { file, length };
  }
  return worst;
}

describe("comment budget", () => {
  it("accounts for every layer", () => {
    const covered = new Set<string>([...UNDOCUMENTED_LAYERS, ...DOCUMENTED_LAYERS]);
    expect([...covered].sort()).toEqual([...LAYERS].sort());
  });

  for (const layer of UNDOCUMENTED_LAYERS) {
    it(`keeps ${layer} free of API-doc blocks`, () => {
      expect(jsdocBlocks(layer)).toBe(0);
    });
  }

  for (const layer of LAYERS) {
    it(`keeps every ${layer} file header at or below ${HEADER_LIMIT} lines`, () => {
      const worst = longestHeader(layer);
      expect(worst.length, worst.file).toBeLessThanOrEqual(HEADER_LIMIT);
    });
  }
});

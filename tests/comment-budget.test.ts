import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAYERS, type LayerName } from "../scripts/layers.ts";

// An API-doc block outside the published surface restates a signature that is already the spec
// (CLAUDE.md §Comments & docs). The rule cannot land as "zero" while 412 blocks are still in the
// tree, so it lands as a ceiling per layer: today's count, never higher. Lower the number in the
// commit that removes the blocks; a layer that reaches 0 is the strict rule.
const JSDOC_CEILING = {
  render: 167,
  ui: 110,
  app: 56,
  store: 52,
  gpu: 27,
  shaders: 0,
  workers: 0,
} as const satisfies Partial<Record<LayerName, number>>;

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

describe("JSDoc budget outside the @embed surface", () => {
  it("accounts for every layer", () => {
    const covered = new Set<string>([...Object.keys(JSDOC_CEILING), ...DOCUMENTED_LAYERS]);
    expect([...covered].sort()).toEqual([...LAYERS].sort());
  });

  for (const [layer, ceiling] of Object.entries(JSDOC_CEILING)) {
    it(`keeps ${layer} at or below ${ceiling} API-doc blocks`, () => {
      expect(jsdocBlocks(layer as LayerName)).toBeLessThanOrEqual(ceiling);
    });
  }

  it("never raises a ceiling above the count that set it", () => {
    // A ceiling loosened to hide new blocks defeats the ratchet; the slack is the tell.
    for (const [layer, ceiling] of Object.entries(JSDOC_CEILING)) {
      const actual = jsdocBlocks(layer as LayerName);
      expect(ceiling - actual, `${layer} ceiling ${ceiling} vs ${actual} blocks`).toBeLessThan(10);
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAYERS, type LayerName } from "../scripts/layers.ts";
import { typescriptFiles } from "./sourceTree.ts";

// An API-doc block outside the published surface restates a signature that is already the spec, and
// a file header over six lines is rationale the design doc owns — CLAUDE.md §Comments & docs. Both
// are strict now: every undocumented layer is at zero JSDoc blocks, and the per-layer header ratchet
// reached the six-line limit on every layer, so it became the rule it was converging on.
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
  return typescriptFiles(`src/${layer}`)
    .filter((path) => !path.endsWith(".test.ts") && !path.includes(".generated."))
    .map((path) => join(ROOT, path));
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

// Every top-level `//` block before the first statement, not just the first — a blank line between
// two blocks would otherwise hide half the header. A block sitting directly on top of a statement
// (an import, a declaration) explains that statement rather than the file, so it does not count.
function headerLength(source: string): number {
  let total = 0;
  let run = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (line.startsWith("//")) {
      run += 1;
      continue;
    }
    const isStatement = trimmed !== "" && !/^[\s})]/.test(line) && !trimmed.startsWith("from ");
    if (run > 0) {
      if (!isStatement) total += run; // a blank line below it: this block is the file's
      run = 0;
    }
    if (isStatement && !line.startsWith("import ")) break;
  }
  return total;
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

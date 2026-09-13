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

// A mechanical rename that reaches into comments turns English into identifiers: an adjective
// becomes the boolean named after it, and the abbreviation for "for example" becomes a property
// access. Each pattern is a shape prose takes and code never does, so a legitimate reference
// (`not gated on isReady`, `the plain isReady gate`) is not a hit. They catch most of a sweep, not
// all of it — the article-adjective shape that would catch the rest also matches that second
// example, and a guard needing a suppression on day one is not a guard.
const PROSE_CORRUPTION: ReadonlyArray<{ readonly pattern: RegExp; readonly shape: string }> = [
  { pattern: /\b(?:an?|the)\s+(?:is|has|should)[A-Z]/, shape: "article + identifier" },
  { pattern: /[a-z]-(?:is|has|should)[A-Z]/, shape: "hyphen-compound + identifier" },
  { pattern: /\bis\s+(?:is|has|should)[A-Z]/, shape: "'is' + identifier" },
  {
    pattern: /\b(?:event|element|options|context|signal|abortController)\.g\./,
    shape: "'e.g.' renamed",
  },
  { pattern: /\b(?:is|has|should)[A-Z][a-z]+-[a-z]/, shape: "identifier as an adjective" },
  { pattern: /\bfor\s+(?:is|has|should)[A-Z]/, shape: "'for' + identifier" },
  { pattern: /\bidentical\s+(?:is|has|should)[A-Z]/, shape: "'identical' + identifier" },
  { pattern: /\bshould[A-Z][a-z]+\s+the\b/, shape: "'should<Verb> the'" },
  {
    pattern: /\(\s*(?:is|has|should)[A-Z][a-z]+\s+(?:until|when|while)\b/,
    shape: "identifier as an adjective",
  },
];

// The prose in a file: `//` comments (a `://` before the marker is a URL, not a comment) plus the
// sentence in each it()/describe() title, which a rename sweep corrupted the same way.
function proseLines(
  source: string,
): ReadonlyArray<{ readonly line: number; readonly text: string }> {
  const out: { line: number; text: string }[] = [];
  source.split("\n").forEach((text, index) => {
    const title = /\b(?:it|describe)\(\s*"([^"]+)"/.exec(text);
    if (title?.[1] !== undefined) out.push({ line: index + 1, text: title[1] });
    const at = text.indexOf("//");
    if (at === -1 || text.slice(Math.max(0, at - 1), at + 3).includes("://")) return;
    out.push({ line: index + 1, text: text.slice(at) });
  });
  return out;
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

  it("keeps identifiers out of comment prose, where a rename sweep leaves them", () => {
    const found: string[] = [];
    for (const path of typescriptFiles("src").concat(typescriptFiles("tests"))) {
      if (path.includes(".generated.")) continue;
      const source = readFileSync(join(ROOT, path), "utf8");
      for (const { line, text } of proseLines(source)) {
        const hit = PROSE_CORRUPTION.find(({ pattern }) => pattern.test(text));
        if (hit !== undefined) found.push(`${path}:${line} [${hit.shape}] ${text.trim()}`);
      }
    }
    expect(found).toEqual([]);
  });
});

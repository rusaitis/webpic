import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LAYERS } from "../scripts/layers.ts";
import { typescriptFiles } from "./sourceTree.ts";

// knip lists `src/**/*.test.ts` as an entry point — correctly, since a test is a root — but that makes
// any module kept alive solely by its own test invisible to `check:dead`. gpu/profiler.ts lived there
// through six cleanup passes. This is the guard knip structurally cannot be.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAYER_SET: ReadonlySet<string> = new Set(LAYERS);

// Roots nothing imports by design: the app + worker entries, and every layer barrel, which exists so
// the `@layer` alias resolves (tests/aliases.test.ts) whether or not anything imports it today.
const ENTRY_POINTS: ReadonlySet<string> = new Set([
  "src/main.ts",
  "src/render/worker.ts",
  "src/workers/data.worker.ts",
  "src/embed/index.ts",
]);

const isTest = (path: string): boolean => /\.(?:browser\.|dom\.)?test\.ts$/.test(path);
const isBarrel = (path: string): boolean => /^src\/[^/]+\/index\.ts$/.test(path);
// `STAGED:` is the sanctioned way to keep code that nothing calls yet (CLAUDE.md §Comments); it names
// what will activate it, which is the claim this guard exists to force.
const isStaged = (path: string): boolean =>
  readFileSync(resolve(ROOT, path), "utf8").includes("// STAGED:");

// Static imports, `export … from`, and dynamic `import()` — the same reach as check-boundaries.
function specifiers(path: string): string[] {
  const text = readFileSync(resolve(ROOT, path), "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

// A specifier as a repo-relative src path, or undefined when it leaves the source tree.
function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  const bare = specifier.split("?", 1)[0] ?? specifier;
  if (bare.startsWith("@")) {
    const [name, ...rest] = bare.slice(1).split("/");
    if (name === undefined || !LAYER_SET.has(name)) return undefined;
    return rest.length === 0 ? `src/${name}/index.ts` : `src/${name}/${rest.join("/")}`;
  }
  if (!bare.startsWith(".")) return undefined;
  return relative(ROOT, resolve(dirname(resolve(ROOT, fromFile)), bare)).replaceAll("\\", "/");
}

describe("src module graph", () => {
  it("has no module reachable only from its own test", () => {
    const all = [
      ...typescriptFiles("src"),
      ...typescriptFiles("scripts"),
      ...typescriptFiles("tests"),
    ];
    const productionImporters = new Map<string, string[]>();
    for (const file of all) {
      for (const specifier of specifiers(file)) {
        const target = resolveSpecifier(specifier, file);
        if (target === undefined || target === file) continue;
        if (isTest(file)) continue;
        productionImporters.set(target, [...(productionImporters.get(target) ?? []), file]);
      }
    }

    const orphans = typescriptFiles("src").filter(
      (file) =>
        !isTest(file) &&
        !isBarrel(file) &&
        !ENTRY_POINTS.has(file) &&
        !file.endsWith(".d.ts") &&
        !isStaged(file) &&
        (productionImporters.get(file) ?? []).length === 0,
    );

    expect(orphans).toEqual([]);
  });
});

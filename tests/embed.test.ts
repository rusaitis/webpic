import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as embed from "@embed";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

// ES star-export semantics silently DROP a name exported by two facade modules (ambiguous
// re-export) — no tsc error, no runtime throw. The completeness test below turns that into a
// loud failure; keep the facade to `export * from "<module>";` lines so it stays parseable.
function facadeSpecifiers(): string[] {
  const source = readFileSync(join(ROOT, "src/embed/index.ts"), "utf8");
  return [...source.matchAll(/^export \* from "([^"]+)";$/gm)].map((match) => match[1] ?? "");
}

describe("@webpic/embed facade", () => {
  it("imports headlessly (node, no DOM/GPU) and exposes the load-bearing API", () => {
    const loadBearing = [
      "colormapColor",
      "readHeapBytes",
      "curl",
      "divergence",
      "gradient",
      "dormandPrinceStep",
      "iStepController",
      "interpolatorFromDataset",
      "traceFieldLinesAdaptive",
      "makeFieldLine",
      "magneticFieldMagnitude",
      "vectorMagnitude",
      "computeField",
      "computableFields",
      "traceFields",
      "openSimulation",
      "registerReader",
      "registerBuiltinReaders",
      "createZarrReader",
      "createSyntheticReader",
      "writeZarr",
      "encodePypicAttrs",
    ] as const;
    const exported = new Set(Object.keys(embed));
    for (const name of loadBearing) {
      expect(exported.has(name), name).toBe(true);
    }
    expect(embed.computeField).toBeTypeOf("function");
    expect(embed.traceFields).toBeTypeOf("function");
    expect(embed.writeZarr).toBeTypeOf("function");
    expect(embed.openSimulation).toBeTypeOf("function");
    expect(embed.RECIPES).toBeTypeOf("object");
    expect(embed.BACKEND_IDS).toContain("ts");
  });

  it("re-exports every runtime name of every facade module (no silent star-export drops)", async () => {
    const embedKeys = new Set(Object.keys(embed));
    const specifiers = facadeSpecifiers();
    expect(specifiers.length).toBeGreaterThanOrEqual(10);
    for (const specifier of specifiers) {
      const mod = (await import(specifier)) as Record<string, unknown>;
      for (const key of Object.keys(mod)) {
        expect(embedKeys.has(key), `${specifier} export "${key}" missing from @embed`).toBe(true);
      }
    }
  });
});

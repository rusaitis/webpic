import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layerAliases } from "../scripts/aliases.ts";
import { LAYERS } from "../scripts/layers.ts";

const ROOT = join(import.meta.dirname, "..");

function tsconfigPaths(): Record<string, string[]> {
  const raw = readFileSync(join(ROOT, "tsconfig.base.json"), "utf8");
  // tsconfig.base.json is comment-free JSON; shape is asserted by the tests below.
  const parsed = JSON.parse(raw) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  return parsed.compilerOptions?.paths ?? {};
}

describe("path-alias parity (tsconfig ↔ Vite/Vitest ↔ LAYERS)", () => {
  const paths = tsconfigPaths();

  it("tsconfig defines both alias forms for every layer", () => {
    for (const layer of LAYERS) {
      expect(paths[`@${layer}`]).toEqual([`./src/${layer}/index.ts`]);
      expect(paths[`@${layer}/*`]).toEqual([`./src/${layer}/*`]);
    }
  });

  it("tsconfig has no alias keys outside the known layers", () => {
    const expected = new Set(LAYERS.flatMap((layer) => [`@${layer}`, `@${layer}/*`]));
    for (const key of Object.keys(paths)) {
      expect(expected.has(key)).toBe(true);
    }
    expect(Object.keys(paths)).toHaveLength(LAYERS.length * 2);
  });

  it("layerAliases yields exactly one Vite/Vitest entry per layer", () => {
    const aliases = layerAliases(ROOT);
    expect(aliases).toHaveLength(LAYERS.length);
    for (const layer of LAYERS) {
      const entry = aliases.find((a) => a.find === `@${layer}`);
      expect(entry?.replacement).toBe(join(ROOT, "src", layer));
    }
  });

  it("resolves a layer alias end-to-end at runtime", async () => {
    const mod = await import("@schema");
    expect(mod.fieldInfo).toBeTypeOf("function");
  });
});

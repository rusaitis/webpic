import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadBundle } from "./bundle.ts";
import { renderAliases } from "./render-aliases.ts";
import { renderRecipes } from "./render-recipes.ts";
import { renderRegistry } from "./render-registry.ts";
import { renderValidators } from "./render-schema.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const out = (rel: string): string => resolve(ROOT, rel);

// What `npm run gen:emit` writes. tests/schema-parity.test.ts reads this same table to assert each
// file regenerates byte-identically, so a fifth artifact cannot be emitted and go unchecked.
export const ARTIFACTS = [
  { render: renderValidators, path: "src/schema/validators.generated.ts" },
  { render: renderAliases, path: "src/schema/aliases.generated.ts" },
  { render: renderRegistry, path: "src/schema/registry.generated.ts" },
  { render: renderRecipes, path: "src/compute/recipes.generated.ts" },
] as const;

export const BUNDLE_PATH = out("src/schema/pypic-export.generated.json");

// Guarded so importing the table from the drift test does not re-emit the tree mid-run.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const bundle = loadBundle(BUNDLE_PATH);
  for (const { render, path } of ARTIFACTS) writeFileSync(out(path), render(bundle));
  console.log(`emitted: ${ARTIFACTS.length} artifacts`);
}

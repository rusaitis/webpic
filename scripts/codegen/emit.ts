import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "./bundle.ts";
import { renderAliases } from "./render-aliases.ts";
import { renderRecipes } from "./render-recipes.ts";
import { renderRegistry } from "./render-registry.ts";
import { renderValidators } from "./render-schema.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const out = (rel: string): string => resolve(ROOT, rel);

const bundle = loadBundle(out("src/schema/pypic-export.generated.json"));

writeFileSync(out("src/schema/validators.generated.ts"), renderValidators(bundle));
writeFileSync(out("src/schema/aliases.generated.ts"), renderAliases(bundle));
writeFileSync(out("src/schema/registry.generated.ts"), renderRegistry(bundle));
writeFileSync(out("src/compute/recipes.generated.ts"), renderRecipes(bundle));

console.log("emitted: validators, aliases, registry, recipes");

import { BANNER, type Bundle } from "./bundle.ts";

function entries(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n");
}

export function renderRecipes(bundle: Bundle): string {
  const keyUnion = Object.keys(bundle.recipes)
    .map((key) => JSON.stringify(key))
    .join(" | ");

  return (
    `${BANNER}` +
    `import type { RecipeMeta, SpeciesTemplateMeta } from "./recipe.ts";\n\n` +
    `export type RecipeKey = ${keyUnion};\n\n` +
    `export const RECIPES: Record<RecipeKey, RecipeMeta> = {\n${entries(bundle.recipes)}\n};\n\n` +
    `export const SPECIES_TEMPLATES: Record<string, SpeciesTemplateMeta> = {\n${entries(bundle.speciesTemplates)}\n};\n`
  );
}

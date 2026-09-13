import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import { isSameShape } from "@schema/math.ts";
import { fieldInfo } from "@schema/registry.ts";

// Mirrors pypic.compute.SpeciesArgs (StrEnum).
export type SpeciesArgs = "charge_mass" | "mass_only" | "charge_only" | "none";

// Mirrors pypic.compute.Recipe minus the (non-portable) callable; `func` is the
// bare derived-op name, re-bound to a TS implementation in the derived layer.
export interface RecipeMeta {
  readonly func: string;
  readonly fields: readonly string[];
  readonly speciesIndex: number | null;
  readonly needsGrid: boolean;
  readonly needsGamma: boolean;
  readonly needsC: boolean;
  readonly component: number | null;
  readonly speciesArgs: SpeciesArgs | null;
  readonly passesGeometry: boolean;
  readonly supportsRelativistic: boolean;
}

// Mirrors pypic.compute.SpeciesTemplate; `fieldPattern` keeps the `{N}` species
// placeholder, expanded at lookup time.
export interface SpeciesTemplateMeta {
  readonly func: string;
  readonly fieldPattern: readonly string[];
  readonly speciesArgs: SpeciesArgs;
  readonly needsGamma: boolean;
  readonly needsC: boolean;
  readonly component: number | null;
}

// Both backends gather the same inputs under the same two rules — every named field present, every
// shape equal — and differ only in the label their errors carry. `label` is the backend's own name,
// so a failure still says which one refused.
export function gatherRecipeInputs(
  recipe: RecipeMeta,
  name: string,
  dataset: FieldDataset,
  label: string,
): FieldArray[] {
  const inputs: FieldArray[] = [];
  for (const fieldName of recipe.fields) {
    const field = dataset.fields.get(fieldName);
    if (field === undefined) {
      throw new Error(`${label}: recipe "${name}" requires field "${fieldName}", not in dataset`);
    }
    const first = inputs[0];
    if (first !== undefined && !isSameShape(first.shape, field.shape)) {
      throw new Error(
        `${label}: recipe "${name}" needs one shape across inputs, got [${first.shape.join(", ")}] and [${field.shape.join(", ")}]`,
      );
    }
    inputs.push(field);
  }
  return inputs;
}

// A computed field carries the canonical registry's meta and the *inputs'* units — the recipe result
// is in the component's units, and only the registry knows the rest.
export function recipeFieldArray(
  name: string,
  data: Float32Array | Float64Array,
  source: FieldArray,
): FieldArray {
  const meta = fieldInfo(name);
  return {
    data,
    shape: source.shape,
    meta,
    units: source.units,
    latex: meta.latex,
    reduction: null,
  };
}

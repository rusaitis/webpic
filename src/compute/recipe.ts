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

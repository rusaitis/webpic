export type Vec3 = readonly [number, number, number];

// Field data on disk and through the math layers: f32 for render, f64 for the TS
// compute reference. The one canonical alias for the typed-array pair.
export type FloatArray = Float32Array | Float64Array;

// Canonical field name (e.g. "B_1", "|B|", "beta"). String for now; a branded
// type can tighten this once the registry is the enforced source of truth.
export type FieldName = string;

export type SpeciesIdx = number;

// Mirrors pypic.fields.FieldInfo (the static, JSON-portable subset).
export interface FieldMeta {
  readonly quantityType: string;
  readonly longName: string;
  readonly siUnit: string;
  readonly latex: string;
  readonly unitDimension: readonly number[] | null;
}

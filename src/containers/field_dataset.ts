import type { FieldMeta, FieldName, Vec3 } from "@schema/types.ts";

// Minimal typed-array-backed dataset container — the shape every reader produces
// and the math/render layers consume. Destaggering Yee-mesh components to a co-located
// grid runs on load in @data/stagger.ts (destaggerToColocated). Mirrors
// pypic.dataset.FieldDataset + pypic.grid.GridInfo.

// pypic CoordinateGeometry plus `thetaMode` (FBPIC RZ). M1.1 carries the tag; the
// raymarcher/coordinate transforms interpret it later.
export type GeometryType = "cartesian" | "spherical" | "cylindrical" | "thetaMode";

// Decoded pypic StaggerInfo (the __pypic_class__:"StaggerInfo" sentinel). Recorded
// verbatim so M1.3's destagger can map Yee-mesh components to the co-located grid.
export interface StaggerInfo {
  readonly convention: "cell" | "node" | "staggered";
  readonly fieldLocations: Readonly<Record<string, string>> | null;
  readonly position: Readonly<Record<string, Vec3>> | null;
  readonly interpolationOrder: number | null;
  readonly notes: string | null;
}

// pypic.reductions reduction-provenance block, preserved verbatim for the M6
// round-trip. Optional keys are omitted (never set to undefined) to satisfy
// exactOptionalPropertyTypes.
export type ReductionOp =
  | "integrate"
  | "sum"
  | "mean"
  | "median"
  | "max"
  | "min"
  | "std"
  | "var"
  | "argmax"
  | "argmin";

export interface ReductionSpec {
  readonly axis: string | readonly string[];
  readonly op: ReductionOp;
  readonly resultKind?: "axis_position";
  readonly weight?: string;
  readonly lengthAxes?: number;
}

// pypic.grid.GridInfo. `origin` is pypic's `lower` corner; spatial axes only (a
// multi-step store's time axis is sliced away before the dataset is built).
export interface GridInfo {
  readonly dimensions: readonly number[];
  readonly spacing: readonly number[];
  readonly origin: readonly number[];
  readonly geometry: GeometryType;
  readonly axisLabels: readonly string[];
  readonly dt: number | null;
  readonly boundary: readonly string[] | null;
  readonly survivingAxes: readonly number[] | null;
  readonly stagger: StaggerInfo | null;
}

// pypic.units.Normalization — SI references for code↔SI conversion at boundaries.
// `speedOfLight` is Infinity for non-relativistic runs (pypic's "inf" sentinel).
export interface Normalization {
  readonly lengthRef: number;
  readonly timeRef: number;
  readonly velocityRef: number;
  readonly bFieldRef: number;
  readonly eFieldRef: number;
  readonly densityRef: number;
  readonly massRef: number;
  readonly chargeRef: number;
  readonly speedOfLight: number;
}

export interface PhysicsParams {
  readonly gamma: number;
  readonly c: number;
  readonly relativistic: boolean;
  readonly extra: Readonly<Record<string, unknown>>;
}

// One field, in row-major C order. Disk dtype preserved (f32 for render, f64 for the
// TS compute reference); consumers downcast at their own boundary. `shape` excludes time.
export interface FieldArray {
  readonly data: Float32Array | Float64Array;
  readonly shape: readonly number[];
  readonly meta: FieldMeta;
  readonly units: string;
  readonly latex: string;
  readonly reduction: ReductionSpec | null;
}

export interface FieldDataset {
  readonly fields: ReadonlyMap<FieldName, FieldArray>;
  readonly grid: GridInfo;
  readonly normalization: Normalization;
  // species/transforms/metadata stay opaque-but-decoded in M1.1; tightened to typed
  // SpeciesInfo/FrameTransform when compute/render need them.
  readonly species: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly physics: PhysicsParams;
  readonly frame: string;
  readonly transforms: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly step: number;
}

import type {
  FieldArray,
  FieldDataset,
  GridInfo,
  Normalization,
  PhysicsParams,
  ReductionSpec,
  StaggerInfo,
} from "@containers/field_dataset.ts";
import { sameShape } from "@schema/math.ts";
import type { FloatArray } from "@schema/types.ts";
import { SCHEMA_VERSION } from "@schema/version.ts";
import * as zarr from "zarrita";

// Zarr v3 writer for pypic-blessed stores (mirrors pypic.io.zarr.to_zarr, single-timestep).
// Encodes the schema-v1.0 root attrs as the exact inverse of readers/decode.ts, so a written
// store round-trips through createZarrReader and pypic's from_zarr alike. Storage backend is
// injected (tests pass an in-memory Map; the app supplies an OPFS-backed store).

export type WriteDtype = "float32" | "float64";

export interface ZarrWriteOptions {
  /** Downcast all field arrays to this dtype on write; default preserves source dtype. */
  readonly dtype?: WriteDtype;
  readonly signal?: AbortSignal;
}

const PYPIC_CLASS = "__pypic_class__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFloatView(value: unknown): value is FloatArray {
  return value instanceof Float32Array || value instanceof Float64Array;
}

// TS twin of pypic.io.metadata.to_json_native: Maps re-tag as keyed_dict, typed arrays
// flatten to plain lists (the np.ndarray → tolist mirror), everything else must already
// be JSON-native. Decoded pypic tuples arrived as plain JS arrays, so they re-encode as
// lists — a documented one-way degradation (JS has no tuple identity to preserve).
// Non-finite numbers throw: JSON.stringify would silently turn them into null.
export function toJsonNative(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `zarr writer: cannot encode non-finite number ${value}; use a sentinel at the caller boundary`,
      );
    }
    return value;
  }
  if (isFloatView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(toJsonNative);
  if (value instanceof Map) {
    return {
      [PYPIC_CLASS]: "keyed_dict",
      items: [...value.entries()].map(([k, v]) => [toJsonNative(k), toJsonNative(v)]),
    };
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonNative(v);
    return out;
  }
  throw new TypeError(
    `zarr writer: cannot encode ${typeof value} as a JSON attr; convert at the caller boundary`,
  );
}

function encodeSpeedOfLight(c: number): number | "inf" {
  return Number.isFinite(c) ? c : "inf";
}

function staggerToAttrs(stagger: StaggerInfo): Record<string, unknown> {
  return {
    [PYPIC_CLASS]: "StaggerInfo",
    convention: stagger.convention,
    field_locations: stagger.fieldLocations === null ? null : { ...stagger.fieldLocations },
    position:
      stagger.position === null
        ? null
        : Object.fromEntries(Object.entries(stagger.position).map(([k, v]) => [k, [...v]])),
    interpolation_order: stagger.interpolationOrder,
    notes: stagger.notes,
  };
}

function assertGridConsistent(grid: GridInfo): void {
  const ndim = grid.dimensions.length;
  if (grid.spacing.length !== ndim || grid.origin.length !== ndim) {
    throw new Error(
      `zarr writer: grid dimensions/spacing/origin lengths disagree ` +
        `(${ndim}/${grid.spacing.length}/${grid.origin.length})`,
    );
  }
  if (grid.axisLabels.length !== ndim) {
    throw new Error(
      `zarr writer: grid has ${ndim} dimensions but ${grid.axisLabels.length} axis labels`,
    );
  }
}

function gridToAttrs(grid: GridInfo): Record<string, unknown> {
  const lower = [...grid.origin];
  const upper = grid.dimensions.map((n, i) => (grid.origin[i] ?? 0) + (grid.spacing[i] ?? 0) * n);
  const out: Record<string, unknown> = {
    dimensions: [...grid.dimensions],
    spacing: [...grid.spacing],
    lower,
    upper,
  };
  if (grid.survivingAxes !== null) out.surviving_axes = [...grid.survivingAxes];
  if (grid.stagger !== null) out.stagger = staggerToAttrs(grid.stagger);
  return out;
}

function coordinatesToAttrs(dataset: FieldDataset): Record<string, unknown> {
  const out: Record<string, unknown> = {
    geometry: dataset.grid.geometry,
    frame: dataset.frame,
    axis_labels: [...dataset.grid.axisLabels],
  };
  const transforms = toJsonNative(dataset.transforms) as Record<string, unknown>;
  if (Object.keys(transforms).length > 0) out.transforms = transforms;
  return out;
}

function normalizationToAttrs(n: Normalization): Record<string, unknown> {
  return {
    length_ref: n.lengthRef,
    time_ref: n.timeRef,
    velocity_ref: n.velocityRef,
    b_field_ref: n.bFieldRef,
    e_field_ref: n.eFieldRef,
    density_ref: n.densityRef,
    mass_ref: n.massRef,
    charge_ref: n.chargeRef,
    speed_of_light: encodeSpeedOfLight(n.speedOfLight),
  };
}

function physicsToAttrs(p: PhysicsParams): Record<string, unknown> {
  return {
    relativistic: p.relativistic,
    gamma_eos: p.gamma,
    extra: toJsonNative(p.extra),
  };
}

// Reserved metadata keys lifted to top-level root attrs on write (pypic's
// pop_reserved_metadata): cross-tool consumers read attrs.run / attrs.simulation_toml
// without going through the open metadata bag, and the reader re-stuffs them on load.
const RESERVED_METADATA_KEYS = ["model", "run", "simulation_toml"] as const;

function popReservedMetadata(metadata: Readonly<Record<string, unknown>>): {
  readonly open: Record<string, unknown>;
  readonly lifted: Record<string, unknown>;
} {
  const open: Record<string, unknown> = { ...metadata };
  const lifted: Record<string, unknown> = {};
  for (const key of RESERVED_METADATA_KEYS) {
    const value = open[key];
    delete open[key];
    if (value === undefined || value === null) continue;
    if (key === "simulation_toml") {
      if (typeof value !== "string") {
        throw new TypeError(
          `zarr writer: metadata.simulation_toml must be a string of TOML source, got ${typeof value}`,
        );
      }
      lifted[key] = value;
    } else {
      if (!isRecord(value)) {
        throw new TypeError(`zarr writer: metadata.${key} must be a JSON object`);
      }
      lifted[key] = toJsonNative(value);
    }
  }
  return { open, lifted };
}

// Root-group attrs in pypic's schema-v1.0 mirror layout (one key per simulation.toml
// section). Inverse of readers/decode.ts; shape authority is pypic.io.metadata
// .encode_pypic_attrs.
export function encodePypicAttrs(dataset: FieldDataset): Record<string, unknown> {
  const { grid } = dataset;
  const { open: metadata, lifted } = popReservedMetadata(dataset.metadata);
  const out: Record<string, unknown> = {
    schema: { version: SCHEMA_VERSION },
    grid: gridToAttrs(grid),
    coordinates: coordinatesToAttrs(dataset),
    normalization: normalizationToAttrs(dataset.normalization),
    species: toJsonNative(dataset.species),
    physics: physicsToAttrs(dataset.physics),
    metadata: toJsonNative(metadata),
  };
  if (grid.dt !== null) out.time = { dt: grid.dt };
  if (grid.boundary !== null) {
    // In-memory carries one tag per axis; both faces emit the same value (pypic parity).
    out.boundary_conditions = { lower: [...grid.boundary], upper: [...grid.boundary] };
  }
  Object.assign(out, lifted);
  return out;
}

// Verbatim reduction provenance (pypic.reductions attr block): optional keys appear only
// when set — pypic omits result_kind outside argmax/argmin, weight when unweighted, and
// length_axes when zero, and loaders treat absence as meaningful. No validation, no
// normalization; dropping length_axes would silently corrupt in_si() on integrated fields.
function reductionToAttrs(reduction: ReductionSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    axis: typeof reduction.axis === "string" ? reduction.axis : [...reduction.axis],
    op: reduction.op,
  };
  if (reduction.resultKind !== undefined) out.result_kind = reduction.resultKind;
  if (reduction.weight !== undefined) out.weight = reduction.weight;
  if (reduction.lengthAxes !== undefined) out.length_axes = reduction.lengthAxes;
  return out;
}

function fieldAttributes(field: FieldArray): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    long_name: field.meta.longName,
    units: field.units,
    quantity_type: field.meta.quantityType,
    si_unit: field.meta.siUnit,
    unit_dimension: field.meta.unitDimension === null ? null : [...field.meta.unitDimension],
  };
  const latex = field.latex !== "" ? field.latex : field.meta.latex;
  if (latex !== "") attrs.latex = latex;
  if (field.reduction !== null) attrs.reduction = reductionToAttrs(field.reduction);
  return attrs;
}

function coerceDtype(
  data: FloatArray,
  want: WriteDtype | undefined,
): { readonly data: FloatArray; readonly dtype: WriteDtype } {
  const have: WriteDtype = data instanceof Float32Array ? "float32" : "float64";
  if (want === undefined || want === have) return { data, dtype: have };
  return want === "float32"
    ? { data: new Float32Array(data), dtype: want }
    : { data: new Float64Array(data), dtype: want };
}

// Spec-strict readers (zarr-python) require an explicit ArrayBytesCodec; zarrita's
// create would otherwise write an empty codec list, which they reject.
const BYTES_CODEC = [{ name: "bytes", configuration: { endian: "little" as const } }];

function rowMajorStrides(shape: readonly number[]): number[] {
  const strides = new globalThis.Array<number>(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    strides[i] = acc;
    acc *= shape[i] ?? 1;
  }
  return strides;
}

/**
 * Write a FieldDataset to a Zarr v3 store as a single-timestep pypic store: root attrs in
 * the schema-v1.0 mirror layout, field arrays + cell-centered coordinate arrays under
 * `/fields`. Whole-array chunks, uncompressed — the caching/export payloads are modest and
 * decode speed on scrub-back beats disk footprint.
 */
export async function writeZarr(
  dataset: FieldDataset,
  store: zarr.Mutable,
  options: ZarrWriteOptions = {},
): Promise<void> {
  const { signal } = options;
  signal?.throwIfAborted();
  const { grid } = dataset;
  assertGridConsistent(grid);

  const dims = [...grid.axisLabels];
  const coordNames = new Set<string>([...dims, "time"]);
  for (const name of dataset.fields.keys()) {
    if (coordNames.has(name)) {
      throw new Error(`zarr writer: field "${name}" collides with a coordinate array name`);
    }
  }

  const root = zarr.root(store);
  await zarr.create(root, { attributes: encodePypicAttrs(dataset) });
  await zarr.create(root.resolve("fields"), { attributes: {} });

  for (const [name, field] of dataset.fields) {
    signal?.throwIfAborted();
    if (!sameShape(field.shape, grid.dimensions)) {
      throw new Error(
        `zarr writer: field "${name}" shape [${field.shape.join(", ")}] does not match ` +
          `grid dimensions [${grid.dimensions.join(", ")}]`,
      );
    }
    const { data, dtype } = coerceDtype(field.data, options.dtype);
    const shape = [...field.shape];
    const array = await zarr.create(root.resolve(`fields/${name}`), {
      dtype,
      shape,
      chunkShape: shape,
      dimensionNames: dims,
      attributes: fieldAttributes(field),
      codecs: BYTES_CODEC,
      // zarrita defaults fill_value to null, which spec-strict readers (zarr-python)
      // reject for float dtypes; all chunks are written, so the value is never read.
      fillValue: 0,
    });
    await zarr.set(array, null, { data, shape, stride: rowMajorStrides(shape) });
  }

  // Cell-centered dimension coordinates: origin + (i + 0.5)·dx, the pypic
  // GridInfo.coordinate_arrays convention every absolute-coordinate consumer assumes.
  for (let axis = 0; axis < dims.length; axis++) {
    signal?.throwIfAborted();
    const n = grid.dimensions[axis] ?? 0;
    const dx = grid.spacing[axis] ?? 0;
    const x0 = grid.origin[axis] ?? 0;
    const label = dims[axis] ?? `dim_${axis}`;
    const coord = new Float64Array(n);
    for (let i = 0; i < n; i++) coord[i] = x0 + (i + 0.5) * dx;
    const array = await zarr.create(root.resolve(`fields/${label}`), {
      dtype: "float64",
      shape: [n],
      chunkShape: [n],
      dimensionNames: [label],
      codecs: BYTES_CODEC,
      fillValue: 0,
    });
    await zarr.set(array, null, { data: coord, shape: [n], stride: [1] });
  }
}

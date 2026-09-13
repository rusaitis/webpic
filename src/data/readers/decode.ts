import type {
  GeometryType,
  GridInfo,
  Normalization,
  PhysicsParams,
  ReductionOp,
  ReductionSpec,
  StaggerInfo,
} from "@containers/field_dataset.ts";
import { vec3 } from "@schema/math.ts";
import { SCHEMA_VERSION } from "@schema/version.ts";
import { formatZodError } from "@schema/zodError.ts";
import { z } from "zod";
import { isRecord, PYPIC_CLASS } from "../pypicJson.ts";

// Decodes pypic's on-disk Zarr attrs into webpic container types. Mirrors
// pypic.io.metadata (decode_pypic_attrs, from_json_native) and pypic.grid.GridInfo.
// Validation lives here (the data boundary), never in hot paths. Unknown keys are
// stripped, not rejected — forward-compatible with newer pypic writers; missing
// *required* structure throws loudly with the source label.

// Reverse pypic's JSON coercion: tuples, non-string-keyed dicts, and StaggerInfo carry a
// `__pypic_class__` tag; recurse through plain containers. The `"inf"` sentinel is NOT decoded
// here — only speed_of_light special-cases it (decodeSpeedOfLight), matching pypic's _decode_c.
export function fromJsonNative(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromJsonNative);
  if (!isRecord(value)) return value;
  switch (value[PYPIC_CLASS]) {
    case "tuple":
      return Array.isArray(value.items) ? value.items.map(fromJsonNative) : [];
    case "keyed_dict": {
      const items = Array.isArray(value.items) ? value.items : [];
      return new Map(
        items.map((entry) => {
          // keyed_dict items are [key, value] pairs per pypic's JSON encoding (items is an array).
          const [k, v] = entry as [unknown, unknown];
          return [fromJsonNative(k), fromJsonNative(v)] as const;
        }),
      );
    }
    default: {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === PYPIC_CLASS) continue;
        out[k] = fromJsonNative(v);
      }
      return out;
    }
  }
}

export function decodeSpeedOfLight(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "inf") return Number.POSITIVE_INFINITY;
  return Number(raw);
}

// Zod schemas for the on-disk Zarr attr blocks — not the simulation.toml schema.
const SchemaDiscriminatorSchema = z.object({ version: z.string() });

const GridAttrsSchema = z.object({
  dimensions: z.array(z.number().int().positive()),
  spacing: z.array(z.number()),
  lower: z.array(z.number()).optional(),
  origin: z.array(z.number()).optional(),
  surviving_axes: z.array(z.number().int()).optional(),
  stagger: z.unknown().optional(),
});

const CoordinatesAttrsSchema = z.object({
  geometry: z.enum(["cartesian", "spherical", "cylindrical", "thetaMode"]),
  frame: z.string().optional(),
  axis_labels: z.array(z.string()).nullable().optional(),
  transforms: z.unknown().optional(),
});

const NormalizationAttrsSchema = z.object({
  length_ref: z.number(),
  time_ref: z.number(),
  velocity_ref: z.number(),
  b_field_ref: z.number(),
  e_field_ref: z.number(),
  density_ref: z.number(),
  mass_ref: z.number(),
  charge_ref: z.number(),
  speed_of_light: z.union([z.number(), z.literal("inf")]).optional(),
});

const PhysicsAttrsSchema = z.object({
  relativistic: z.boolean().optional(),
  gamma_eos: z.number().optional(),
  gamma: z.number().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const TimeAttrsSchema = z.object({ dt: z.number().optional() });

const BoundaryConditionsAttrsSchema = z.object({
  lower: z.array(z.string()).optional(),
  upper: z.array(z.string()).optional(),
});

const StaggerAttrsSchema = z.object({
  convention: z.enum(["cell", "node", "staggered"]),
  field_locations: z.record(z.string(), z.string()).nullable().optional(),
  position: z.record(z.string(), z.array(z.number())).nullable().optional(),
  interpolation_order: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const REDUCTION_OPS = [
  "integrate",
  "sum",
  "mean",
  "median",
  "max",
  "min",
  "std",
  "var",
  "argmax",
  "argmin",
] as const satisfies readonly ReductionOp[];

const ReductionAttrsSchema = z.object({
  axis: z.union([z.string(), z.array(z.string())]),
  op: z.enum(REDUCTION_OPS),
  result_kind: z.literal("axis_position").optional(),
  weight: z.string().optional(),
  length_axes: z.number().int().optional(),
});

const FieldAttrsSchema = z.object({
  long_name: z.string().optional(),
  units: z.string().optional(),
  quantity_type: z.string().optional(),
  si_unit: z.string().optional(),
  latex: z.string().optional(),
  unit_dimension: z.array(z.number()).nullable().optional(),
  reduction: ReductionAttrsSchema.optional(),
});

function parseBlock<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label}: ${formatZodError(result.error)}`, { cause: result.error });
  }
  return result.data;
}

// Schema-version gate; mirrors pypic.io.zarr._open_store.
export function assertPypicSchema(rootAttrs: Record<string, unknown>, source: string): void {
  const parsed = SchemaDiscriminatorSchema.safeParse(rootAttrs.schema);
  if (!parsed.success) {
    throw new Error(
      `${source}: no pypic metadata found (expected a schema.version discriminator)`,
      {
        cause: parsed.error,
      },
    );
  }
  if (parsed.data.version !== SCHEMA_VERSION) {
    throw new Error(
      `${source}: schema.version=${JSON.stringify(parsed.data.version)} but webpic expects ` +
        `${JSON.stringify(SCHEMA_VERSION)}; cannot decode safely`,
    );
  }
}

const DEFAULT_AXIS_LABELS: Record<GeometryType, readonly string[]> = {
  cartesian: ["x", "y", "z"],
  spherical: ["r", "theta", "phi"],
  cylindrical: ["r", "phi", "z"],
  thetaMode: ["r", "z"],
};

function decodeStagger(raw: unknown): StaggerInfo | null {
  if (raw === undefined || raw === null) return null;
  const stagger = parseBlock(StaggerAttrsSchema, raw, "grid.stagger");
  const position =
    stagger.position == null
      ? null
      : Object.fromEntries(
          Object.entries(stagger.position).map(([k, v]) => [
            k,
            vec3(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0),
          ]),
        );
  return {
    convention: stagger.convention,
    fieldLocations: stagger.field_locations ?? null,
    position,
    interpolationOrder: stagger.interpolation_order ?? null,
    notes: stagger.notes ?? null,
  };
}

export interface DecodedGrid {
  readonly grid: GridInfo;
  readonly frame: string;
  readonly transforms: Readonly<Record<string, unknown>>;
}

export function decodeGrid(rootAttrs: Record<string, unknown>, source: string): DecodedGrid {
  const grid = parseBlock(GridAttrsSchema, rootAttrs.grid, `${source}.grid`);
  const coords = parseBlock(CoordinatesAttrsSchema, rootAttrs.coordinates, `${source}.coordinates`);
  const ndim = grid.dimensions.length;
  const origin = grid.lower ?? grid.origin ?? grid.dimensions.map(() => 0);
  const axisLabels = (coords.axis_labels ?? DEFAULT_AXIS_LABELS[coords.geometry]).slice(0, ndim);

  let dt: number | null = null;
  if (rootAttrs.time !== undefined) {
    dt = parseBlock(TimeAttrsSchema, rootAttrs.time, `${source}.time`).dt ?? null;
  }
  let boundary: readonly string[] | null = null;
  if (rootAttrs.boundary_conditions !== undefined) {
    boundary =
      parseBlock(
        BoundaryConditionsAttrsSchema,
        rootAttrs.boundary_conditions,
        `${source}.boundary_conditions`,
      ).lower ?? null;
  }

  const gridInfo: GridInfo = {
    dimensions: grid.dimensions,
    spacing: grid.spacing,
    origin,
    geometry: coords.geometry,
    axisLabels,
    dt,
    boundary,
    survivingAxes: grid.surviving_axes ?? null,
    stagger: decodeStagger(grid.stagger),
  };
  return {
    grid: gridInfo,
    frame: coords.frame ?? "simulation",
    // pypic writes transforms as an untagged JSON object, so the top level decodes to a plain record.
    transforms: fromJsonNative(coords.transforms ?? {}) as Record<string, unknown>,
  };
}

export function decodeNormalization(
  rootAttrs: Record<string, unknown>,
  source: string,
): Normalization {
  const n = parseBlock(
    NormalizationAttrsSchema,
    rootAttrs.normalization,
    `${source}.normalization`,
  );
  return {
    lengthRef: n.length_ref,
    timeRef: n.time_ref,
    velocityRef: n.velocity_ref,
    bFieldRef: n.b_field_ref,
    eFieldRef: n.e_field_ref,
    densityRef: n.density_ref,
    massRef: n.mass_ref,
    chargeRef: n.charge_ref,
    speedOfLight: decodeSpeedOfLight(n.speed_of_light),
  };
}

export function decodePhysics(
  rootAttrs: Record<string, unknown>,
  normalization: Normalization,
  source: string,
): PhysicsParams {
  const p =
    rootAttrs.physics === undefined
      ? {}
      : parseBlock(PhysicsAttrsSchema, rootAttrs.physics, `${source}.physics`);
  return {
    gamma: p.gamma_eos ?? p.gamma ?? 5 / 3,
    c: normalization.speedOfLight,
    relativistic: p.relativistic ?? false,
    // extra's top level is a zod-validated record and dicts are untagged, so it decodes to a record.
    extra: fromJsonNative(p.extra ?? {}) as Record<string, unknown>,
  };
}

export function decodeReduction(raw: unknown): ReductionSpec | null {
  if (raw === undefined || raw === null) return null;
  const reduction = parseBlock(ReductionAttrsSchema, raw, "field.reduction");
  return {
    axis: reduction.axis,
    op: reduction.op,
    ...(reduction.result_kind !== undefined ? { resultKind: reduction.result_kind } : {}),
    ...(reduction.weight !== undefined ? { weight: reduction.weight } : {}),
    ...(reduction.length_axes !== undefined ? { lengthAxes: reduction.length_axes } : {}),
  };
}

export interface DecodedFieldAttrs {
  readonly units: string;
  readonly latex: string;
  readonly reduction: ReductionSpec | null;
}

export function decodeFieldAttrs(rawAttrs: unknown, name: string): DecodedFieldAttrs {
  const attrs = parseBlock(FieldAttrsSchema, rawAttrs ?? {}, `field "${name}" attrs`);
  return {
    units: attrs.units ?? "",
    latex: attrs.latex ?? "",
    reduction: decodeReduction(attrs.reduction),
  };
}

// Re-stuff the reserved root attrs (attrs.run / attrs.simulation_toml / attrs.model) into
// the metadata bag under their pypic reserved keys, mirroring pypic.io.metadata
// .decode_pypic_attrs — the in-memory FieldDataset shape stays one bag, and the writer
// lifts them back out. Carried verbatim (no Zod): normalizing attrs.run through a
// strip-mode schema would silently drop additive v1.x fields and corrupt the round-trip.
export function mergeReservedRootAttrs(
  rootAttrs: Record<string, unknown>,
  metadata: Readonly<Record<string, unknown>>,
  source: string,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...metadata };
  if (rootAttrs.model !== undefined && rootAttrs.model !== null) {
    out.model = fromJsonNative(rootAttrs.model);
  }
  if (rootAttrs.run !== undefined && rootAttrs.run !== null) {
    if (!isRecord(rootAttrs.run)) {
      throw new Error(`${source}.run: expected a JSON object`);
    }
    out.run = fromJsonNative(rootAttrs.run);
  }
  if (rootAttrs.simulation_toml !== undefined && rootAttrs.simulation_toml !== null) {
    if (typeof rootAttrs.simulation_toml !== "string") {
      throw new Error(`${source}.simulation_toml: expected a string of TOML source`);
    }
    out.simulation_toml = rootAttrs.simulation_toml;
  }
  return out;
}

import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import { fieldInfo } from "@schema/registry.ts";

// Synthetic single-cell datasets for the compute/store/app unit tests. Keeps the
// verbose normalization/physics boilerplate in one place; mirrors the canonical
// FieldDataset shape so the math layers consume it unchanged.

export function dummyGrid(dimensions: readonly number[] = [1]): GridInfo {
  const rank = dimensions.length;
  return {
    dimensions: [...dimensions],
    spacing: Array.from({ length: rank }, () => 1),
    origin: Array.from({ length: rank }, () => 0),
    geometry: "cartesian",
    axisLabels: ["x", "y", "z"].slice(0, rank),
    dt: null,
    boundary: null,
    survivingAxes: null,
    stagger: null,
  };
}

export function fieldArray(
  name: string,
  data: Float32Array | Float64Array,
  shape: readonly number[],
): FieldArray {
  const meta = fieldInfo(name);
  return { data, shape: [...shape], meta, units: meta.siUnit, latex: meta.latex, reduction: null };
}

export function makeDataset(
  fields: Record<string, FieldArray>,
  overrides: { grid?: GridInfo } = {},
): FieldDataset {
  return {
    fields: new Map(Object.entries(fields)),
    grid: overrides.grid ?? dummyGrid(),
    normalization: {
      lengthRef: 1,
      timeRef: 1,
      velocityRef: 1,
      bFieldRef: 1,
      eFieldRef: 1,
      densityRef: 1,
      massRef: 1,
      chargeRef: 1,
      speedOfLight: Number.POSITIVE_INFINITY,
    },
    species: [],
    physics: { gamma: 1, c: Number.POSITIVE_INFINITY, relativistic: false, extra: {} },
    frame: "lab",
    transforms: {},
    metadata: {},
    step: 0,
  };
}

// Single-cell vector triple (3, 4, 0) → magnitude 5, the ubiquitous magnitude fixture.
export function vectorTriple(
  prefix: string,
  opts: {
    array?: Float32ArrayConstructor | Float64ArrayConstructor;
    dims?: readonly number[];
  } = {},
): FieldDataset {
  const ArrayCtor = opts.array ?? Float64Array;
  const dims = opts.dims ?? [1];
  const component = (axis: number, value: number): FieldArray =>
    fieldArray(`${prefix}_${axis}`, new ArrayCtor([value]), dims);
  return makeDataset(
    {
      [`${prefix}_1`]: component(1, 3),
      [`${prefix}_2`]: component(2, 4),
      [`${prefix}_3`]: component(3, 0),
    },
    { grid: dummyGrid(dims) },
  );
}

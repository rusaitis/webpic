import type { FieldArray, FieldDataset, GridInfo } from "@containers/field_dataset.ts";
import { fieldInfo } from "@schema/registry.ts";

// Synthetic grids, fields and datasets for the compute/store/app/render tests. Keeps the verbose
// normalization/physics boilerplate in one place; mirrors the canonical FieldDataset shape so the
// math layers consume it unchanged. Anything a suite needs on top rides a spread, not a new
// parameter (`{ ...makeGrid([4, 4, 4]), stagger }`).

export function makeGrid(
  dimensions: readonly number[] = [1],
  spacing?: readonly number[],
  origin?: readonly number[],
): GridInfo {
  const rank = dimensions.length;
  return {
    dimensions: [...dimensions],
    spacing: spacing ? [...spacing] : Array.from({ length: rank }, () => 1),
    origin: origin ? [...origin] : Array.from({ length: rank }, () => 0),
    geometry: "cartesian",
    axisLabels: ["x", "y", "z"].slice(0, rank),
    dt: null,
    boundary: null,
    survivingAxes: null,
    stagger: null,
  };
}

export function makeField(
  name: string,
  data: Float32Array | Float64Array,
  shape: readonly number[],
  overrides: Partial<FieldArray> = {},
): FieldArray {
  const meta = fieldInfo(name);
  return {
    data,
    shape: [...shape],
    meta,
    units: meta.siUnit,
    latex: meta.latex,
    reduction: null,
    ...overrides,
  };
}

export function makeDataset(
  fields: Record<string, FieldArray>,
  overrides: Partial<FieldDataset> = {},
): FieldDataset {
  return {
    fields: new Map(Object.entries(fields)),
    grid: makeGrid(),
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
    ...overrides,
  };
}

// Single-cell vector triple (3, 4, 0) → magnitude 5, the ubiquitous magnitude fixture.
export function vectorTriple(
  prefix: string,
  options: {
    array?: Float32ArrayConstructor | Float64ArrayConstructor;
    dims?: readonly number[];
  } = {},
): FieldDataset {
  const ArrayCtor = options.array ?? Float64Array;
  const dims = options.dims ?? [1];
  const component = (axis: number, value: number): FieldArray =>
    makeField(`${prefix}_${axis}`, new ArrayCtor([value]), dims);
  return makeDataset(
    {
      [`${prefix}_1`]: component(1, 3),
      [`${prefix}_2`]: component(2, 4),
      [`${prefix}_3`]: component(3, 0),
    },
    { grid: makeGrid(dims) },
  );
}

// A unit-valued ball of `radius` centred at object-space `center` (zero outside), shape [n, n, n].
// Object axis i ↔ field axis i, so voxel (i0, i1, i2) sits at object ((i + 0.5)/n − 0.5) per axis —
// an off-centre ball is the fixture that fails loudly on a transposed upload or a wrong NDC basis.
export function ballField(
  center: readonly [number, number, number],
  radius: number,
  n = 16,
): { data: Float32Array; shape: readonly number[] } {
  const data = new Float32Array(n * n * n);
  for (let i0 = 0; i0 < n; i0++) {
    for (let i1 = 0; i1 < n; i1++) {
      for (let i2 = 0; i2 < n; i2++) {
        const dx = (i0 + 0.5) / n - 0.5 - center[0];
        const dy = (i1 + 0.5) / n - 0.5 - center[1];
        const dz = (i2 + 0.5) / n - 0.5 - center[2];
        if (Math.hypot(dx, dy, dz) < radius) data[i2 + n * (i1 + n * i0)] = 1;
      }
    }
  }
  return { data, shape: [n, n, n] };
}

import type { FieldArray, FieldDataset, GridInfo, StaggerInfo } from "@containers/field_dataset.ts";
import type { FieldName, FloatArray } from "@schema/types.ts";

// Destagger Yee-mesh fields to a co-located cell-centered grid on load (mirrors pypic._stagger).
// Each axis whose openPMD `position` offset differs from the 0.5 cell-center target is half-cell
// averaged (0.5*(arr[:-1] + arr[1:])), shrinking it by one element. Offsets must be 0.0 or 0.5 —
// constrained-transport (vector-potential) reconstruction is out of scope.

const CELL_CENTER = 0.5;
const OFFSET_ATOL = 1e-9;

function allocLike(sample: FloatArray, length: number): FloatArray {
  return sample instanceof Float64Array ? new Float64Array(length) : new Float32Array(length);
}

function isHalfCell(value: number): boolean {
  return Math.abs(value) <= OFFSET_ATOL || Math.abs(value - CELL_CENTER) <= OFFSET_ATOL;
}

function isClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= OFFSET_ATOL;
}

// Linear half-cell average along `axis`; output is one element shorter along that axis.
export function averageAlong(
  data: FloatArray,
  shape: readonly number[],
  axis: number,
): { data: FloatArray; shape: number[] } {
  if (axis < 0 || axis >= shape.length) {
    throw new Error(`averageAlong: axis ${axis} out of range for ndim ${shape.length}`);
  }
  // Collapse C-order layout into outer (dims before axis) × mid (axis) × inner (dims after).
  let outer = 1;
  for (let k = 0; k < axis; k++) outer *= shape[k] ?? 1;
  const mid = shape[axis] ?? 1;
  let inner = 1;
  for (let k = axis + 1; k < shape.length; k++) inner *= shape[k] ?? 1;

  const outMid = mid - 1;
  const out = allocLike(data, outer * outMid * inner);
  for (let o = 0; o < outer; o++) {
    const inSlab = o * mid * inner;
    const outSlab = o * outMid * inner;
    for (let j = 0; j < outMid; j++) {
      const loBase = inSlab + j * inner;
      const hiBase = loBase + inner; // the j+1 plane
      const outBase = outSlab + j * inner;
      for (let i = 0; i < inner; i++) {
        // Indices are in-bounds by construction; ?? 0 satisfies noUncheckedIndexedAccess.
        out[outBase + i] = 0.5 * ((data[loBase + i] ?? 0) + (data[hiBase + i] ?? 0));
      }
    }
  }
  const outShape = [...shape];
  outShape[axis] = outMid;
  return { data: out, shape: outShape };
}

// Linearly interpolate one Yee-staggered array to cell centers (target offset 0.5 on every axis):
// compose a half-cell average along each axis where `source` differs from 0.5. Returns the input
// array unchanged (same reference) when no axis shifts.
export function destaggerArrayToCellCenters(
  data: FloatArray,
  shape: readonly number[],
  source: readonly number[],
): { data: FloatArray; shape: number[] } {
  if (source.length !== shape.length) {
    throw new Error(
      `destagger: source position has length ${source.length} but array has ndim ${shape.length}`,
    );
  }
  for (const offset of source) {
    if (!isHalfCell(offset)) {
      throw new Error(
        `destagger: position offset ${offset} is not in {0.0, 0.5} — linear destagger supports half-cell shifts only`,
      );
    }
  }
  let result = data;
  let resultShape = [...shape];
  for (let axis = 0; axis < shape.length; axis++) {
    if (!isClose(source[axis] ?? 0, CELL_CENTER)) {
      const averaged = averageAlong(result, resultShape, axis);
      result = averaged.data;
      resultShape = averaged.shape;
    }
  }
  return { data: result, shape: resultShape };
}

function computeStrides(shape: readonly number[]): number[] {
  const strides = new Array<number>(shape.length);
  let acc = 1;
  for (let k = shape.length - 1; k >= 0; k--) {
    strides[k] = acc;
    acc *= shape[k] ?? 1;
  }
  return strides;
}

// Trim trailing samples per axis so a C-order `data`/`shape` array fits `target` (≤ shape).
function cropToShape(
  data: FloatArray,
  shape: readonly number[],
  target: readonly number[],
): FloatArray {
  const ndim = shape.length;
  const srcStrides = computeStrides(shape);
  let outLen = 1;
  for (const n of target) outLen *= n;
  const out = allocLike(data, outLen);
  const idx = new Array<number>(ndim).fill(0);
  for (let o = 0; o < outLen; o++) {
    let src = 0;
    for (let k = 0; k < ndim; k++) src += (idx[k] ?? 0) * (srcStrides[k] ?? 0);
    out[o] = data[src] ?? 0;
    for (let k = ndim - 1; k >= 0; k--) {
      const next = (idx[k] ?? 0) + 1;
      if (next < (target[k] ?? 0)) {
        idx[k] = next;
        break;
      }
      idx[k] = 0;
    }
  }
  return out;
}

/**
 * Destagger every off-cell-center field in `dataset` to a single co-located cell-centered
 * grid. Reads per-component offsets from `grid.stagger.position`. Co-located stores (no
 * stagger, or an empty/all-cell-center position map) return the same object unchanged.
 *
 * Half-cell averaging leaves components shorter by one along each shifted axis; the result
 * is cropped to the common (elementwise-min) shape so all fields share one uniform grid.
 */
export function destaggerToColocated(dataset: FieldDataset): FieldDataset {
  const position = dataset.grid.stagger?.position ?? null;
  if (position === null || Object.keys(position).length === 0) return dataset;

  const ndim = dataset.grid.dimensions.length;

  type Pending = { field: FieldArray; data: FloatArray; shape: number[] };
  const pending = new Map<FieldName, Pending>();
  let anyShifted = false;
  for (const [name, field] of dataset.fields) {
    const source = position[name];
    if (source === undefined) {
      pending.set(name, { field, data: field.data, shape: [...field.shape] });
      continue;
    }
    // Stored positions are length-3 Vec3; a lower-rank field uses the leading offsets.
    const { data, shape } = destaggerArrayToCellCenters(
      field.data,
      field.shape,
      source.slice(0, field.shape.length),
    );
    if (data !== field.data) anyShifted = true;
    pending.set(name, { field, data, shape });
  }
  if (!anyShifted) return dataset; // positions present but every field already cell-centered

  const common = [...dataset.grid.dimensions];
  for (const { shape } of pending.values()) {
    if (shape.length !== ndim) continue;
    for (let k = 0; k < ndim; k++) common[k] = Math.min(common[k] ?? 0, shape[k] ?? 0);
  }

  const fields = new Map<FieldName, FieldArray>();
  for (const [name, p] of pending) {
    let { data, shape } = p;
    if (shape.length === ndim && shape.some((s, k) => s > (common[k] ?? s))) {
      data = cropToShape(data, shape, common);
      shape = [...common];
    }
    fields.set(name, data === p.field.data ? p.field : { ...p.field, data, shape });
  }

  const colocated: StaggerInfo = {
    convention: "cell",
    fieldLocations: null,
    position: null,
    interpolationOrder: 1,
    notes: "linear half-cell destagger to cell centers; cropped to common shape",
  };
  const grid: GridInfo = { ...dataset.grid, dimensions: common, stagger: colocated };
  return { ...dataset, fields, grid };
}

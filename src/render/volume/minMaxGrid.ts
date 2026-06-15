import { ClampToEdgeWrapping, Data3DTexture, FloatType, NearestFilter, RedFormat } from "three";
import type { ScalarField } from "./volumeTexture.ts";

// Coarse per-brick min/max over the volume — the acceleration structure for the raymarcher's empty-
// space skipping. A brick whose *max* value maps below an opacity ε contributes nothing to the
// emission–absorption integral, so the march jumps across it instead of stepping through transparent
// space. One coarse level (not a full min-max mip pyramid) drives a two-level coarse-skip / fine-march
// traversal — bounded and hang-proof, no recursive HDDA.
//
// The layout MIRRORS volumeTexture.ts so the same object→texture coords index both: texture dims
// (width, height, depth) = (shape[2], shape[1], shape[0]), buffer x-fastest. A 1-voxel HALO is folded
// into each brick so the stored max bounds any *trilinear* sample inside the brick (a sample at the
// brick face interpolates one voxel into the neighbour) — the skip therefore never drops a visible
// contribution. Non-finite voxels fold to `fallback` (the volume's global min), matching the
// NaN/Inf→min substitution the volume upload makes, so the brick bound reflects what the GPU samples.

const HALO = 1; // the trilinear stencil reaches one voxel past a brick face

export interface MinMaxGrid {
  /** Per-brick cleaned min (x-fastest). Computed + tested; not yet uploaded (homogeneous early-out is future). */
  readonly min: Float32Array;
  /** Per-brick cleaned max (x-fastest) — the conservative empty-space-skip bound the raymarch reads. */
  readonly max: Float32Array;
  /** Brick counts per axis, (width, height, depth) — same axis order as the volume texture. */
  readonly dims: readonly [number, number, number];
  readonly brickSize: number;
}

/** Reduce a 3D field to per-brick [min, max] over `brickSize`-wide bricks (+1-voxel halo). */
export function buildMinMaxGrid(
  field: ScalarField,
  brickSize: number,
  fallback: number,
): MinMaxGrid {
  const { data, shape } = field;
  if (shape.length !== 3) {
    throw new Error(`buildMinMaxGrid: expected a 3D field, got shape [${shape.join(", ")}]`);
  }
  if (!Number.isInteger(brickSize) || brickSize < 1) {
    throw new Error(`buildMinMaxGrid: brickSize must be a positive integer, got ${brickSize}`);
  }
  const [depth, height, width] = shape as readonly [number, number, number]; // length checked above
  const gridWidth = Math.ceil(width / brickSize);
  const gridHeight = Math.ceil(height / brickSize);
  const gridDepth = Math.ceil(depth / brickSize);
  const min = new Float32Array(gridWidth * gridHeight * gridDepth);
  const max = new Float32Array(gridWidth * gridHeight * gridDepth);

  for (let cz = 0; cz < gridDepth; cz++) {
    const z0 = Math.max(0, cz * brickSize - HALO);
    const z1 = Math.min(depth, (cz + 1) * brickSize + HALO);
    for (let cy = 0; cy < gridHeight; cy++) {
      const y0 = Math.max(0, cy * brickSize - HALO);
      const y1 = Math.min(height, (cy + 1) * brickSize + HALO);
      for (let cx = 0; cx < gridWidth; cx++) {
        const x0 = Math.max(0, cx * brickSize - HALO);
        const x1 = Math.min(width, (cx + 1) * brickSize + HALO);
        let minValue = Number.POSITIVE_INFINITY;
        let maxValue = Number.NEGATIVE_INFINITY;
        for (let z = z0; z < z1; z++) {
          for (let y = y0; y < y1; y++) {
            const rowBase = width * (y + height * z);
            for (let x = x0; x < x1; x++) {
              const raw = data[x + rowBase];
              const v = raw === undefined || !Number.isFinite(raw) ? fallback : raw;
              if (v < minValue) minValue = v;
              if (v > maxValue) maxValue = v;
            }
          }
        }
        const brickIndex = cx + gridWidth * (cy + gridHeight * cz);
        min[brickIndex] = minValue;
        max[brickIndex] = maxValue;
      }
    }
  }
  return { min, max, dims: [gridWidth, gridHeight, gridDepth], brickSize };
}

export interface SkipTexture {
  readonly texture: Data3DTexture;
  /** (width, height, depth) brick counts — drives the in-shader brick-boundary DDA. */
  readonly dims: readonly [number, number, number];
  dispose(): void;
}

/**
 * Upload a grid's per-brick max as a nearest-sampled R32F 3D texture — the skip bound the raymarch
 * reads. R32F + nearest needs no `float32-filterable` (that feature gates only *linear* sampling), so
 * it is safe on every device, including the Metal path where R16F+trilinear is not (see the volume's
 * format dance). Nearest is mandatory: linear filtering would interpolate adjacent bricks' maxima.
 */
export function createSkipTexture(grid: MinMaxGrid): SkipTexture {
  const [gridWidth, gridHeight, gridDepth] = grid.dims;
  const texture = new Data3DTexture(grid.max, gridWidth, gridHeight, gridDepth);
  texture.format = RedFormat;
  texture.type = FloatType;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  texture.needsUpdate = true; // mandatory — the backend never uploads otherwise
  return {
    texture,
    dims: grid.dims,
    dispose() {
      texture.dispose();
    },
  };
}

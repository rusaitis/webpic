import type { FloatArray } from "@schema/types.ts";
import {
  ClampToEdgeWrapping,
  Data3DTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  LinearFilter,
  RedFormat,
} from "three";

// The volume holds physical values; the shader normalizes via min/max uniforms so values stay
// resident for later window/level without re-uploading. Format depends on the device:
//   • float32-filterable present → R32F + linear (trilinear). The stable Metal path: f16 trilinear
//     3D sampling is unreliable on some Metal drivers (returns NaN / loses the device).
//   • absent → R16F (half-float) + linear, the core-filterable fallback.

// Just the typed array + shape the upload needs — a `FieldArray` is structurally assignable,
// and it lets the render worker reconstruct a slice input from a transferred buffer without
// carrying `meta`/`units` over the wire.
export interface ScalarField {
  readonly data: FloatArray;
  readonly shape: readonly number[];
}

export interface VolumeTexture {
  readonly texture: Data3DTexture;
  /** Finite data range; `max > min` always (constant fields are widened by 1). */
  readonly min: number;
  readonly max: number;
  dispose(): void;
}

/** Build a `Data3DTexture` (R32F when `float32Filterable`, else R16F) + finite range from a field. */
export function createVolumeTexture(field: ScalarField, float32Filterable = false): VolumeTexture {
  const { data, shape } = field;
  if (shape.length !== 3) {
    throw new Error(`createVolumeTexture: expected a 3D field, got shape [${shape.join(", ")}]`);
  }
  // C-order: shape[2] is the fastest-varying (contiguous) axis. A Data3DTexture is
  // x-fastest (data[x + w*(y + h*z)]), so width=shape[2], depth=shape[0] uploads the
  // buffer verbatim — no transpose. Texture axes are the reverse of the field/axisLabels
  // axes; sliceScene maps the slice plane onto that reversal.
  const [depth, height, width] = shape as readonly [number, number, number]; // length checked above

  // Finite-only range in one pass; non-finite samples are excluded and replaced by `min`
  // on pack so a stray NaN/inf cannot poison a trilinear-filtered neighborhood.
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === undefined || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) {
    min = 0; // no finite samples at all
    max = 1;
  } else if (min === max) {
    max = min + 1; // constant field — keep the normalization divide finite
  }

  // Non-finite samples pack to `min` so a stray NaN/inf can't poison a filtered neighborhood.
  const clean = (v: number | undefined): number =>
    v === undefined || !Number.isFinite(v) ? min : v;
  const voxels = width * height * depth;

  let texture: Data3DTexture;
  if (float32Filterable) {
    const packed = new Float32Array(voxels);
    for (let i = 0; i < voxels; i++) packed[i] = clean(data[i]);
    texture = new Data3DTexture(packed, width, height, depth);
    texture.type = FloatType;
  } else {
    const packed = new Uint16Array(voxels);
    for (let i = 0; i < voxels; i++) packed[i] = DataUtils.toHalfFloat(clean(data[i]));
    texture = new Data3DTexture(packed, width, height, depth);
    texture.type = HalfFloatType;
  }
  texture.format = RedFormat;
  // Data3DTexture defaults to NearestFilter; Linear gives the trilinear interpolation the
  // slice samples across.
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  // Clamp at the volume bounds so edge samples don't bleed in wrapped neighbours.
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  texture.needsUpdate = true; // mandatory — the backend never uploads otherwise

  return {
    texture,
    min,
    max,
    dispose() {
      texture.dispose();
    },
  };
}

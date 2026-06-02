import type { FloatArray } from "@schema/types.ts";
import {
  ClampToEdgeWrapping,
  Data3DTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RedFormat,
} from "three";

// R16F (half-float) holds physical values and is filterable in core WebGPU (r32float would
// need the `float32-filterable` feature we don't request), so the shader normalizes via min/max
// uniforms — physical values stay resident for later window/level without re-uploading.

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

/** Build a half-float `Data3DTexture` + finite range from a 3D scalar field. */
export function createVolumeTexture(field: ScalarField): VolumeTexture {
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

  const packed = new Uint16Array(width * height * depth);
  for (let i = 0; i < packed.length; i++) {
    const v = data[i];
    packed[i] = DataUtils.toHalfFloat(v === undefined || !Number.isFinite(v) ? min : v);
  }

  const texture = new Data3DTexture(packed, width, height, depth);
  texture.format = RedFormat;
  texture.type = HalfFloatType;
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

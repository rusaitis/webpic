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
import { texture3D } from "three/tsl";

// The volume holds physical values; the materials normalize via window/level uniforms so values stay
// resident for later window/level edits without re-uploading. Format depends on the device:
//   • float32-filterable present → R32F + linear (trilinear). The stable Metal path: f16 trilinear
//     3D sampling is unreliable on some Metal drivers (returns NaN / loses the device).
//   • absent → R16F (half-float) + linear, the core-filterable fallback.
//
// Time-series streaming (M2.10b) ping-pongs new timesteps through `setField`: it writes the field
// into the *inactive* of two identically-configured textures and swaps the sampling node's value
// (NodeSampledTexture.update reads node.value each frame and rebinds when it changes — a bind-group
// swap, not a pipeline recompile), so a scrub reuses the scene's geometry/material/transfer-function
// with no per-step rebuild of the 64 MiB pipeline. The second buffer is allocated lazily on the
// first swap, so a static (never-streamed) layer holds one texture.

// Just the typed array + shape the upload needs — a `FieldArray` is structurally assignable,
// and it lets the render worker reconstruct a slice input from a transferred buffer without
// carrying `meta`/`units` over the wire.
export interface ScalarField {
  readonly data: FloatArray;
  readonly shape: readonly number[];
}

// The TSL node the materials sample; sample through `node.sample(coord)`. Its `value` swaps in place
// on `setField`. Typed from the factory so we don't import the (loosely-typed) Texture3DNode name.
type VolumeNode = ReturnType<typeof texture3D>;

export interface VolumeTexture {
  /** TSL node the materials sample (via `node.sample(coord)`); its value swaps in place on setField. */
  readonly node: VolumeNode;
  /** Finite range of the *initial* field; `max > min` always (constant fields are widened by 1). */
  readonly min: number;
  readonly max: number;
  /** Ping-pong a new timestep into the inactive buffer and swap the node's value — no rebuild and no
   *  re-normalization (the window/level stays the binding's, the correct fixed range for a series).
   *  Returns false WITHOUT swapping when the field can't reuse the allocation (a shape mismatch); the
   *  caller then rebuilds the scene. */
  setField(field: ScalarField): boolean;
  dispose(): void;
}

interface PingPongBuffer {
  readonly texture: Data3DTexture;
  readonly array: Float32Array | Uint16Array; // the texture's CPU image, rewritten in place on swap
}

// Finite-only range in one pass; non-finite samples are excluded. Constant/empty fields are widened
// so the normalization divide stays finite. Mirrors the pack-time NaN→min fill below.
function finiteRange(data: FloatArray): { readonly min: number; readonly max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === undefined || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) return { min: 0, max: 1 }; // no finite samples at all
  if (min === max) return { min, max: min + 1 }; // constant field — keep the divide finite
  return { min, max };
}

// Pack a field into `out` (R32F float | R16F half), replacing non-finite samples with `fill` so a
// stray NaN/inf can't poison a trilinear-filtered neighborhood. The array-type branch is hoisted out
// of the per-voxel loop (16.7M voxels at 256³).
function packInto(out: Float32Array | Uint16Array, data: FloatArray, fill: number): void {
  if (out instanceof Uint16Array) {
    for (let i = 0; i < out.length; i++) {
      const v = data[i];
      out[i] = DataUtils.toHalfFloat(v === undefined || !Number.isFinite(v) ? fill : v);
    }
  } else {
    for (let i = 0; i < out.length; i++) {
      const v = data[i];
      out[i] = v === undefined || !Number.isFinite(v) ? fill : v;
    }
  }
}

/** Build a ping-pong-capable volume (R32F when `float32Filterable`, else R16F) + finite range. */
export function createVolumeTexture(field: ScalarField, float32Filterable = false): VolumeTexture {
  const { shape } = field;
  if (shape.length !== 3) {
    throw new Error(`createVolumeTexture: expected a 3D field, got shape [${shape.join(", ")}]`);
  }
  // C-order: shape[2] is the fastest-varying (contiguous) axis. A Data3DTexture is x-fastest
  // (data[x + w*(y + h*z)]), so width=shape[2], depth=shape[0] uploads the buffer verbatim — no
  // transpose. Texture axes are the reverse of the field/axisLabels axes; sliceScene maps the slice
  // plane onto that reversal.
  const [depth, height, width] = shape as readonly [number, number, number]; // length checked above
  const voxels = width * height * depth;

  const { min, max } = finiteRange(field.data);

  const makeBuffer = (data: FloatArray, fill: number): PingPongBuffer => {
    const array = float32Filterable ? new Float32Array(voxels) : new Uint16Array(voxels);
    packInto(array, data, fill);
    const texture = new Data3DTexture(array, width, height, depth);
    texture.type = float32Filterable ? FloatType : HalfFloatType;
    texture.format = RedFormat;
    // Data3DTexture defaults to NearestFilter; Linear gives the trilinear interpolation the slice +
    // raymarch sample across.
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    // Clamp at the volume bounds so edge samples don't bleed in wrapped neighbours.
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.wrapR = ClampToEdgeWrapping;
    texture.needsUpdate = true; // mandatory — the backend never uploads otherwise
    return { texture, array };
  };

  // Two-slot ping-pong; the second slot is allocated lazily on the first setField so a static layer
  // holds one texture. `active` indexes the live slot the node samples.
  const front = makeBuffer(field.data, min);
  const buffers: [PingPongBuffer, PingPongBuffer | undefined] = [front, undefined];
  let active = 0;
  const node = texture3D(front.texture);

  return {
    node,
    min,
    max,
    setField(next) {
      if (next.shape.length !== 3) return false;
      const [d, h, w] = next.shape as readonly [number, number, number]; // length checked above
      if (w !== width || h !== height || d !== depth) return false; // shape change → caller rebuilds
      // NaN→this step's own floor (a local pack detail); the window/level normalization is unchanged.
      const fill = finiteRange(next.data).min;
      const slot = active ^ 1; // the inactive buffer
      let target = buffers[slot];
      if (target === undefined) {
        target = makeBuffer(next.data, fill);
        buffers[slot] = target;
      } else {
        packInto(target.array, next.data, fill);
        target.texture.needsUpdate = true; // re-upload the rewritten image on the next bind
      }
      active = slot;
      node.value = target.texture; // the binding rebinds to this on the next frame
      return true;
    },
    dispose() {
      front.texture.dispose();
      buffers[1]?.texture.dispose();
    },
  };
}

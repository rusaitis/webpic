import { releaseAlloc, trackAlloc } from "@gpu/vramLedger.ts";
import { finiteMin, finiteRange, type ValueRange } from "@reductions";
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

// The volume holds physical values; the materials normalize via window/level uniforms, so a
// window edit never re-uploads. Format follows the device: float32-filterable present → R32F +
// linear (the Metal-stable path — f16 trilinear 3D sampling returns NaN or loses the device on some
// Metal drivers); absent → R16F + linear, the core-filterable fallback. Streaming ping-pongs new
// timesteps through `setField`, writing into the *inactive* of two identical textures and swapping
// the node's value (a bind-group rebind, not a recompile); the second is allocated on first swap.

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
  // TSL node the materials sample (via `node.sample(coord)`); its value swaps in place on setField.
  readonly node: VolumeNode;
  // Finite range of the *initial* field; `max > min` always (constant fields are widened by 1).
  readonly min: number;
  readonly max: number;
  // Ping-pong a new timestep into the inactive buffer and swap the node's value — no rebuild and no
  // re-normalization (the window/level stays the binding's, the correct fixed range for a series).
  // Returns false WITHOUT swapping when the field can't reuse the allocation (a shape mismatch); the
  // caller then rebuilds the scene.
  setField(field: ScalarField): boolean;
  dispose(): void;
}

interface PingPongBuffer {
  readonly texture: Data3DTexture;
  readonly array: Float32Array | Uint16Array; // the texture's CPU image, rewritten in place on swap
}

// The upload's range when no sample is finite (an all-NaN step): a unit range keeps the normalization
// divide finite, and its min (0) is the NaN fill packInto substitutes — so the construction-time and
// streamed fills stay identical. Exported for the worker's pickRay fallback window.
export const NO_FINITE_RANGE: ValueRange = { min: 0, max: 1 };

// Pack a field into `out` (R32F float | R16F half), replacing non-finite samples with `fill` so a
// stray NaN/inf can't poison a trilinear-filtered neighborhood. Array-type branch hoisted out of the
// per-voxel loop (16.7M voxels at 256³).
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

// Build a ping-pong-capable volume (R32F when `hasFloat32Filterable`, else R16F) + finite range.
// `ledgerKey` (the layer id) options the two texture slots into the VRAM ledger for the perf HUD;
// omit it (e.g. in tests) to allocate untracked.
export function createVolumeTexture(
  field: ScalarField,
  hasFloat32Filterable = false,
  ledgerKey?: string,
): VolumeTexture {
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

  const { min, max } = finiteRange(field.data) ?? NO_FINITE_RANGE;
  const bytesPerVoxel = hasFloat32Filterable ? 4 : 2; // R32F vs R16F

  const makeBuffer = (data: FloatArray, fill: number, slot: number): PingPongBuffer => {
    const array = hasFloat32Filterable ? new Float32Array(voxels) : new Uint16Array(voxels);
    packInto(array, data, fill);
    const texture = new Data3DTexture(array, width, height, depth);
    texture.type = hasFloat32Filterable ? FloatType : HalfFloatType;
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
    if (ledgerKey !== undefined) trackAlloc(`${ledgerKey}:slot${slot}`, voxels * bytesPerVoxel);
    return { texture, array };
  };

  // Two-slot ping-pong; the second slot is allocated lazily on the first setField so a static layer
  // holds one texture. `active` indexes the live slot the node samples.
  const front = makeBuffer(field.data, min, 0);
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
      const fill = finiteMin(next.data) ?? NO_FINITE_RANGE.min;
      const slot = active ^ 1; // the inactive buffer
      let target = buffers[slot];
      if (target === undefined) {
        target = makeBuffer(next.data, fill, slot);
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
      if (ledgerKey !== undefined) {
        releaseAlloc(`${ledgerKey}:slot0`);
        releaseAlloc(`${ledgerKey}:slot1`); // no-op if the lazy slot was never allocated
      }
    },
  };
}

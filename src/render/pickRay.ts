import type { ColorScale, WindowLevel } from "@schema/colormap.ts";
import { clamp, UNIT_BOX_HALF_EXTENT } from "@schema/math.ts";
import { intersectRayBox } from "@schema/rayBox.ts";
import type { Vec3 } from "@schema/types.ts";
import { windowedT } from "./volume/normalization.ts";
import type { ScalarField } from "./volume/volumeTexture.ts";

// Pick-to-focus depth: march one ray CPU-side through the retained fields and return the world
// point at the *median visual depth* — where accumulated opacity crosses half its final value —
// so a double-click lands on the structure that dominates the pixel, not the box-chord midpoint.
// Deliberately approximate vs the GPU march (nearest-voxel samples, fixed step count): picks are
// rare gestures, and the pivot only needs to land inside the feature.

export interface PickLayer {
  readonly field: ScalarField;
  readonly windowLevel: WindowLevel;
  readonly scale: ColorScale;
  readonly density: number;
  readonly opacity: number;
}

const PICK_STEPS = 256; // matches the raymarcher's fine-march depth
// Below this total the click went through visually empty space inside the box — fall back to the
// chord midpoint rather than pivot on noise (≈ a few 8-bit color steps of accumulated alpha).
const ALPHA_FLOOR = 0.02;

// Nearest-voxel sample at a texture-space position p ∈ [0,1]³. Object axis i ↔ field axis i (the
// .zyx swizzle in raymarchScene undoes the C-order texture reversal), so p indexes shape directly.
// Mirrors the shader's non-finite guard: NaN/±Inf samples read as 0.
function sampleNearest(field: ScalarField, px: number, py: number, pz: number): number {
  const n0 = field.shape[0] ?? 1;
  const n1 = field.shape[1] ?? 1;
  const n2 = field.shape[2] ?? 1;
  const i0 = clamp(Math.floor(px * n0), 0, n0 - 1);
  const i1 = clamp(Math.floor(py * n1), 0, n1 - 1);
  const i2 = clamp(Math.floor(pz * n2), 0, n2 - 1);
  const raw = field.data[i2 + n2 * (i1 + n1 * i0)] ?? 0;
  return Number.isFinite(raw) ? raw : 0;
}

// World point a double-click should focus: the median-visual-depth sample along the ray, the chord
// midpoint when the volume there is visually empty (or no layers), null on a box miss. `halfExtent`
// is the per-axis world half-size — the unit box [-0.5,0.5]³ for a cubic dataset, anisotropic for a
// non-cubic one (the scaled volume box) — used for both the ray-box clip and the world→texture map.
export function pickPointOnRay(
  origin: Vec3,
  dir: Vec3,
  layers: readonly PickLayer[],
  halfExtent: Vec3 = UNIT_BOX_HALF_EXTENT,
  steps = PICK_STEPS,
): Vec3 | null {
  const boxMin: Vec3 = [-halfExtent[0], -halfExtent[1], -halfExtent[2]];
  const boxMax: Vec3 = [halfExtent[0], halfExtent[1], halfExtent[2]];
  const hit = intersectRayBox(origin, dir, boxMin, boxMax);
  if (hit === null) return null;
  const tEntry = Math.max(hit.tNear, 0);
  const tExit = hit.tFar;
  const at = (t: number): Vec3 => [
    origin[0] + t * dir[0],
    origin[1] + t * dir[1],
    origin[2] + t * dir[2],
  ];
  const midpoint = at((tEntry + tExit) / 2);
  if (layers.length === 0 || tExit <= tEntry) return midpoint;

  // Pass 1: per-step opacity on the raymarcher's lattice (t = tEntry + k·dt), layers combined as
  // independent absorbers, then the front-to-back total the threshold is half of.
  const dt = (tExit - tEntry) / steps;
  const stepAlphas = new Float32Array(steps);
  let total = 0;
  for (let k = 0; k < steps; k++) {
    const t = tEntry + k * dt;
    // World [-h,h]³ → texture [0,1]³ per axis (matches the shader's object pos+0.5 under unit scale).
    const px = (origin[0] + t * dir[0] + halfExtent[0]) / (2 * halfExtent[0]);
    const py = (origin[1] + t * dir[1] + halfExtent[1]) / (2 * halfExtent[1]);
    const pz = (origin[2] + t * dir[2] + halfExtent[2]) / (2 * halfExtent[2]);
    let transparency = 1;
    for (const layer of layers) {
      const raw = sampleNearest(layer.field, px, py, pz);
      const { center, width } = layer.windowLevel;
      const a = windowedT(raw, center, width, layer.scale) * layer.density * dt * layer.opacity;
      transparency *= 1 - clamp(a, 0, 1);
    }
    const stepAlpha = 1 - transparency;
    stepAlphas[k] = stepAlpha;
    total += stepAlpha * (1 - total);
  }
  if (total < ALPHA_FLOOR) return midpoint;

  // Pass 2: first lattice point where the accumulation crosses half the total — the median depth.
  const threshold = total / 2;
  let accum = 0;
  for (let k = 0; k < steps; k++) {
    accum += (stepAlphas[k] ?? 0) * (1 - accum);
    if (accum >= threshold) return at(tEntry + k * dt);
  }
  return midpoint; // float round-off only — the threshold is ≤ the recomputed total
}

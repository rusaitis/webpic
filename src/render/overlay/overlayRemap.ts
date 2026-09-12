import { clamp } from "@schema/math.ts";

// Pure coordinate helpers for the scene overlay.
//
// COORDINATE INVARIANT (webpic): world axis i == physical/field axis i (identity, right-handed);
// +z is up. The Data3DTexture is C-order (field axis 0 → texture axis 2), so the volume is sampled at
// the .zyx swizzle of the object-space position (raymarchScene.ts) to compose that reversal back to
// identity. Camera: up=(0,0,1); azimuth sweeps the xy-plane (0→+x, →+y), elevation lifts toward +z.

// THREE axis index, matching Vector3 component order (x=0, y=1, z=2). Also the pypic `GridInfo`
// field-axis index: the two coincide under the invariant above, so a field axis indexes world
// directly with no mapping step.
export type ThreeAxis = 0 | 1 | 2;

// Linear remap of a physical value on [min, max] to the volume box's world span [-halfExtent,
// halfExtent] (the raymarch mesh, scaled to the dataset aspect — `raymarchScene.ts`). `halfExtent`
// defaults to 0.5, the unit box for a cubic dataset; a non-cubic axis passes its scaled half-size so
// the grid/axes wrap the same box the volume fills. A zero-width span maps to the lower face (no NaN).
export function physicalToObject(
  value: number,
  min: number,
  max: number,
  halfExtent = 0.5,
): number {
  const span = max - min;
  return span !== 0 ? ((value - min) / span - 0.5) * (2 * halfExtent) : -halfExtent;
}

// Format a tick value at the chosen precision, normalizing a "-0" artifact from `toFixed`.
export function formatTick(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  return /^-0(?:\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
}

// Label edge-on fade band: labels along an axis pile up unreadably once that axis points nearly at
// the camera, so they fade with the view angle — full opacity beyond 35° off the row axis, gone
// within 15°. The band is wide because the near end of an edge-on row still sits ~13° off-axis
// (edge offset / distance); a narrower band leaves that end ghosting. The GPU fade (overlayScene
// edgeOnFade) reads these same constants; this is its Node-tested pure twin.
export const LABEL_FADE_START_COS = Math.cos((35 * Math.PI) / 180);
export const LABEL_FADE_FULL_COS = Math.cos((15 * Math.PI) / 180);

// Label opacity for |cos(angle between view ray and the label's row axis)| — the smoothstep
// fade the GPU applies per fragment. 1 fully visible, 0 fully edge-on.
export function labelFadeOpacity(edgeOnCos: number): number {
  const t = (edgeOnCos - LABEL_FADE_START_COS) / (LABEL_FADE_FULL_COS - LABEL_FADE_START_COS);
  const clamped = clamp(t, 0, 1);
  return 1 - clamped * clamped * (3 - 2 * clamped);
}

// Pure coordinate helpers for the scene overlay.
//
// COORDINATE INVARIANT (webpic): world axis i == physical/field axis i (identity, right-handed);
// +z is up. The Data3DTexture is C-order (field axis 0 → texture axis 2), so the volume is sampled at
// the .zyx swizzle of the object-space position (raymarchScene.ts) to compose that reversal back to
// identity. Camera: up=(0,0,1); azimuth sweeps the xy-plane (0→+x, →+y), elevation lifts toward +z.

// THREE axis index, matching Vector3 component order (x=0, y=1, z=2).
export type ThreeAxis = 0 | 1 | 2;

/**
 * Field axis (0/1/2 = pypic `GridInfo` order) → THREE/world axis. IDENTITY under the z-up,
 * world=physical convention: the raymarch sampler's .zyx swizzle composes with the texture's C-order
 * reversal back to identity, so world axis i = field axis i. (Historically `2 − fieldAxis`, before the
 * swizzle moved the reversal into the sampler.)
 */
export function fieldAxisToThree(fieldAxis: 0 | 1 | 2): ThreeAxis {
  return fieldAxis;
}

/**
 * Linear remap of a physical value on [min, max] to the volume box's object space [-0.5, 0.5]
 * (BoxGeometry(1,1,1) centered at the origin — `raymarchScene.ts`). A zero-width span maps to the
 * lower face so a degenerate axis yields no NaN.
 */
export function physicalToObject(value: number, min: number, max: number): number {
  const span = max - min;
  return span !== 0 ? (value - min) / span - 0.5 : -0.5;
}

/** Format a tick value at the chosen precision, normalizing a "-0" artifact from `toFixed`. */
export function formatTick(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  return /^-0(?:\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
}

import { vec3 } from "@schema/math.ts";
import type { Vec3 } from "@schema/types.ts";

// Render-local volume lighting: a shading NORMAL from the field gradient + a headlight Blinn-Phong
// term. Deliberately NOT `coordinates/operators/gradient` — a lighting normal is an aesthetic,
// transfer-function-dependent quantity (it shades the *opacity* isosurface, not a physical boundary),
// so it must not be deduped against the physics gradient operator. This pure twin is the reference the
// TSL in raymarchScene.ts mirrors (the rayBox.ts ↔ hitBox precedent); the tests check it against
// analytic fixtures.

export interface PhongParams {
  // Constant base term so unlit (edge-on / flat) regions stay visible.
  readonly ambient: number;
  // Lambert weight.
  readonly diffuse: number;
  // Blinn-Phong specular weight.
  readonly specular: number;
  // Specular exponent (sharpness of the highlight).
  readonly shininess: number;
}

// Tuned for plasma-blob shape perception, not photorealism. The head-on sum exceeds 1 on purpose
// (highlights brighten the LUT color; the renderer clamps), so structure reads at a glance.
export const PHONG: PhongParams = { ambient: 0.35, diffuse: 0.65, specular: 0.25, shininess: 24 };

// Below this gradient magnitude the field is locally flat — there's no surface to light, so the
// normal is undefined. Fall back to the view direction (renders lit-but-flat, never NaN).
export const GRAD_EPS = 1e-6;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Unit shading normal from a field gradient; degenerate (|grad| ≤ GRAD_EPS) → `fallback`.
export function gradientToNormal(grad: Vec3, fallback: Vec3): Vec3 {
  const len = Math.sqrt(dot(grad, grad));
  if (len <= GRAD_EPS) return fallback;
  return [grad[0] / len, grad[1] / len, grad[2] / len];
}

// Two-sided headlight Blinn-Phong intensity (the scalar the raymarcher multiplies the LUT color by).
// The light coincides with the view direction (a headlight — whatever faces the camera is lit, so
// orbiting reveals shape with no scene light to manage), so the half-vector equals the view and
// `n·h == n·l == |n·v|`. The normal is flipped toward the viewer first (an opacity isosurface has no
// consistent winding), giving `ndl = max(0, |n·v|)`. Returns `ambient + diffuse·ndl + specular·ndl^s`.
export function headlightShade(normal: Vec3, view: Vec3, params: PhongParams = PHONG): number {
  const faced = dot(normal, view) < 0 ? vec3(-normal[0], -normal[1], -normal[2]) : normal;
  const ndl = Math.max(0, dot(faced, view));
  return params.ambient + params.diffuse * ndl + params.specular * ndl ** params.shininess;
}

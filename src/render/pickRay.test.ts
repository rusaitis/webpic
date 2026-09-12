import type { Vec3 } from "@schema/types.ts";
import { describe, expect, it } from "vitest";
import { ballField } from "../../tests/fixtures.ts";
import { type PickLayer, pickPointOnRay } from "./pickRay.ts";
import type { ScalarField } from "./volume/volumeTexture.ts";

function layerOf(field: ScalarField, opacity = 1): PickLayer {
  return {
    field,
    windowLevel: { center: 0.5, width: 1 },
    scale: "linear",
    density: 4,
    opacity,
  };
}

// Radius 0 → an all-zero field of the same shape: visually empty, geometrically identical.
const EMPTY: ScalarField = ballField([0, 0, 0], 0);

// The ray runs exactly along −x, so the transverse coordinates of any hit are analytically zero;
// only the ray-box/step arithmetic separates them from it.
const ON_AXIS_EXACT = 1e-9;

// Straight-on ray: from (+2, 0, 0) down −x through the box center.
const ORIGIN: Vec3 = [2, 0, 0];
const DIR: Vec3 = [-1, 0, 0];

describe("pickPointOnRay", () => {
  it("returns null when the ray misses the box", () => {
    expect(pickPointOnRay([2, 0, 0], [0, 1, 0], [layerOf(ballField([0, 0, 0], 0.2))])).toBeNull();
  });

  it("lands inside an off-center ball, on the correct side", () => {
    // Ball offset along object-x (field axis 0, the slowest) — a transposed sampling convention
    // would read it as a z offset, miss it on this ray, and fall back to the chord midpoint x = 0.
    const point = pickPointOnRay(ORIGIN, DIR, [layerOf(ballField([0.25, 0, 0], 0.15))]);
    expect(point).not.toBeNull();
    expect(point?.[0]).toBeGreaterThan(0.08);
    expect(point?.[0]).toBeLessThan(0.42);
    expect(Math.abs(point?.[1] ?? 1)).toBeLessThan(ON_AXIS_EXACT);
    expect(Math.abs(point?.[2] ?? 1)).toBeLessThan(ON_AXIS_EXACT);
  });

  it("falls back to the chord midpoint through visually empty space", () => {
    const point = pickPointOnRay(ORIGIN, DIR, [layerOf(EMPTY)]);
    expect(point?.[0]).toBeCloseTo(0, 6);
    // No layers at all picks the same geometric midpoint.
    expect(pickPointOnRay(ORIGIN, DIR, [])?.[0]).toBeCloseTo(0, 6);
  });

  it("weighs the median depth toward the denser end of the chord", () => {
    const front = pickPointOnRay(ORIGIN, DIR, [layerOf(ballField([0.3, 0, 0], 0.12))]);
    const back = pickPointOnRay(ORIGIN, DIR, [layerOf(ballField([-0.3, 0, 0], 0.12))]);
    expect(front?.[0] ?? 0).toBeGreaterThan(0.1); // near the entry face (+x side)
    expect(back?.[0] ?? 0).toBeLessThan(-0.1); // near the exit face
  });

  it("ignores a fully transparent layer (composite opacity 0)", () => {
    const point = pickPointOnRay(ORIGIN, DIR, [layerOf(ballField([0.25, 0, 0], 0.15), 0)]);
    expect(point?.[0]).toBeCloseTo(0, 6); // back to the chord midpoint
  });

  it("combines layers: an empty layer alongside the ball changes nothing", () => {
    const ball = ballField([0.25, 0, 0], 0.15);
    const alone = pickPointOnRay(ORIGIN, DIR, [layerOf(ball)]);
    const combined = pickPointOnRay(ORIGIN, DIR, [layerOf(EMPTY), layerOf(ball)]);
    expect(combined?.[0]).toBeCloseTo(alone?.[0] ?? Number.NaN, 9);
  });
});

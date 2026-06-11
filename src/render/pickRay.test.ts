import type { Vec3 } from "@schema/types.ts";
import { describe, expect, it } from "vitest";
import { type PickLayer, pickPointOnRay } from "./pickRay.ts";
import type { ScalarField } from "./volumeTexture.ts";

const N = 16;

// A unit-valued ball at object-space `center` (zero outside), shape [N, N, N]. Object axis i ↔
// field axis i, so voxel (i0, i1, i2) sits at object ((i+0.5)/N − 0.5) per axis.
function ballField(center: Vec3, radius: number): ScalarField {
  const data = new Float32Array(N * N * N);
  for (let i0 = 0; i0 < N; i0++) {
    for (let i1 = 0; i1 < N; i1++) {
      for (let i2 = 0; i2 < N; i2++) {
        const dx = (i0 + 0.5) / N - 0.5 - center[0];
        const dy = (i1 + 0.5) / N - 0.5 - center[1];
        const dz = (i2 + 0.5) / N - 0.5 - center[2];
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) < radius) data[i2 + N * (i1 + N * i0)] = 1;
      }
    }
  }
  return { data, shape: [N, N, N] };
}

function layerOf(field: ScalarField, opacity = 1): PickLayer {
  return {
    field,
    windowLevel: { center: 0.5, width: 1 },
    scale: "linear",
    density: 4,
    opacity,
  };
}

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
    expect(Math.abs(point?.[1] ?? 1)).toBeLessThan(1e-9);
    expect(Math.abs(point?.[2] ?? 1)).toBeLessThan(1e-9);
  });

  it("falls back to the chord midpoint through visually empty space", () => {
    const empty: ScalarField = { data: new Float32Array(N * N * N), shape: [N, N, N] };
    const point = pickPointOnRay(ORIGIN, DIR, [layerOf(empty)]);
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
    const empty: ScalarField = { data: new Float32Array(N * N * N), shape: [N, N, N] };
    const ball = ballField([0.25, 0, 0], 0.15);
    const alone = pickPointOnRay(ORIGIN, DIR, [layerOf(ball)]);
    const combined = pickPointOnRay(ORIGIN, DIR, [layerOf(empty), layerOf(ball)]);
    expect(combined?.[0]).toBeCloseTo(alone?.[0] ?? Number.NaN, 9);
  });
});

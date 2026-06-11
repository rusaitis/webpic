import { describe, expect, it } from "vitest";
import type { CameraPose } from "./camera.ts";
import { clampToBox, dragAlongAxis, dragOnPlane, worldToScreen } from "./marker.ts";
import { cursorRay } from "./pick.ts";

const THREE_QUARTER: CameraPose = {
  target: [0.1, -0.05, 0.0],
  azimuth: Math.PI / 5,
  elevation: 0.5,
  distance: 2.4,
};

describe("worldToScreen", () => {
  // A point along the cursor ray must project back to the NDC that generated the ray.
  for (const ortho of [false, true]) {
    it(`round-trips with cursorRay (${ortho ? "orthographic" : "perspective"})`, () => {
      const aspect = 1.6;
      for (const [ndcX, ndcY] of [
        [0, 0],
        [0.4, -0.2],
        [-0.7, 0.55],
      ] as const) {
        const ray = cursorRay(THREE_QUARTER, ndcX, ndcY, aspect, ortho);
        const t = 0.9; // somewhere in front of the camera
        const point: [number, number, number] = [
          ray.origin[0] + t * ray.dir[0],
          ray.origin[1] + t * ray.dir[1],
          ray.origin[2] + t * ray.dir[2],
        ];
        const screen = worldToScreen(THREE_QUARTER, point, aspect, ortho);
        expect(screen.behind).toBe(false);
        expect(screen.ndcX).toBeCloseTo(ndcX, 9);
        expect(screen.ndcY).toBeCloseTo(ndcY, 9);
      }
    });
  }

  it("flags a point behind the camera", () => {
    const ray = cursorRay(THREE_QUARTER, 0, 0, 1, false);
    const behind: [number, number, number] = [
      ray.origin[0] - ray.dir[0],
      ray.origin[1] - ray.dir[1],
      ray.origin[2] - ray.dir[2],
    ];
    expect(worldToScreen(THREE_QUARTER, behind, 1, false).behind).toBe(true);
  });
});

describe("dragOnPlane", () => {
  it("lands the hit exactly on the plane", () => {
    const hit = dragOnPlane(THREE_QUARTER, 0.3, -0.1, 1.6, false, [0, 0, 0.2], [0, 0, 1]);
    expect(hit).not.toBeNull();
    expect(hit?.[2]).toBeCloseTo(0.2, 12); // on the z = 0.2 plane
  });

  it("returns null for a ray parallel to the plane", () => {
    // A level view (elevation 0) looks horizontally; the cursor ray is ⟂ to +z, so it never meets a
    // horizontal (normal +z) plane.
    const level: CameraPose = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 2 };
    expect(dragOnPlane(level, 0, 0, 1, false, [0, 0, 0], [0, 0, 1])).toBeNull();
  });
});

describe("dragAlongAxis", () => {
  it("constrains the result to the axis line", () => {
    const origin: [number, number, number] = [0.1, 0.2, 0.0];
    const hit = dragAlongAxis(THREE_QUARTER, 0.2, 0.3, 1.6, false, origin, [0, 0, 1]);
    expect(hit[0]).toBeCloseTo(origin[0], 12); // only z varies along the +z axis
    expect(hit[1]).toBeCloseTo(origin[1], 12);
  });
});

describe("clampToBox", () => {
  it("clamps each component to the unit box", () => {
    expect(clampToBox([0.8, -0.9, 0.1])).toEqual([0.5, -0.5, 0.1]);
  });
});

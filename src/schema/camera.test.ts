import { describe, expect, it } from "vitest";
import {
  CAMERA_HALF_FOV_TAN,
  type CameraPose,
  cameraPosition,
  DEFAULT_POSE,
  viewForward,
} from "./camera.ts";

const pose = (overrides: Partial<CameraPose> = {}): CameraPose => ({
  ...DEFAULT_POSE,
  ...overrides,
});
const norm = (v: readonly number[]): number => Math.hypot(...v);

describe("viewForward", () => {
  it("is a unit vector for any pose", () => {
    for (const azimuth of [0, 1, Math.PI, -2.5]) {
      for (const elevation of [0, 0.6, 1.2, -1.2]) {
        expect(norm(viewForward(pose({ azimuth, elevation })))).toBeCloseTo(1, 12);
      }
    }
  });

  it("points down −x from the +x side of the equator, and down −z from overhead", () => {
    expect(viewForward(pose({ azimuth: 0, elevation: 0 }))[0]).toBeCloseTo(-1, 12);
    expect(viewForward(pose({ azimuth: 0, elevation: Math.PI / 2 }))[2]).toBeCloseTo(-1, 12);
  });
});

describe("cameraPosition", () => {
  it("sits `distance` from the target, along −viewForward", () => {
    const p = pose({ target: [1, -2, 0.5], distance: 3, azimuth: 0.7, elevation: 0.4 });
    const eye = cameraPosition(p);
    const toTarget = p.target.map((t, i) => t - (eye[i] ?? 0));
    expect(norm(toTarget)).toBeCloseTo(p.distance, 12);

    const forward = viewForward(p);
    for (let i = 0; i < 3; i++) {
      expect((toTarget[i] ?? 0) / p.distance).toBeCloseTo(forward[i] ?? 0, 12);
    }
  });

  it("collapses onto the target at zero distance", () => {
    expect(cameraPosition(pose({ target: [4, 5, 6], distance: 0 }))).toEqual([4, 5, 6]);
  });
});

describe("CAMERA_HALF_FOV_TAN", () => {
  it("is tan of half the shared field of view", () => {
    expect(CAMERA_HALF_FOV_TAN).toBeCloseTo(Math.tan((45 * Math.PI) / 360), 15);
  });
});

describe("DEFAULT_POSE", () => {
  it("looks at the origin from above the equator, which is what a boot frame shows", () => {
    expect(DEFAULT_POSE.target).toEqual([0, 0, 0]);
    expect(DEFAULT_POSE.elevation).toBeGreaterThan(0);
    expect(DEFAULT_POSE.distance).toBeGreaterThan(0);
    expect(DEFAULT_POSE.roll).toBe(0);
  });
});

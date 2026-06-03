import { describe, expect, it } from "vitest";
import {
  type CameraPose,
  DEFAULT_POSE,
  DISTANCE_MAX,
  DISTANCE_MIN,
  dollyPose,
  ELEVATION_LIMIT,
  orbitPose,
  panPose,
} from "./camera.ts";

const LEVEL: CameraPose = { target: [1, 2, 3], azimuth: 0, elevation: 0, distance: 4 };

describe("orbitPose", () => {
  it("spins azimuth opposite the horizontal drag and tilts elevation off the vertical", () => {
    const next = orbitPose(DEFAULT_POSE, 100, -40);
    expect(next.azimuth).toBeLessThan(DEFAULT_POSE.azimuth); // drag right ⇒ azimuth decreases
    expect(next.elevation).toBeGreaterThan(DEFAULT_POSE.elevation); // drag up ⇒ elevation rises
    expect(next.distance).toBe(DEFAULT_POSE.distance);
    expect(next.target).toBe(DEFAULT_POSE.target); // target untouched by orbit
  });

  it("clamps elevation to ±ELEVATION_LIMIT at the poles", () => {
    expect(orbitPose(LEVEL, 0, -1e6).elevation).toBeCloseTo(ELEVATION_LIMIT, 12);
    expect(orbitPose(LEVEL, 0, 1e6).elevation).toBeCloseTo(-ELEVATION_LIMIT, 12);
  });

  it("wraps azimuth into (-π, π] so it never runs away over a long drag", () => {
    const spun = orbitPose(LEVEL, -1e5, 0); // huge leftward drag
    expect(spun.azimuth).toBeGreaterThan(-Math.PI);
    expect(spun.azimuth).toBeLessThanOrEqual(Math.PI);
  });

  it("returns a fresh object even for a zero delta", () => {
    const next = orbitPose(DEFAULT_POSE, 0, 0);
    expect(next).not.toBe(DEFAULT_POSE);
    expect(next.azimuth).toBeCloseTo(DEFAULT_POSE.azimuth, 12);
    expect(next.elevation).toBeCloseTo(DEFAULT_POSE.elevation, 12);
  });
});

describe("dollyPose", () => {
  it("is geometric: zoom in (deltaY < 0) shrinks distance, out grows it", () => {
    expect(dollyPose(LEVEL, -100).distance).toBeLessThan(LEVEL.distance);
    expect(dollyPose(LEVEL, 100).distance).toBeGreaterThan(LEVEL.distance);
  });

  it("clamps distance to [DISTANCE_MIN, DISTANCE_MAX]", () => {
    expect(dollyPose(LEVEL, -1e5).distance).toBeCloseTo(DISTANCE_MIN, 12);
    expect(dollyPose(LEVEL, 1e5).distance).toBeCloseTo(DISTANCE_MAX, 12);
  });

  it("leaves angles and target untouched", () => {
    const next = dollyPose(LEVEL, 50);
    expect(next.azimuth).toBe(LEVEL.azimuth);
    expect(next.elevation).toBe(LEVEL.elevation);
    expect(next.target).toBe(LEVEL.target);
  });
});

describe("panPose", () => {
  it("moves only the target, scaled by distance", () => {
    const near = panPose({ ...LEVEL, distance: 1 }, 100, 0);
    const far = panPose({ ...LEVEL, distance: 4 }, 100, 0);
    const dxNear = near.target[0] - LEVEL.target[0];
    const dxFar = far.target[0] - LEVEL.target[0];
    expect(far.azimuth).toBe(LEVEL.azimuth);
    expect(far.elevation).toBe(LEVEL.elevation);
    expect(far.distance).toBe(LEVEL.distance);
    expect(Math.abs(dxFar)).toBeCloseTo(4 * Math.abs(dxNear), 12); // distance-proportional
  });

  it("at level elevation a vertical drag moves target along world-y only", () => {
    const next = panPose(LEVEL, 0, 60); // azimuth 0, elevation 0
    expect(next.target[0]).toBeCloseTo(LEVEL.target[0], 12);
    expect(next.target[2]).toBeCloseTo(LEVEL.target[2], 12);
    expect(next.target[1]).toBeGreaterThan(LEVEL.target[1]); // drag down ⇒ target rises
  });

  it("at level elevation a horizontal drag stays in the xz-plane", () => {
    const next = panPose(LEVEL, 80, 0); // azimuth 0 ⇒ screenRight = +x
    expect(next.target[1]).toBeCloseTo(LEVEL.target[1], 12);
    expect(next.target[0]).not.toBeCloseTo(LEVEL.target[0], 6);
    expect(next.target[2]).toBeCloseTo(LEVEL.target[2], 12); // azimuth 0 ⇒ no z component
  });
});

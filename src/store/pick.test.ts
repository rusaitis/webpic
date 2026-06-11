import { describe, expect, it } from "vitest";
import type { CameraPose } from "./camera.ts";
import { DISTANCE_MIN } from "./camera.ts";
import { cursorRay, focusPoseOnPoint, unitBoxChordMidpoint } from "./pick.ts";

// Level straight-on view: camera at (+2, 0, 0) looking down −x, screenRight = +y, screenUp = +z.
const STRAIGHT_ON: CameraPose = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 2 };

const HALF_FOV_TAN = Math.tan((45 * Math.PI) / 360); // CAMERA_FOV_DEG = 45

describe("cursorRay", () => {
  it("sends the centered perspective ray from the camera through the target", () => {
    const ray = cursorRay(STRAIGHT_ON, 0, 0, 1, false);
    expect(ray.origin).toEqual([2, 0, 0]);
    expect(ray.dir[0]).toBeCloseTo(-1, 12);
    expect(ray.dir[1]).toBeCloseTo(0, 12);
    expect(ray.dir[2]).toBeCloseTo(0, 12);
  });

  it("tilts toward screen-right (+y at azimuth 0) and screen-up (+z when level)", () => {
    const right = cursorRay(STRAIGHT_ON, 0.5, 0, 1, false);
    expect(right.dir[1]).toBeGreaterThan(0);
    expect(right.dir[2]).toBeCloseTo(0, 12);
    const up = cursorRay(STRAIGHT_ON, 0, 0.5, 1, false);
    expect(up.dir[2]).toBeGreaterThan(0);
    expect(up.dir[1]).toBeCloseTo(0, 12);
  });

  it("returns a unit direction and scales horizontal reach by aspect", () => {
    const ray = cursorRay(STRAIGHT_ON, 0.5, -0.3, 2, false);
    expect(Math.hypot(...ray.dir)).toBeCloseTo(1, 12);
    const wide = cursorRay(STRAIGHT_ON, 0.5, 0, 2, false);
    const square = cursorRay(STRAIGHT_ON, 0.5, 0, 1, false);
    expect(wide.dir[1]).toBeGreaterThan(square.dir[1]);
  });

  it("offsets the parallel orthographic ray across the matched frustum", () => {
    const ray = cursorRay(STRAIGHT_ON, 0.5, 0, 1, true);
    // halfH = d·tan(fov/2); ndcX 0.5 of it along screenRight = +y.
    expect(ray.origin[1]).toBeCloseTo(2 * HALF_FOV_TAN * 0.5, 12);
    expect(ray.origin[0]).toBeCloseTo(2, 12);
    expect(ray.dir[0]).toBeCloseTo(-1, 12);
    expect(ray.dir[1]).toBeCloseTo(0, 12);
    expect(ray.dir[2]).toBeCloseTo(0, 12);
  });
});

describe("unitBoxChordMidpoint", () => {
  it("returns the box center for the straight-on centered ray", () => {
    const mid = unitBoxChordMidpoint([2, 0, 0], [-1, 0, 0]);
    expect(mid).not.toBeNull();
    expect(mid?.[0]).toBeCloseTo(0, 12);
    expect(mid?.[1]).toBeCloseTo(0, 12);
    expect(mid?.[2]).toBeCloseTo(0, 12);
  });

  it("misses past the box edge and behind the camera", () => {
    expect(unitBoxChordMidpoint([2, 0.6, 0], [-1, 0, 0])).toBeNull(); // parallel, outside the y slab
    expect(unitBoxChordMidpoint([2, 0, 0], [1, 0, 0])).toBeNull(); // box entirely behind
    const corner = cursorRay(STRAIGHT_ON, 1, 1, 1, false); // frame corner clears the box
    expect(unitBoxChordMidpoint(corner.origin, corner.dir)).toBeNull();
  });

  it("clamps the chord start to the origin when it starts inside the box", () => {
    const mid = unitBoxChordMidpoint([0.25, 0, 0], [-1, 0, 0]);
    // Chord runs t ∈ [0, 0.75] (not from the behind-origin face) → midpoint x = −0.125.
    expect(mid?.[0]).toBeCloseTo(-0.125, 12);
  });

  it("intersects an anisotropic box (a short axis clips the ray sooner)", () => {
    // Along +y the box is only ±1/3; a y-ray from y=2 enters at y=1/3, exits at −1/3 → midpoint 0.
    const mid = unitBoxChordMidpoint([0, 2, 0], [0, -1, 0], [0.5, 1 / 3, 1 / 3]);
    expect(mid?.[1]).toBeCloseTo(0, 12);
    // A ray grazing past the shrunk y-face (|y| > 1/3) now misses (it cleared the unit box before).
    expect(unitBoxChordMidpoint([2, 0.4, 0], [-1, 0, 0], [0.5, 1 / 3, 1 / 3])).toBeNull();
  });
});

describe("focusPoseOnPoint", () => {
  it("re-targets the pose, keeps the view direction, and dollies 30% in", () => {
    const pose: CameraPose = { target: [0, 0, 0], azimuth: 1.1, elevation: 0.4, distance: 2 };
    const focused = focusPoseOnPoint(pose, [0.2, -0.1, 0.3]);
    expect(focused.target).toEqual([0.2, -0.1, 0.3]);
    expect(focused.azimuth).toBe(pose.azimuth);
    expect(focused.elevation).toBe(pose.elevation);
    expect(focused.distance).toBeCloseTo(1.4, 12);
  });

  it("clamps the dolly-in at the minimum distance", () => {
    const pose: CameraPose = {
      target: [0, 0, 0],
      azimuth: 0,
      elevation: 0,
      distance: DISTANCE_MIN,
    };
    expect(focusPoseOnPoint(pose, [0, 0, 0]).distance).toBe(DISTANCE_MIN);
  });
});

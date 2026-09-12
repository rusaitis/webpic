import { describe, expect, it } from "vitest";
import type { CameraPose } from "./camera.ts";
import { DISTANCE_MAX, DISTANCE_MIN } from "./camera.ts";
import { cursorRay, focusDistance, focusPoseOnPoint, unitBoxChordMidpoint } from "./pick.ts";

// Level straight-on view: camera at (+2, 0, 0) looking down −x, screenRight = +y, screenUp = +z.
const STRAIGHT_ON: CameraPose = {
  target: [0, 0, 0],
  azimuth: 0,
  elevation: 0,
  distance: 2,
  roll: 0,
};

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
  const POSE: CameraPose = {
    target: [0, 0, 0],
    azimuth: 1.1,
    elevation: 0.4,
    distance: 2,
    roll: 0,
  };

  function cameraOf(pose: CameraPose): readonly [number, number, number] {
    const ce = Math.cos(pose.elevation);
    const [tx, ty, tz] = pose.target;
    return [
      tx + pose.distance * ce * Math.cos(pose.azimuth),
      ty + pose.distance * ce * Math.sin(pose.azimuth),
      tz + pose.distance * Math.sin(pose.elevation),
    ];
  }

  it("dollies 30% in and re-aims the camera from where it stands", () => {
    const point = [0.2, -0.1, 0.3] as const;
    const focused = focusPoseOnPoint(POSE, point);
    expect(focused.target).toEqual(point);
    expect(focused.distance).toBeCloseTo(1.4, 12);
    // The goal camera sits on the ray from the picked point through the ORIGINAL camera — the
    // flight rotates the view toward the point instead of trucking sideways alongside it.
    const before = cameraOf(POSE);
    const after = cameraOf(focused);
    const v = [before[0] - point[0], before[1] - point[1], before[2] - point[2]] as const;
    const len = Math.hypot(...v);
    for (let i = 0; i < 3; i++) {
      expect(after[i]).toBeCloseTo(
        (point[i] ?? Number.NaN) + (focused.distance * (v[i] ?? Number.NaN)) / len,
        12,
      );
    }
  });

  it("a pick on the view axis keeps the view direction (pure dolly)", () => {
    const camera = cameraOf(POSE);
    const onAxis = [camera[0] * 0.25, camera[1] * 0.25, camera[2] * 0.25] as const;
    const focused = focusPoseOnPoint(POSE, onAxis);
    expect(focused.azimuth).toBeCloseTo(POSE.azimuth, 12);
    expect(focused.elevation).toBeCloseTo(POSE.elevation, 12);
  });

  it("an off-axis pick swivels the aim toward the point's side", () => {
    // Straight-on from +x: camera at (2, 0, 0), looking down −x; the point sits toward +y.
    const straight: CameraPose = {
      target: [0, 0, 0],
      azimuth: 0,
      elevation: 0,
      distance: 2,
      roll: 0,
    };
    const focused = focusPoseOnPoint(straight, [0, 0.4, 0]);
    expect(focused.azimuth).toBeCloseTo(Math.atan2(-0.4, 2), 12); // sweeps toward the point
    expect(focused.elevation).toBeCloseTo(0, 12);
    const below = focusPoseOnPoint(straight, [0, 0, -0.4]);
    expect(below.elevation).toBeGreaterThan(0); // camera ends up looking down at the point
  });

  it("clamps the dolly-in at the minimum distance", () => {
    const pose: CameraPose = {
      target: [0, 0, 0],
      azimuth: 0,
      elevation: 0,
      distance: DISTANCE_MIN,
      roll: 0,
    };
    expect(focusPoseOnPoint(pose, [0, 0, 0]).distance).toBe(DISTANCE_MIN);
  });

  it("uses an explicit gesture-time distance verbatim (no re-applied dolly)", () => {
    const pose: CameraPose = {
      target: [0, 0, 0],
      azimuth: 0.3,
      elevation: 0.2,
      distance: 1.4,
      roll: 0,
    };
    expect(focusPoseOnPoint(pose, [0.1, 0.2, 0.3], 1.23).distance).toBe(1.23);
  });
});

describe("focusDistance", () => {
  it("pulls 30% closer, clamped to the dolly bounds", () => {
    expect(focusDistance(2)).toBeCloseTo(1.4, 12);
    expect(focusDistance(DISTANCE_MIN)).toBe(DISTANCE_MIN);
    expect(focusDistance(DISTANCE_MAX * 2)).toBe(DISTANCE_MAX);
  });
});

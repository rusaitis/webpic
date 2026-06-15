import { describe, expect, it } from "vitest";
import { type CameraPose, DEFAULT_POSE } from "./camera.ts";
import {
  cameraElevationDeg,
  horizontalDragAllowed,
  horizontalDragAxis,
  markerCoreScale,
  REFERENCE_VIEW_DISTANCE,
  verticalDragAllowed,
  ZOOM_SCALE_MAX,
  ZOOM_SCALE_MIN,
} from "./marker.ts";

// Point at the orbit target so the camera→point distance equals pose.distance.
function poseAt(distance: number, azimuth = 0, elevation = 0): CameraPose {
  return { target: [0, 0, 0], azimuth, elevation, distance, roll: 0 };
}

describe("markerCoreScale", () => {
  it("is 1 at the reference framing distance", () => {
    expect(markerCoreScale(poseAt(REFERENCE_VIEW_DISTANCE), [0, 0, 0], false)).toBeCloseTo(1, 12);
  });

  it("grows with distance and shrinks closer, monotonically", () => {
    const near = markerCoreScale(poseAt(REFERENCE_VIEW_DISTANCE * 0.5), [0, 0, 0], false);
    const far = markerCoreScale(poseAt(REFERENCE_VIEW_DISTANCE * 2), [0, 0, 0], false);
    expect(near).toBeLessThan(1);
    expect(far).toBeGreaterThan(1);
  });

  it("clamps to [min, max] at the extremes", () => {
    expect(markerCoreScale(poseAt(1e-3), [0, 0, 0], false)).toBeCloseTo(ZOOM_SCALE_MIN, 12);
    expect(markerCoreScale(poseAt(1e4), [0, 0, 0], false)).toBeCloseTo(ZOOM_SCALE_MAX, 12);
  });

  it("keys off the orbit distance only in orthographic (independent of the point's depth)", () => {
    const pose = poseAt(REFERENCE_VIEW_DISTANCE);
    const atTarget = markerCoreScale(pose, [0, 0, 0], true);
    const offset = markerCoreScale(pose, [0.4, -0.3, 0.2], true);
    expect(offset).toBe(atTarget); // ortho ignores the point — frustum scales with distance alone
  });
});

describe("camera-elevation gating", () => {
  it("reads elevation straight off the pose", () => {
    expect(cameraElevationDeg(DEFAULT_POSE)).toBeCloseTo((0.6 * 180) / Math.PI, 12);
    expect(cameraElevationDeg(poseAt(3, 0, -0.6))).toBeCloseTo((0.6 * 180) / Math.PI, 12); // |·|
  });

  it("disables vertical drag above 60° and the free plane below 15°", () => {
    expect(verticalDragAllowed(poseAt(3, 0, (50 * Math.PI) / 180))).toBe(true);
    expect(verticalDragAllowed(poseAt(3, 0, (70 * Math.PI) / 180))).toBe(false);
    expect(horizontalDragAllowed(poseAt(3, 0, (50 * Math.PI) / 180))).toBe(true);
    expect(horizontalDragAllowed(poseAt(3, 0, (5 * Math.PI) / 180))).toBe(false);
  });
});

describe("horizontalDragAxis", () => {
  it("picks the cross-screen axis when the view aligns with a world axis", () => {
    // Looking along +x (azimuth 0): x is into-screen, so drag along y.
    expect(horizontalDragAxis(poseAt(3, 0))).toBe("y");
    // Looking along +y (azimuth π/2): y is into-screen, so drag along x.
    expect(horizontalDragAxis(poseAt(3, Math.PI / 2))).toBe("x");
  });

  it("returns null in the ~45° diagonal band (neither axis is cleanly cross-screen)", () => {
    expect(horizontalDragAxis(poseAt(3, Math.PI / 4))).toBeNull();
  });
});

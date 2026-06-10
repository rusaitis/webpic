import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  applyPose,
  createOrthographicCamera,
  createPerspectiveCamera,
  DEFAULT_POSE,
} from "./camera.ts";
import { FRUSTUM } from "./constants.ts";
import type { CameraPose } from "./messages.ts";

describe("createOrthographicCamera", () => {
  it("builds an identical screen-aligned camera each call (the main/worker parity precondition)", () => {
    const a = createOrthographicCamera();
    const b = createOrthographicCamera();
    for (const key of ["left", "right", "top", "bottom", "near", "far"] as const) {
      expect(a[key]).toBe(FRUSTUM[key]);
      expect(a[key]).toBe(b[key]);
    }
    expect(a.position.toArray()).toEqual([0, 0, 1]);
  });
});

describe("createPerspectiveCamera", () => {
  it("uses the documented lens", () => {
    const camera = createPerspectiveCamera(2);
    expect(camera.fov).toBe(45);
    expect(camera.near).toBe(0.01);
    expect(camera.far).toBe(10);
    expect(camera.aspect).toBe(2);
  });
});

describe("applyPose", () => {
  it("maps orbit-spherical to a z-up cartesian position", () => {
    const camera = createPerspectiveCamera();
    const at = (pose: CameraPose): [number, number, number] => {
      applyPose(camera, pose);
      return camera.position.toArray();
    };

    // azimuth 0 looks from +x; elevation 0 stays in the xy-plane.
    const px = at({ target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 1 });
    expect(px[0]).toBeCloseTo(1, 6);
    expect(px[1]).toBeCloseTo(0, 6);
    expect(px[2]).toBeCloseTo(0, 6);
    // azimuth +π/2 sweeps toward +y.
    const py = at({ target: [0, 0, 0], azimuth: Math.PI / 2, elevation: 0, distance: 1 });
    expect(py[0]).toBeCloseTo(0, 6);
    expect(py[1]).toBeCloseTo(1, 6);
    // elevation lifts toward +z; the target offsets the whole orbit.
    const up = at({ target: [1, 2, 3], azimuth: 0, elevation: Math.PI / 2, distance: 2 });
    expect(up[0]).toBeCloseTo(1, 6);
    expect(up[1]).toBeCloseTo(2, 6);
    expect(up[2]).toBeCloseTo(5, 6); // 3 + 2·sin(π/2)
  });

  it("places the default 3/4 view from DEFAULT_POSE", () => {
    const camera = createPerspectiveCamera();
    applyPose(camera, DEFAULT_POSE);
    expect(camera.position.x).toBeCloseTo(1.5036, 2);
    expect(camera.position.y).toBeCloseTo(1.5036, 2);
    expect(camera.position.z).toBeCloseTo(1.0989, 2);
  });

  it("aims the camera at the target", () => {
    const camera = createPerspectiveCamera();
    applyPose(camera, DEFAULT_POSE);
    // The look direction must be anti-parallel to the (origin-target) camera position.
    const direction = camera.getWorldDirection(new Vector3());
    const toTarget = new Vector3(0, 0, 0).sub(camera.position).normalize();
    expect(direction.dot(toTarget)).toBeCloseTo(1, 5);
  });
});

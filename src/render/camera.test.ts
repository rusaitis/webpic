import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  applyPose,
  applyPoseOrtho,
  createOrthographicCamera,
  createPerspectiveCamera,
  createVolumeOrthographicCamera,
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
    expect(camera.position.x).toBeCloseTo(1.7508, 2);
    expect(camera.position.y).toBeCloseTo(1.7508, 2);
    expect(camera.position.z).toBeCloseTo(1.4739, 2);
  });

  it("aims the camera at the target", () => {
    const camera = createPerspectiveCamera();
    applyPose(camera, DEFAULT_POSE);
    const direction = camera.getWorldDirection(new Vector3());
    const [tx, ty, tz] = DEFAULT_POSE.target;
    const toTarget = new Vector3(tx, ty, tz).sub(camera.position).normalize();
    expect(direction.dot(toTarget)).toBeCloseTo(1, 5);
  });

  it("keeps the scene inside the frustum across the full dolly range", () => {
    const camera = createPerspectiveCamera();
    applyPose(camera, { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 50 });
    expect(camera.far).toBeGreaterThanOrEqual(50 + Math.sqrt(3) / 2); // box back face visible
  });

  it("extends far to cover a panned-away target", () => {
    const camera = createPerspectiveCamera();
    applyPose(camera, { target: [3, 4, 0], azimuth: 0, elevation: 0, distance: 2 });
    expect(camera.far).toBeCloseTo(2 + 5 + 1, 12); // distance + |target| + scene radius
  });
});

describe("applyPoseOrtho", () => {
  const pose: CameraPose = { target: [0, 0, 0], azimuth: 0.8, elevation: 0.3, distance: 4 };

  it("places the camera exactly where applyPose does (shared orbit placement)", () => {
    const persp = createPerspectiveCamera();
    const ortho = createVolumeOrthographicCamera();
    applyPose(persp, pose);
    applyPoseOrtho(ortho, pose);
    expect(ortho.position.toArray()).toEqual(persp.position.toArray());
    const direction = ortho.getWorldDirection(new Vector3());
    const toTarget = new Vector3(0, 0, 0).sub(ortho.position).normalize();
    expect(direction.dot(toTarget)).toBeCloseTo(1, 5);
  });

  it("matches the perspective frustum at the target plane: halfH = d·tan(fov/2)", () => {
    const ortho = createVolumeOrthographicCamera();
    applyPoseOrtho(ortho, pose, 2);
    const halfH = pose.distance * Math.tan((45 * Math.PI) / 360);
    expect(ortho.top).toBeCloseTo(halfH, 12);
    expect(ortho.bottom).toBeCloseTo(-halfH, 12);
    expect(ortho.right).toBeCloseTo(halfH * 2, 12); // aspect-corrected
    expect(ortho.left).toBeCloseTo(-halfH * 2, 12);
  });

  it("zooms with distance: the frustum follows a dolly", () => {
    const ortho = createVolumeOrthographicCamera();
    applyPoseOrtho(ortho, pose);
    const wide = ortho.top;
    applyPoseOrtho(ortho, { ...pose, distance: 2 });
    expect(ortho.top).toBeCloseTo(wide / 2, 12);
  });
});

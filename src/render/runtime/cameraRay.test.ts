import { OrthographicCamera, PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import { unprojectRay } from "./cameraRay.ts";

// Real three cameras (pure JS matrices), no renderer: the ray starts on the near plane and heads
// along the view direction at screen centre, and off-centre it converges (perspective) or stays
// parallel (orthographic).

describe("unprojectRay", () => {
  it("perspective: the centre ray starts at the near plane and points down the view axis", () => {
    const camera = new PerspectiveCamera(60, 1, 0.5, 10);
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);
    const { origin, dir } = unprojectRay(camera, 0, 0);
    expect(origin[2]).toBeCloseTo(3 - 0.5, 6); // near plane, in front of the eye
    expect(origin[0]).toBeCloseTo(0, 6);
    expect(origin[1]).toBeCloseTo(0, 6);
    expect(dir).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(-1, 6)]);
  });

  it("perspective: an off-centre ray tilts toward that screen edge", () => {
    const camera = new PerspectiveCamera(60, 1, 0.5, 10);
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);
    const { dir } = unprojectRay(camera, 1, 0);
    expect(dir[0]).toBeGreaterThan(0);
    expect(dir[2]).toBeLessThan(0);
    // The edge ray subtends half the horizontal fov (aspect 1 → 30°).
    expect(Math.atan2(dir[0], -dir[2])).toBeCloseTo((30 * Math.PI) / 180, 6);
  });

  it("orthographic: every ray is parallel to the view axis, offset by the screen point", () => {
    const camera = new OrthographicCamera(-2, 2, 2, -2, 0.5, 10);
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);
    const centre = unprojectRay(camera, 0, 0);
    const edge = unprojectRay(camera, 1, 0.5);
    expect(edge.dir).toEqual(centre.dir.map((c) => expect.closeTo(c, 6)));
    expect(edge.origin[0]).toBeCloseTo(2, 6);
    expect(edge.origin[1]).toBeCloseTo(1, 6);
  });
});

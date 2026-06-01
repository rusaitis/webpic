import { describe, expect, it } from "vitest";
import { intersectRayBox } from "./rayBox.ts";

// Unit box centered at the origin — the convention raymarchScene marches in.
const MIN = [-0.5, -0.5, -0.5] as const;
const MAX = [0.5, 0.5, 0.5] as const;

describe("intersectRayBox", () => {
  it("hits a centered box from outside along an axis", () => {
    const hit = intersectRayBox([-2, 0, 0], [1, 0, 0], MIN, MAX);
    expect(hit).not.toBeNull();
    expect(hit?.tNear).toBeCloseTo(1.5, 12);
    expect(hit?.tFar).toBeCloseTo(2.5, 12);
  });

  it("hits along the cube diagonal", () => {
    const hit = intersectRayBox([-2, -2, -2], [1, 1, 1], MIN, MAX);
    expect(hit?.tNear).toBeCloseTo(1.5, 12);
    expect(hit?.tFar).toBeCloseTo(2.5, 12);
  });

  it("misses a box it passes beside (parallel slab, origin outside)", () => {
    expect(intersectRayBox([-2, 2, 0], [1, 0, 0], MIN, MAX)).toBeNull();
  });

  it("reports a negative tNear when the origin is inside the box", () => {
    const hit = intersectRayBox([0, 0, 0], [1, 0, 0], MIN, MAX);
    expect(hit?.tNear).toBeCloseTo(-0.5, 12);
    expect(hit?.tFar).toBeCloseTo(0.5, 12);
  });

  it("returns null when the box lies entirely behind the origin", () => {
    expect(intersectRayBox([2, 0, 0], [1, 0, 0], MIN, MAX)).toBeNull();
  });

  it("handles a ray that grazes a face (parallel slab, origin on the boundary)", () => {
    // Travelling +x along the +y face plane: y is parallel and exactly on `hi`, so it still
    // intersects the (degenerate) face span rather than reporting a miss.
    const hit = intersectRayBox([-2, 0.5, 0], [1, 0, 0], MIN, MAX);
    expect(hit?.tNear).toBeCloseTo(1.5, 12);
    expect(hit?.tFar).toBeCloseTo(2.5, 12);
  });
});

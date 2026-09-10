import { describe, expect, it } from "vitest";
import { intersectCenteredBox, intersectRayBox } from "./rayBox.ts";

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

describe("intersectCenteredBox", () => {
  const HALF = [0.5, 0.5, 0.5] as const;
  it("agrees with intersectRayBox on the unit box for hits, misses, and inside origins", () => {
    const rays: ReadonlyArray<
      readonly [readonly [number, number, number], readonly [number, number, number]]
    > = [
      [
        [-2, 0, 0],
        [1, 0, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 1],
      ],
      [
        [-2, 0.7, 0],
        [1, 0, 0],
      ],
      [
        [2, 0, 0],
        [1, 0, 0],
      ],
      [
        [-2, 0.25, 0.25],
        [0.8, 0.1, -0.2],
      ],
    ];
    for (const [origin, dir] of rays) {
      const expected = intersectRayBox(origin, dir, MIN, MAX);
      const actual = intersectCenteredBox(origin, dir, HALF);
      expect(actual).toEqual(expected);
    }
  });
  it("respects an anisotropic half-extent", () => {
    const hit = intersectCenteredBox([-2, 0, 0], [1, 0, 0], [0.25, 0.5, 0.5]);
    expect(hit?.tNear).toBeCloseTo(1.75, 12);
    expect(hit?.tFar).toBeCloseTo(2.25, 12);
  });
});

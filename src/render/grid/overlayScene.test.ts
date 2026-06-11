import type { Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import type { OverlayAxis, SceneOverlayConfig } from "../messages.ts";
import { createSceneOverlay } from "./overlayScene.ts";

// Node shape/dispose coverage only — no GPU, no pixels (the WGSL/render path is exercised by the
// browser smoke test). Material/geometry construction is CPU-only; labels need OffscreenCanvas, which
// is absent in node, so the deterministic assertions are over the LineSegments (grid + axes).

const axis = (min: number, max: number, label: string): OverlayAxis => ({
  bounds: [min, max],
  label,
});

function config(overrides: Partial<SceneOverlayConfig> = {}): SceneOverlayConfig {
  return {
    axes: [axis(0, 256, "x"), axis(0, 256, "y"), axis(0, 256, "z")],
    planes: { xy: false, yz: false, xz: true },
    planePosition: "center",
    show: { grid: true, axes: true, labels: true },
    grid: { color: [1, 1, 1, 0.2], majorOpacity: 0.35 },
    axisColors: { x: [1, 0, 0, 1], y: [0, 1, 0, 1], z: [0, 0, 1, 1] },
    labelColor: [0.8, 0.8, 0.8, 1],
    tick: { targetCount: 8 },
    ...overrides,
  };
}

const countLineSegments = (root: Object3D): number =>
  root.children.filter((child) => (child as { isLineSegments?: boolean }).isLineSegments === true)
    .length;

// The axis lines are 2-vertex LineSegments; the grid plane is a many-vertex one. Pick the three
// shortest (2 vertices = 6 floats) and return their start vertices, ordered as added (x, y, z).
function axisLineStarts(root: Object3D): [number, number, number][] {
  const lines = root.children.filter(
    (child) => (child as { isLineSegments?: boolean }).isLineSegments === true,
  );
  return lines
    .map(
      (line) =>
        (line as unknown as { geometry: { attributes: { position: { array: Float32Array } } } })
          .geometry.attributes.position.array,
    )
    .filter((position) => position.length === 6) // 2 vertices → an axis line (not the grid batch)
    .map((position) => [position[0], position[1], position[2]] as [number, number, number]);
}

// Read the batched grid LineSegments (the many-vertex one) and return the world spacing between
// consecutive parallel grid lines along each in-plane axis. For the xy plane, lines of constant x
// (varying y) are the x-ticks and vice versa; sorted, consecutive deltas are the world tick spacing.
function gridSpacings(root: Object3D): { x: number[]; y: number[] } {
  const grid = root.children
    .filter((child) => (child as { isLineSegments?: boolean }).isLineSegments === true)
    .map(
      (line) =>
        (line as unknown as { geometry: { attributes: { position: { array: Float32Array } } } })
          .geometry.attributes.position.array,
    )
    .find((position) => position.length > 6);
  const constX = new Set<number>();
  const constY = new Set<number>();
  if (grid !== undefined) {
    for (let o = 0; o + 6 <= grid.length; o += 6) {
      const [x0, y0, , x1, y1] = [grid[o], grid[o + 1], grid[o + 2], grid[o + 3], grid[o + 4]];
      if (x0 === x1 && y0 !== y1)
        constX.add(x0 as number); // line runs along y at fixed x → an x-tick
      else if (y0 === y1 && x0 !== x1) constY.add(y0 as number); // runs along x at fixed y → a y-tick
    }
  }
  const deltas = (s: Set<number>): number[] => {
    const v = [...s].sort((a, b) => a - b);
    return v.slice(1).map((value, i) => value - (v[i] as number));
  };
  return { x: deltas(constX), y: deltas(constY) };
}

describe("createSceneOverlay", () => {
  it("builds one batched LineSegments per enabled plane plus three axis lines", () => {
    const overlay = createSceneOverlay(config());
    expect(countLineSegments(overlay.scene)).toBe(1 + 3); // xz plane + x/y/z axes
    overlay.dispose();
  });

  it("draws no grid when show.grid is false (axes only)", () => {
    const overlay = createSceneOverlay(
      config({ show: { grid: false, axes: true, labels: false } }),
    );
    expect(countLineSegments(overlay.scene)).toBe(3);
    overlay.dispose();
  });

  it("draws no axis lines when show.axes is false", () => {
    const overlay = createSceneOverlay(
      config({ show: { grid: true, axes: false, labels: false } }),
    );
    expect(countLineSegments(overlay.scene)).toBe(1); // the xz plane only
    overlay.dispose();
  });

  it("draws nothing when grid is on but no planes are selected", () => {
    const overlay = createSceneOverlay(
      config({
        planes: { xy: false, yz: false, xz: false },
        show: { grid: true, axes: false, labels: false },
      }),
    );
    expect(countLineSegments(overlay.scene)).toBe(0);
    overlay.dispose();
  });

  it("sums planes: all three enabled → three grid LineSegments + three axes", () => {
    const overlay = createSceneOverlay(config({ planes: { xy: true, yz: true, xz: true } }));
    expect(countLineSegments(overlay.scene)).toBe(3 + 3);
    overlay.dispose();
  });

  it("anchors the axes at the data origin (0,0,0), not the box corner, for interior bounds", () => {
    // Dipole-like non-cubic bounds: x∈[-10,5] (origin interior), y,z∈[-5,5] (origin at center).
    const overlay = createSceneOverlay(
      config({
        axes: [axis(-10, 5, "x"), axis(-5, 5, "y"), axis(-5, 5, "z")],
        worldHalfExtent: [0.5, 1 / 3, 1 / 3],
        show: { grid: false, axes: true, labels: false },
      }),
    );
    const [xStart, yStart, zStart] = axisLineStarts(overlay.scene);
    // Physical 0 maps to world x = ((0-(-10))/15 - 0.5)*1 = +1/6; y,z origins sit at world 0 (center).
    expect(xStart?.[0]).toBeCloseTo(1 / 6, 6);
    expect(xStart?.[1]).toBeCloseTo(0, 6);
    expect(xStart?.[2]).toBeCloseTo(0, 6);
    // All three axes share the same cross-point (the data origin), not the −half corner.
    expect(yStart).toEqual(xStart);
    expect(zStart).toEqual(xStart);
    overlay.dispose();
  });

  it("keeps the axes at the corner when the origin is the box minimum (cubic flux rope)", () => {
    // All-positive bounds [0,256]: physical 0 is the min face → the corner, unchanged from before.
    const overlay = createSceneOverlay(
      config({ show: { grid: false, axes: true, labels: false } }),
    );
    const [xStart] = axisLineStarts(overlay.scene);
    expect(xStart).toEqual([-0.5, -0.5, -0.5]);
    overlay.dispose();
  });

  it("spaces the grid equally in every direction for anisotropic bounds (the dipole)", () => {
    // Dipole bounds rendered at true aspect: x∈[-10,5] (span 15, half 0.5), y∈[-5,5] (span 10, half
    // 1/3). A shared physical step (2) → equal *world* spacing on both axes, not the per-axis 2 vs 1.
    const overlay = createSceneOverlay(
      config({
        axes: [axis(-10, 5, "x"), axis(-5, 5, "y"), axis(-5, 5, "z")],
        worldHalfExtent: [0.5, 1 / 3, 1 / 3],
        planes: { xy: true, yz: false, xz: false },
        show: { grid: true, axes: false, labels: false },
      }),
    );
    const { x, y } = gridSpacings(overlay.scene);
    expect(x.length).toBeGreaterThan(0);
    expect(y.length).toBeGreaterThan(0);
    const all = [...x, ...y];
    const first = all[0] as number;
    for (const d of all) expect(d).toBeCloseTo(first, 6); // uniform world spacing across both axes
    expect(first).toBeCloseTo(2 / 15, 6); // physical step 2 over span 15 at half 0.5
    overlay.dispose();
  });

  it("keeps per-axis tick counts equal for cubic bounds (flux rope regression)", () => {
    // Equal spans → the shared step equals the old per-axis step → spacing unchanged.
    const overlay = createSceneOverlay(config({ planes: { xy: true, yz: false, xz: false } }));
    const { x, y } = gridSpacings(overlay.scene);
    expect(x).toEqual(y);
    overlay.dispose();
  });

  it("disposes every geometry and material it created", () => {
    const overlay = createSceneOverlay(config({ show: { grid: true, axes: true, labels: false } }));
    const disposeSpies = overlay.scene.children
      .filter((child) => (child as { isLineSegments?: boolean }).isLineSegments === true)
      .flatMap((child) => {
        const ls = child as unknown as {
          geometry: { dispose(): void };
          material: { dispose(): void };
        };
        return [vi.spyOn(ls.geometry, "dispose"), vi.spyOn(ls.material, "dispose")];
      });
    overlay.dispose();
    for (const spy of disposeSpies) expect(spy).toHaveBeenCalled();
  });
});

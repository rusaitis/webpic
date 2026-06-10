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

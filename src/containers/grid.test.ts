import { describe, expect, it } from "vitest";
import type { GridInfo } from "./field_dataset.ts";
import { axisPhysicalSpan, hasUsableSpacing, worldHalfExtentForGrid } from "./grid.ts";

const gridOf = (dimensions: number[], spacing: number[]): GridInfo => ({
  dimensions,
  spacing,
  origin: [0, 0, 0],
  geometry: "cartesian",
  axisLabels: ["x", "y", "z"],
  dt: null,
  boundary: null,
  survivingAxes: null,
  stagger: null,
});

describe("axisPhysicalSpan", () => {
  it("is spacing·dim with usable spacing and the voxel-index span without", () => {
    const grid = gridOf([10, 4, 2], [0.5, 0, Number.NaN]);
    expect(hasUsableSpacing(grid, 0)).toBe(true);
    expect(axisPhysicalSpan(grid, 0)).toBe(5);
    expect(hasUsableSpacing(grid, 1)).toBe(false);
    expect(axisPhysicalSpan(grid, 1)).toBe(4);
    expect(axisPhysicalSpan(grid, 2)).toBe(2);
  });
});

describe("worldHalfExtentForGrid", () => {
  it("is the unit box for a cubic grid (cubic datasets render unchanged)", () => {
    expect(worldHalfExtentForGrid(gridOf([32, 32, 32], [1, 1, 1]))).toEqual([0.5, 0.5, 0.5]);
  });

  it("normalizes a non-cubic grid so the longest axis is 0.5 (the dipole aspect)", () => {
    const h = worldHalfExtentForGrid(gridOf([150, 100, 100], [0.1, 0.1, 0.1])); // spans 15, 10, 10
    expect(h[0]).toBeCloseTo(0.5, 12);
    expect(h[1]).toBeCloseTo(1 / 3, 12);
    expect(h[2]).toBeCloseTo(1 / 3, 12);
  });

  it("falls back to voxel-index spans when spacing is unusable", () => {
    expect(worldHalfExtentForGrid(gridOf([10, 4, 2], [0, 0, 0]))).toEqual([0.5, 0.2, 0.1]);
  });
});

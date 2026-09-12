import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAY,
  GRID_DIVISIONS_MAX,
  GRID_DIVISIONS_MIN,
  setGridDivisions,
  setOverlayFlag,
  setPlane,
} from "./overlay.ts";

describe("DEFAULT_OVERLAY", () => {
  it("starts with the equatorial (xy) plane, axes, labels, and gnomon on", () => {
    expect(DEFAULT_OVERLAY.showGrid).toBe(true);
    expect(DEFAULT_OVERLAY.planes).toEqual({ xy: true, yz: false, xz: false });
    expect(DEFAULT_OVERLAY.showAxes).toBe(true);
    expect(DEFAULT_OVERLAY.showLabels).toBe(true);
    expect(DEFAULT_OVERLAY.showGnomon).toBe(true);
  });
});

describe("identity-skip on no-ops", () => {
  it("returns the same reference when nothing changes", () => {
    expect(setOverlayFlag(DEFAULT_OVERLAY, "showGrid", true)).toBe(DEFAULT_OVERLAY);
    expect(setOverlayFlag(DEFAULT_OVERLAY, "showAxes", true)).toBe(DEFAULT_OVERLAY);
    expect(setOverlayFlag(DEFAULT_OVERLAY, "showLabels", true)).toBe(DEFAULT_OVERLAY);
    expect(setOverlayFlag(DEFAULT_OVERLAY, "showGnomon", true)).toBe(DEFAULT_OVERLAY);
    expect(setPlane(DEFAULT_OVERLAY, "xy", true)).toBe(DEFAULT_OVERLAY);
    expect(setGridDivisions(DEFAULT_OVERLAY, DEFAULT_OVERLAY.gridDivisions)).toBe(DEFAULT_OVERLAY);
  });
});

describe("setOverlayFlag", () => {
  it("returns a fresh object on a real change without mutating the input", () => {
    const next = setOverlayFlag(DEFAULT_OVERLAY, "showGrid", false);
    expect(next).not.toBe(DEFAULT_OVERLAY);
    expect(next.showGrid).toBe(false);
    expect(DEFAULT_OVERLAY.showGrid).toBe(true); // input untouched
  });
});

describe("setPlane", () => {
  it("flips only the named plane", () => {
    const next = setPlane(DEFAULT_OVERLAY, "yz", true);
    expect(next.planes).toEqual({ xy: true, yz: true, xz: false });
    expect(DEFAULT_OVERLAY.planes.yz).toBe(false); // input untouched
  });
});

describe("setGridDivisions", () => {
  it("clamps, rounds, and identity-skips", () => {
    expect(setGridDivisions(DEFAULT_OVERLAY, 1).gridDivisions).toBe(GRID_DIVISIONS_MIN);
    expect(setGridDivisions(DEFAULT_OVERLAY, 999).gridDivisions).toBe(GRID_DIVISIONS_MAX);
    expect(setGridDivisions(DEFAULT_OVERLAY, 6.7).gridDivisions).toBe(7);
    expect(setGridDivisions(DEFAULT_OVERLAY, Number.NaN).gridDivisions).toBe(GRID_DIVISIONS_MIN);
  });
});

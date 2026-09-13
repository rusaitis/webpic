import type { GridInfo } from "@containers/field_dataset.ts";
import type { CameraPose } from "@store";
import { describe, expect, it } from "vitest";
import { makeGrid } from "../../../tests/fixtures.ts";
import { coordsLabel, formatCenter, formatOrientation, gridInfoRows } from "./coordsInfo.ts";

const grid = (overrides: Partial<GridInfo> = {}): GridInfo => ({
  ...makeGrid([32, 32, 32]),
  ...overrides,
});

const rows = (g: GridInfo, frame: string, units: string): Record<string, string> =>
  Object.fromEntries(gridInfoRows(g, frame, units));

describe("coordsLabel", () => {
  it("joins the coordinate-system name with its spatial units", () => {
    expect(coordsLabel("lab", "code units")).toBe("lab · code units");
    expect(coordsLabel("GSM", "R_E")).toBe("GSM · R_E");
  });

  it("shows the name alone when units are empty", () => {
    expect(coordsLabel("Cartesian", "")).toBe("Cartesian");
  });

  it("reads — with no dataset (null name)", () => {
    expect(coordsLabel(null, "code units")).toBe("—");
  });
});

describe("gridInfoRows", () => {
  it("describes the coordinate domain (frame/geometry/units/grid), never the field", () => {
    const r = rows(grid({ origin: [-1, -1, -1], spacing: [0.5, 0.5, 0.5] }), "GSM", "R_E");
    expect(r.Frame).toBe("GSM");
    expect(r.Geometry).toBe("Cartesian");
    expect(r.Units).toBe("R_E");
    expect(r.Grid).toBe("32 × 32 × 32");
    expect(r["Grid spacing"]).toBe("0.5, 0.5, 0.5");
    expect(r.Extent).toBe("x [-1, 15]   y [-1, 15]   z [-1, 15]");
    expect(r.Axes).toBe("x, y, z");
    // Field / Planes / Divisions are deliberately gone — coordinate-only card.
    expect(r.Field).toBeUndefined();
    expect(r.Planes).toBeUndefined();
    expect(r.Divisions).toBeUndefined();
  });

  it("falls back to voxel extent + non-uniform when spacing is invalid", () => {
    const r = rows(grid({ spacing: [0, 0, 0] }), "lab", "code units");
    expect(r["Grid spacing"]).toBe("non-uniform");
    expect(r.Extent).toBe("x [0, 32]   y [0, 32]   z [0, 32]");
  });
});

describe("formatOrientation + formatCenter", () => {
  const pose: CameraPose = { target: [1, -2, 0.5], azimuth: 0, elevation: 0, distance: 2, roll: 0 };

  it("orientation reads as azimuth, elevation and distance", () => {
    // Pinned whole: an identifier sweep once rewrote the "el" label to "element" in this very string.
    expect(formatOrientation({ ...pose, azimuth: Math.PI / 4 }, false)).toBe(
      "az 45°  el 0°  d 2.00",
    );
  });

  it("orientation carries angles/zoom + an ortho suffix only under orthographic, not the center", () => {
    expect(formatOrientation(pose, false)).toContain("d 2.00");
    expect(formatOrientation(pose, false)).not.toContain("ortho");
    expect(formatOrientation(pose, true)).toContain("ortho");
    expect(formatOrientation(pose, false)).not.toContain("1.00"); // the target lives in formatCenter
  });

  it("orientation shows roll only once the view is actually banked", () => {
    expect(formatOrientation(pose, false)).not.toContain("roll");
    expect(formatOrientation({ ...pose, roll: Math.PI / 6 }, false)).toContain("roll 30°");
  });

  it("center is the orbit target alone", () => {
    expect(formatCenter(pose)).toBe("1.00, -2.00, 0.50");
  });
});

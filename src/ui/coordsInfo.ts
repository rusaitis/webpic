import type { GeometryType, GridInfo } from "@containers/field_dataset.ts";
import type { CameraPose } from "@store";

// Pure readout formatters for the bottom rail's coordinate chip + its grid-info card (ui/cameraRail).
// Typed-in, string-out — no DOM, no store — so they're node-testable like the math layers. Everything
// here describes the coordinate DOMAIN (frame, geometry, spatial units, grid), never the displayed
// field — the domain is the same whichever volume / field-lines are drawn over it.

const RAD_TO_DEG = 180 / Math.PI;
// Banking under ~0.5° reads as 0° and clutters the readout; hide it until the view is actually rolled.
const ROLL_READOUT_EPSILON = 0.0087;

export const GEOMETRY_LABEL: Readonly<Record<GeometryType, string>> = {
  cartesian: "Cartesian",
  spherical: "Spherical",
  cylindrical: "Cylindrical",
  thetaMode: "Theta-mode",
};

// Spatial units of the coordinate axes — a property of the domain, not of any field. pypic's
// [coordinates] length unit (m, km, R_E, d_i, …) lives in the simulation config, not the per-dataset
// Zarr attrs we decode, so loaded data reads as the simulation's own code units; a physical frame
// (GSM, …) will surface its real unit here once that metadata is plumbed through.
export const COORDINATE_UNITS = "code units";

// The always-visible rail chip: coordinate-system name · spatial units ("lab · code units",
// "GSM · R_E"). "—" with no dataset loaded (null name); units omitted if empty.
export function coordsLabel(systemName: string | null, units: string): string {
  if (systemName === null) return "—";
  return units ? `${systemName} · ${units}` : systemName;
}

// The camera's orientation + zoom — the card's "View" row. Projection adds an "ortho" suffix so the
// view's mode is legible at a glance. Paired with formatCenter below (the orbit target it omits).
export function formatOrientation(pose: CameraPose, isOrthographic: boolean): string {
  const az = (pose.azimuth * RAD_TO_DEG).toFixed(0);
  const elevation = (pose.elevation * RAD_TO_DEG).toFixed(0);
  const roll =
    Math.abs(pose.roll) > ROLL_READOUT_EPSILON
      ? `  roll ${(pose.roll * RAD_TO_DEG).toFixed(0)}°`
      : "";
  const suffix = isOrthographic ? "  ·  ortho" : "";
  return `az ${az}°  el ${elevation}°  d ${pose.distance.toFixed(2)}${roll}${suffix}`;
}

// The orbit target — the card's "Center" row (the world point the camera looks at / pivots around).
export function formatCenter(pose: CameraPose): string {
  const [tx, ty, tz] = pose.target;
  return `${tx.toFixed(2)}, ${ty.toFixed(2)}, ${tz.toFixed(2)}`;
}

// Trim a coordinate to 3 decimals without trailing zeros (1.0000 → "1", 0.100 → "0.1"); NaN/Inf verbatim.
function num(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Number.parseFloat(value.toFixed(3)));
}

// Per-axis world extent, matching app/sceneBridge.buildAxis: physical [origin, origin+spacing·dim] when
// the spacing is finite and positive, else the voxel range [0, dim]. Inlined (ui can't reach app).
function axisExtent(grid: GridInfo, i: number): readonly [number, number] {
  const dim = grid.dimensions[i] ?? 1;
  const spacing = grid.spacing[i];
  const origin = grid.origin[i] ?? 0;
  return spacing !== undefined && Number.isFinite(spacing) && spacing > 0
    ? [origin, origin + spacing * dim]
    : [0, dim];
}

// Key/value rows for the grid-info card: the loaded coordinate frame, geometry, spatial units, grid
// shape, the current grid spacing, world extent, and axis labels — all field-agnostic.
export function gridInfoRows(
  grid: GridInfo,
  frame: string,
  units: string,
): ReadonlyArray<readonly [string, string]> {
  const dims = grid.dimensions.map(num).join(" × ");
  const spacing = grid.spacing.every((s) => Number.isFinite(s) && s > 0)
    ? grid.spacing.map(num).join(", ")
    : "non-uniform";
  const extent = grid.axisLabels
    .map((label, i) => {
      const [lo, hi] = axisExtent(grid, i);
      return `${label} [${num(lo)}, ${num(hi)}]`;
    })
    .join("   ");
  return [
    ["Frame", frame],
    ["Geometry", GEOMETRY_LABEL[grid.geometry]],
    ["Units", units],
    ["Grid", dims],
    ["Grid spacing", spacing],
    ["Extent", extent],
    ["Axes", grid.axisLabels.join(", ")],
  ];
}

import type { Vec3 } from "@schema/types.ts";
import type { GridInfo } from "./field_dataset.ts";

// Grid geometry the unit box, the scene-overlay bounds, and seed picking must all agree on: one
// definition of an axis's physical span, and the per-axis world half-extent derived from it.

/** Does the grid carry usable (finite, positive) spacing on this axis? Else callers fall back to
 *  voxel-index coordinates [0, dim]. */
export function hasUsableSpacing(grid: GridInfo, axis: number): boolean {
  const spacing = grid.spacing[axis];
  return spacing !== undefined && Number.isFinite(spacing) && spacing > 0;
}

/** Physical span of one axis (spacing·dim), or the voxel-index span (dim) when spacing is unusable. */
export function axisPhysicalSpan(grid: GridInfo, axis: number): number {
  const dim = grid.dimensions[axis] ?? 1;
  const spacing = grid.spacing[axis];
  return hasUsableSpacing(grid, axis) && spacing !== undefined ? spacing * dim : dim;
}

/** Per-axis world half-extent: physical spans normalized so the longest axis is 0.5 (the unit box).
 *  Cubic grids → [0.5, 0.5, 0.5]; non-cubic ones drive the volume box aspect — the renderer scales
 *  the mesh to it, the overlay maps onto it, the picker clamps to it. */
export function worldHalfExtentForGrid(grid: GridInfo): Vec3 {
  const sx = axisPhysicalSpan(grid, 0);
  const sy = axisPhysicalSpan(grid, 1);
  const sz = axisPhysicalSpan(grid, 2);
  const max = Math.max(sx, sy, sz) || 1;
  return [(0.5 * sx) / max, (0.5 * sy) / max, (0.5 * sz) / max];
}

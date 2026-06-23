// Cross-cutting inline-SVG affordance icons — the glyphs shared by ≥2 surfaces or used by the generic
// controls layer. 16×16, aria-hidden; `fill: none; stroke: currentColor` (+ size) come from each
// host's CSS, so the same mark tints to wherever it mounts. Surface-specific glyphs (gnomon, brand,
// layers, …) stay with their component — these are only the reusable affordances. A constant SVG via
// innerHTML carries no user data, so it bypasses no sanitization.

// The × close affordance (rail flyout, floating window) — one identical mark everywhere.
export const ICON_CLOSE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

// The ✓ selected-row check (single-select popover).
export const ICON_CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`;

// Dropdown carets — two deliberately distinct shapes: a deep symmetric chevron (swatch/select) and a
// flatter one (the topbar's pill buttons). Kept separate so neither surface's glyph shifts.
export const ICON_CARET = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`;
export const ICON_CARET_FLAT = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5 8 10l4-3.5"/></svg>`;

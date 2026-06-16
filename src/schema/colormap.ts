import type { FieldName } from "./types.ts";

// The reified color-mapping a renderable layer references (DESIGN §Magviz Stage 8 coordination). @webpic/schema is the
// authority for this shape — render/store/ui import it, restating nothing. Window/level in the
// canonical {center, width} form; a discriminated scale. No per-binding units/min,max (units come
// from the registry/theme; the range is the window) or linthresh (symlog's half-width is auto-derived).

// The colormaps webpic ships in v0.1 — the keys render/colormap.ts has polynomial fits for. A
// ColormapBinding stores one of these; theme strings + arbitrary labels resolve to one at the
// render boundary (resolveColormapName), falling back to inferno.
export type ColormapId = "inferno" | "viridis" | "plasma" | "magma";
export const COLORMAP_IDS = ["inferno", "viridis", "plasma", "magma"] as const;
export const DEFAULT_COLORMAP: ColormapId = "inferno";

// value→color mapping within the window. Mirrors the UI RangeControl's ScaleKind (rangeMath.ts) so
// the slider track and the rendered transfer agree.
export type ColorScale = "linear" | "log" | "symlog";
export const COLOR_SCALES = ["linear", "log", "symlog"] as const;

// Value→color window in the canonical {center, width} form (not a separate min/max). ui's
// rangeMath.ts keeps a local copy so that sublayer stays dependency-free and liftable.
export interface WindowLevel {
  readonly center: number;
  readonly width: number;
}

export interface ColormapBinding {
  readonly id: string;
  readonly field: FieldName;
  readonly colormap: ColormapId;
  readonly window: WindowLevel;
  readonly scale: ColorScale;
}

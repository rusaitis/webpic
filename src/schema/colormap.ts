import type { FieldName } from "./types.ts";

// The reified color-mapping a renderable layer references (DESIGN §1010). @webpic/schema is the
// authority for this shape — render/store/ui restate nothing, they import it. webpic-native, not a
// mirror of magviz's prototype: typed FieldName + ColormapId, window/level in the canonical
// {center, width} form (matching the M2.3 RangeControl), and a discriminated scale. No per-binding
// `units`/`min,max`/`transparentBounds` (units come from the registry/theme; the range is the
// window) and no `linthresh` (symlog's linear half-width is auto-derived in UI + render alike).

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

// Value→color window in the canonical {center, width} form (not a separate min/max). The one
// definition store and render import — the only restated copy left is ui/controls/rangeMath.ts's,
// kept local so that sublayer stays dependency-free and liftable.
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

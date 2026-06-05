import type { FieldName } from "@schema/types.ts";

// The instance-first layer registry (DESIGN §"Layers & navigation"): the scene is a flat,
// ordered list of renderable instances, each owning its kind, field, visibility, opacity, and
// (M2.5b) ColormapBinding. The store owns the list; the app diffs it to the render worker, which
// composites the visible layers by draw order. These are pure list ops — node-testable, framework-
// free, fresh-object-per-change for `subscribeWithSelector`, identity-preserving on no-ops.

// Restated, not shared, with render/sliceScene.ts's SliceAxis: the ui→store→render DAG forbids
// store importing render (same precedent as WindowLevel / CameraPose). Members are identical, so
// the app re-narrows store SliceAxis → render SliceAxis on the wire.
export type SliceAxis = "x" | "y" | "z";

interface LayerBase {
  readonly id: string;
  readonly field: FieldName;
  // The ColormapBinding (store/colormap.ts) this layer references for colormap + window/level +
  // scale. The store seeds one with each renderable layer; null only before a layer is bound (a
  // null binding renders with the DEFAULT_COLORMAP / linear / full-range fallback).
  readonly colormapBindingId: string | null;
  readonly visible: boolean;
  readonly opacity: number; // [0, 1]
}

export type Layer =
  | (LayerBase & { readonly kind: "slice"; readonly axis: SliceAxis; readonly position: number })
  | (LayerBase & {
      readonly kind: "volume";
      readonly steps: number | null;
      readonly density: number | null;
    })
  | (LayerBase & { readonly kind: "fieldlines" })
  | (LayerBase & { readonly kind: "particles" });

export type LayerKind = Layer["kind"];

// Distribute over the union so each member keeps its own kind-specific keys — a plain
// `Omit<Layer, "id">` would collapse the discriminant correlation.
type DistributeOmitId<T> = T extends unknown ? Omit<T, "id"> : never;
export type LayerSpec = DistributeOmitId<Layer>;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

// The kind's full default (visible, opaque, no binding). Slice defaults reproduce the legacy
// app slice (axis z, mid-plane); volume defaults defer steps/density to the render-side defaults.
export function makeDefaultLayer(id: string, field: FieldName, kind: LayerKind): Layer {
  const base = { id, field, colormapBindingId: null, visible: true, opacity: 1 } as const;
  switch (kind) {
    case "slice":
      return { ...base, kind, axis: "z", position: 0.5 };
    case "volume":
      return { ...base, kind, steps: null, density: null };
    case "fieldlines":
      return { ...base, kind };
    case "particles":
      return { ...base, kind };
  }
}

export function addLayer(list: readonly Layer[], layer: Layer): readonly Layer[] {
  return [...list, layer];
}

export function removeLayer(list: readonly Layer[], id: string): readonly Layer[] {
  const next = list.filter((layer) => layer.id !== id);
  return next.length === list.length ? list : next; // no match → identity, no spurious fire
}

export function reorderLayer(
  list: readonly Layer[],
  id: string,
  toIndex: number,
): readonly Layer[] {
  const from = list.findIndex((layer) => layer.id === id);
  if (from === -1) return list;
  const to = clamp(toIndex, 0, list.length - 1);
  if (from === to) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return list; // unreachable (from is valid), satisfies noUncheckedIndexedAccess
  next.splice(to, 0, moved);
  return next;
}

export function setLayerVisible(
  list: readonly Layer[],
  id: string,
  visible: boolean,
): readonly Layer[] {
  let changed = false;
  const next = list.map((layer) => {
    if (layer.id !== id || layer.visible === visible) return layer;
    changed = true;
    return { ...layer, visible };
  });
  return changed ? next : list;
}

export function setLayerOpacity(
  list: readonly Layer[],
  id: string,
  opacity: number,
): readonly Layer[] {
  const clamped = clamp(opacity, 0, 1);
  let changed = false;
  const next = list.map((layer) => {
    if (layer.id !== id || layer.opacity === clamped) return layer;
    changed = true;
    return { ...layer, opacity: clamped };
  });
  return changed ? next : list;
}

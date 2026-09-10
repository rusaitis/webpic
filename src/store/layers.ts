import type { GridInfo } from "@containers/field_dataset.ts";
import type { LayerKind, SliceAxis } from "@schema/layers.ts";
import { clamp } from "@schema/math.ts";
import type { FieldName, Vec3 } from "@schema/types.ts";
import { LAYER_KINDS } from "./layerKinds.ts";
import { defaultSeedRake, isSeedInDomain } from "./seedPick.ts";

export type { LayerKind, SliceAxis };

// The instance-first layer registry (DESIGN §"Layers & navigation"): the scene is a flat,
// ordered list of renderable instances, each owning its kind, field, visibility, opacity, and
// a ColormapBinding. The store owns the list; the app diffs it to the render worker, which
// composites the visible layers by draw order. These are pure list ops — node-testable, framework-
// free, fresh-object-per-change for `subscribeWithSelector`, identity-preserving on no-ops.

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
      // Phong shading toggle: a shape-perception aid, off by default for quantitative work (the lit
      // surface is a TF-dependent opacity isosurface, not a physical boundary).
      readonly shaded: boolean;
    })
  | (LayerBase & {
      readonly kind: "fieldlines";
      // Trace seeds in the grid's *physical* coords (store/seedPick), one field line per seed. The app
      // traces them (compute/traceField) and bridges the lines to the render worker.
      readonly seeds: ReadonlyArray<Vec3>;
    });

// Distribute over the union so each member keeps its own kind-specific keys — a plain
// `Omit<Layer, "id">` would collapse the discriminant correlation.
type DistributeOmitId<T> = T extends unknown ? Omit<T, "id"> : never;
export type LayerSpec = DistributeOmitId<Layer>;

// The kind's full default (visible, opaque, no binding, no seeds) — the descriptor table's spec
// with an id stamped on.
export function makeDefaultLayer(id: string, field: FieldName, kind: LayerKind): Layer {
  // The spec is the union member sans id; stamping the id reconstructs it.
  return { ...LAYER_KINDS[kind].makeDefaultSpec(field, null), id } as Layer;
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

// Toggle Phong shading on a volume layer. A no-op (identity) for a missing id, a non-volume kind
// (only volumes carry a shading normal), or an unchanged flag — so no spurious subscriber fire.
export function setLayerShading(
  list: readonly Layer[],
  id: string,
  shaded: boolean,
): readonly Layer[] {
  let changed = false;
  const next = list.map((layer) => {
    if (layer.id !== id || layer.kind !== "volume" || layer.shaded === shaded) return layer;
    changed = true;
    return { ...layer, shaded };
  });
  return changed ? next : list;
}

// Set a slice layer's held axis. Identity for a missing id, a non-slice kind, or an unchanged axis.
export function setSliceAxis(
  list: readonly Layer[],
  id: string,
  axis: SliceAxis,
): readonly Layer[] {
  let changed = false;
  const next = list.map((layer) => {
    if (layer.id !== id || layer.kind !== "slice" || layer.axis === axis) return layer;
    changed = true;
    return { ...layer, axis };
  });
  return changed ? next : list;
}

// Set a slice layer's position along the held axis, clamped to [0, 1]. Identity for a missing id, a
// non-slice kind, or an unchanged position.
export function setSlicePosition(
  list: readonly Layer[],
  id: string,
  position: number,
): readonly Layer[] {
  const clamped = clamp(position, 0, 1);
  let changed = false;
  const next = list.map((layer) => {
    if (layer.id !== id || layer.kind !== "slice" || layer.position === clamped) return layer;
    changed = true;
    return { ...layer, position: clamped };
  });
  return changed ? next : list;
}

// Replace a fieldlines layer's seed set. Identity for a missing id, a non-fieldlines kind, or the
// same array reference (the caller mints a fresh array per edit) — so no spurious retrace.
export function setFieldlineSeeds(
  list: readonly Layer[],
  id: string,
  seeds: ReadonlyArray<Vec3>,
): readonly Layer[] {
  let changed = false;
  const next = list.map((layer) => {
    if (layer.id !== id || layer.kind !== "fieldlines" || layer.seeds === seeds) return layer;
    changed = true;
    return { ...layer, seeds };
  });
  return changed ? next : list;
}

// Seeds are physical coordinates, so a rake laid on one dataset is meaningless on another (the flux
// rope spans [0,n], the dipole x∈[-10,5]). When every seed of a layer misses the new grid it is a
// stale rake, not a placed set — re-rake it at the same count so the layer keeps drawing. A partial
// miss is left alone: the per-seed skip drops the strays and keeps the user's placed seeds.
export function rerakeStaleSeeds(layers: readonly Layer[], grid: GridInfo): readonly Layer[] {
  let changed = false;
  const next = layers.map((layer) => {
    if (layer.kind !== "fieldlines" || layer.seeds.length === 0) return layer;
    if (layer.seeds.some((seed) => isSeedInDomain(seed, grid))) return layer;
    changed = true;
    return { ...layer, seeds: defaultSeedRake(grid, layer.seeds.length) };
  });
  return changed ? next : layers;
}

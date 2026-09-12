import type { GridInfo } from "@containers/field_dataset.ts";
import type { LayerKind, SliceAxis } from "@schema/layers.ts";
import { clamp } from "@schema/math.ts";
import type { FieldName, Vec3 } from "@schema/types.ts";
import { defaultSeedRake, isSeedInDomain } from "./interaction/seedPick.ts";
import { LAYER_KINDS } from "./layerKinds.ts";

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
      // Trace seeds in the grid's *physical* coords (store/interaction/seedPick), one field line per seed. The app
      // traces them (compute/traceField) and bridges the lines to the render worker.
      readonly seeds: ReadonlyArray<Vec3>;
    });

// Distribute over the union so each member keeps its own kind-specific keys — a plain
// `Omit<Layer, "id">` would collapse the discriminant correlation.
type DistributeOmitId<T> = T extends unknown ? Omit<T, "id"> : never;
export type LayerSpec = DistributeOmitId<Layer>;

// Re-attach the id and the minted binding to a spec. A bare spread now type-checks too; the switch
// stays as the exhaustiveness gate — a fourth LayerKind falls through to no return and fails the
// declared `Layer`, so it cannot ship undescribed.
export function makeLayer(spec: LayerSpec, id: string, colormapBindingId: string | null): Layer {
  switch (spec.kind) {
    case "slice":
      return { ...spec, id, colormapBindingId };
    case "volume":
      return { ...spec, id, colormapBindingId };
    case "fieldlines":
      return { ...spec, id, colormapBindingId };
  }
}

// The kind's full default (visible, opaque, no binding, no seeds) — the descriptor table's spec
// with an id stamped on.
export function makeDefaultLayer(id: string, field: FieldName, kind: LayerKind): Layer {
  return makeLayer(LAYER_KINDS[kind].makeDefaultSpec(field, null), id, null);
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

// The shared setter skeleton: a `patch` returning null — no match, wrong kind, or an unchanged
// value — leaves the list identical, so a no-op never fires a subscriber. Every setter below is
// this one rule. (`store/colormap.ts` holds the record-shaped twin, `patchBinding`.)
function patchEachLayer(
  list: readonly Layer[],
  patch: (layer: Layer) => Layer | null,
): readonly Layer[] {
  let changed = false;
  const next = list.map((layer) => {
    const patched = patch(layer);
    if (patched === null) return layer;
    changed = true;
    return patched;
  });
  return changed ? next : list;
}

function patchLayer(
  list: readonly Layer[],
  id: string,
  patch: (layer: Layer) => Layer | null,
): readonly Layer[] {
  return patchEachLayer(list, (layer) => (layer.id === id ? patch(layer) : null));
}

export function setLayerVisible(
  list: readonly Layer[],
  id: string,
  visible: boolean,
): readonly Layer[] {
  return patchLayer(list, id, (layer) =>
    layer.visible === visible ? null : { ...layer, visible },
  );
}

export function setLayerOpacity(
  list: readonly Layer[],
  id: string,
  opacity: number,
): readonly Layer[] {
  const clamped = clamp(opacity, 0, 1);
  return patchLayer(list, id, (layer) =>
    layer.opacity === clamped ? null : { ...layer, opacity: clamped },
  );
}

// Only volumes carry a shading normal, so a non-volume kind is a no-op rather than an error.
export function setLayerShading(
  list: readonly Layer[],
  id: string,
  shaded: boolean,
): readonly Layer[] {
  return patchLayer(list, id, (layer) =>
    layer.kind !== "volume" || layer.shaded === shaded ? null : { ...layer, shaded },
  );
}

export function setSliceAxis(
  list: readonly Layer[],
  id: string,
  axis: SliceAxis,
): readonly Layer[] {
  return patchLayer(list, id, (layer) =>
    layer.kind !== "slice" || layer.axis === axis ? null : { ...layer, axis },
  );
}

export function setSlicePosition(
  list: readonly Layer[],
  id: string,
  position: number,
): readonly Layer[] {
  const clamped = clamp(position, 0, 1);
  return patchLayer(list, id, (layer) =>
    layer.kind !== "slice" || layer.position === clamped ? null : { ...layer, position: clamped },
  );
}

// Compared by reference: the caller mints a fresh array per edit, so an equal-but-new array is a
// real edit and must retrace.
export function setFieldlineSeeds(
  list: readonly Layer[],
  id: string,
  seeds: ReadonlyArray<Vec3>,
): readonly Layer[] {
  return patchLayer(list, id, (layer) =>
    layer.kind !== "fieldlines" || layer.seeds === seeds ? null : { ...layer, seeds },
  );
}

// Seeds are physical coordinates, so a rake laid on one dataset is meaningless on another (the flux
// rope spans [0,n], the dipole x∈[-10,5]). When every seed of a layer misses the new grid it is a
// stale rake, not a placed set — re-rake it at the same count so the layer keeps drawing. A partial
// miss is left alone: the per-seed skip drops the strays and keeps the user's placed seeds.
export function rerakeStaleSeeds(layers: readonly Layer[], grid: GridInfo): readonly Layer[] {
  return patchEachLayer(layers, (layer) => {
    if (layer.kind !== "fieldlines" || layer.seeds.length === 0) return null;
    if (layer.seeds.some((seed) => isSeedInDomain(seed, grid))) return null;
    return { ...layer, seeds: defaultSeedRake(grid, layer.seeds.length) };
  });
}

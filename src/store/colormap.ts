import {
  type ColormapBinding,
  type ColormapId,
  type ColorScale,
  DEFAULT_COLORMAP,
  type WindowLevel,
} from "@schema/colormap.ts";
import type { FieldName } from "@schema/types.ts";

// Pure record ops for the ColormapBinding registry (mirrors layers.ts): node-testable, framework-
// free, fresh-object-per-change for subscribeWithSelector, identity-preserving on no-ops. Bindings
// are keyed by id; layers reference them by colormapBindingId and share or split deliberately. The
// @schema ColormapBinding is the authority — these helpers only assemble/patch the record.

export type BindingRecord = Readonly<Record<string, ColormapBinding>>;

// A fresh binding for `field` over `window`: default colormap, linear scale.
export function makeDefaultBinding(
  id: string,
  field: FieldName,
  window: WindowLevel,
): ColormapBinding {
  return { id, field, colormap: DEFAULT_COLORMAP, window, scale: "linear" };
}

export function upsertBinding(rec: BindingRecord, binding: ColormapBinding): BindingRecord {
  return { ...rec, [binding.id]: binding };
}

// The shared setter skeleton: missing id, or a `patch` returning null (no-op), yields the same record;
// otherwise a fresh record with a fresh binding. Keeps every setter identity-preserving by one rule.
function patchBinding(
  rec: BindingRecord,
  id: string,
  patch: (binding: ColormapBinding) => ColormapBinding | null,
): BindingRecord {
  const binding = rec[id];
  if (binding === undefined) return rec;
  const next = patch(binding);
  return next === null ? rec : { ...rec, [id]: next };
}

export function setBindingColormap(
  rec: BindingRecord,
  id: string,
  colormap: ColormapId,
): BindingRecord {
  return patchBinding(rec, id, (b) => (b.colormap === colormap ? null : { ...b, colormap }));
}

export function setBindingWindow(
  rec: BindingRecord,
  id: string,
  center: number,
  width: number,
): BindingRecord {
  return patchBinding(rec, id, (b) =>
    b.window.center === center && b.window.width === width
      ? null
      : { ...b, window: { center, width } },
  );
}

export function setBindingScale(rec: BindingRecord, id: string, scale: ColorScale): BindingRecord {
  return patchBinding(rec, id, (b) => (b.scale === scale ? null : { ...b, scale }));
}

// Repoint a binding at a new field + window (a field switch reuses the binding instance so the
// referencing layer keeps its colormap/scale, only the value scale resets).
export function retargetBinding(
  rec: BindingRecord,
  id: string,
  field: FieldName,
  window: WindowLevel,
): BindingRecord {
  return patchBinding(rec, id, (b) => ({ ...b, field, window }));
}

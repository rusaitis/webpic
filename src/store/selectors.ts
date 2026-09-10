import type { FieldArray } from "@containers/field_dataset.ts";
import type { ColormapBinding } from "@schema/colormap.ts";
import type { Layer } from "./layers.ts";
import type { DataRange, SimulationState } from "./state.ts";

// Derived reads over the composed store. Each is a plain function of the state (usable as a
// subscribeWithSelector selector) that returns a stable reference for an unchanged input, so
// subscribers don't fire spuriously.

/** The computed active field, or null while empty / errored. */
export function selectComputed(state: Pick<SimulationState, "field">): FieldArray | null {
  return state.field.kind === "ready" ? state.field.computed : null;
}

/** The active field's finite extent, or null while empty / errored / all-NaN. */
export function selectDataRange(state: Pick<SimulationState, "field">): DataRange | null {
  return state.field.kind === "ready" ? state.field.dataRange : null;
}

/** The selected layer, or null when nothing is selected (or the id no longer resolves). The single
 *  reader of the selected-layer chain — UI panels select through this rather than re-deriving it. */
export function selectActiveLayer(
  state: Pick<SimulationState, "layers" | "selectedLayerId">,
): Layer | null {
  if (state.selectedLayerId === null) return null;
  return state.layers.find((layer) => layer.id === state.selectedLayerId) ?? null;
}

/** The ColormapBinding bound to the selected layer, or null when none is selected/bound. */
export function selectActiveBinding(
  state: Pick<SimulationState, "layers" | "selectedLayerId" | "colormapBindings">,
): ColormapBinding | null {
  const bindingId = selectActiveLayer(state)?.colormapBindingId ?? null;
  return bindingId === null ? null : (state.colormapBindings[bindingId] ?? null);
}

/** The distinct ColormapBindings referenced by *visible* layers, in draw order (first reference
 *  wins). The colorbar's content model (DESIGN §UI): shared bindings collapse to one entry, hidden
 *  layers contribute nothing. Fresh array per call — subscribe with a shallow equalityFn. */
export function selectVisibleBindings(
  state: Pick<SimulationState, "layers" | "colormapBindings">,
): readonly ColormapBinding[] {
  const out: ColormapBinding[] = [];
  for (const layer of state.layers) {
    if (!layer.visible || layer.colormapBindingId === null) continue;
    const binding = state.colormapBindings[layer.colormapBindingId];
    if (binding !== undefined && !out.includes(binding)) out.push(binding);
  }
  return out;
}

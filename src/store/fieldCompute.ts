import { computeField } from "@compute";
import { finiteRange } from "@reductions";
import { fullRangeWindow, type WindowLevel } from "@schema/colormap.ts";
import type { LayerKind } from "@schema/layers.ts";
import { errorMessage } from "@schema/log.ts";
import type { FieldName } from "@schema/types.ts";
import * as colormapOps from "./intents/colormap.ts";
import * as layerOps from "./intents/layers.ts";
import { isTracingLayer } from "./layerKinds.ts";
import type { FieldState, SceneIds, SimulationState, SliceContext } from "./state.ts";
import { createSupersedingTask } from "./supersedingTask.ts";

// The active-field compute pass: run the dispatcher on the current dataset + field, then commit the
// result together with the scene it implies — the first compute seeds one layer + binding, later ones
// re-point the affected bindings at the new value scale.

export const EMPTY_FIELD: FieldState = { kind: "empty" };

// Window when a field has no finite samples (all-NaN) — a unit window so the binding stays valid.
export const FALLBACK_WINDOW: WindowLevel = { center: 0, width: 1 };

// The kind of the auto-seeded first layer: `volume` makes the camera visibly live on the synthetic
// field. The only change-point until a kind toggle lands.
const DEFAULT_LAYER_KIND: LayerKind = "volume";

type Rebind = "selected" | "activeField";

export type Recompute = (rebind?: Rebind, signal?: AbortSignal) => Promise<void>;

export interface RecomputeHost extends SliceContext {
  readonly ids: SceneIds;
  // Fired after a commit when field-line layers exist — they follow the vector family behind the
  // displayed scalar, and a dataset switch lands here too. Total: never rejects.
  readonly retrace: () => Promise<void>;
}

// The scene a fresh compute implies: on the first one, auto-seed a layer + binding so the field
// selector and colormap panel drive something from the start; afterwards, re-point the affected
// bindings at the new field and full range, keeping their colormap and scale (the user's color
// choices outlive a field change). `rebind` says how far that reaches — a field switch moves only
// the layer that followed the selector, a dataset switch every layer on the active field, because
// the new run can span a different order of magnitude (flux-rope |B| ~1 vs dipole |B| ~1e4 nT) and
// a stale window paints the whole volume saturated. Pure: state in, state out.
function sceneForField(
  state: Pick<SimulationState, "layers" | "selectedLayerId" | "colormapBindings">,
  activeField: FieldName,
  window: WindowLevel,
  rebind: Rebind,
  ids: SceneIds,
): Pick<SimulationState, "layers" | "selectedLayerId" | "colormapBindings"> {
  let { layers, selectedLayerId, colormapBindings } = state;
  if (layers.length === 0) {
    const bindingId = ids.nextBindingId();
    colormapBindings = colormapOps.upsertBinding(
      colormapBindings,
      colormapOps.makeDefaultBinding(bindingId, activeField, window),
    );
    const layer = layerOps.makeDefaultLayer(ids.nextLayerId(), activeField, DEFAULT_LAYER_KIND);
    layers = layerOps.addLayer(layers, { ...layer, colormapBindingId: bindingId });
    return { layers, selectedLayerId: layers[0]?.id ?? null, colormapBindings };
  }
  const rebound =
    rebind === "activeField"
      ? layers.filter((layer) => layer.field === activeField)
      : layers.filter((layer) => layer.id === selectedLayerId);
  for (const layer of rebound) {
    if (layer.colormapBindingId === null) continue;
    colormapBindings = colormapOps.retargetBinding(
      colormapBindings,
      layer.colormapBindingId,
      activeField,
      window,
    );
  }
  return { layers, selectedLayerId, colormapBindings };
}

export function createRecompute(host: RecomputeHost): Recompute {
  const { get, set, ids, retrace } = host;
  return createSupersedingTask<[Rebind?, AbortSignal?]>(
    async (run, rebind = "selected", signal) => {
      const { dataset, activeField } = get();
      if (dataset === null) {
        // Leave `layers`/`colormapBindings`/`selectedLayerId` untouched — a transient empty/error
        // state shouldn't tear down the layer + binding the field selector targets.
        set({ field: EMPTY_FIELD });
        return;
      }
      const computeSignal =
        signal === undefined ? run.signal : AbortSignal.any([signal, run.signal]);
      try {
        const computed = await computeField(activeField, dataset, computeSignal);
        if (!run.isCurrent()) return; // superseded mid-compute — drop the stale result
        // A fresh quantity has a fresh value scale — reset the bound window to its full range.
        const dataRange = finiteRange(computed.data);
        const window = dataRange ? fullRangeWindow(dataRange) : FALLBACK_WINDOW;
        const scene = sceneForField(get(), activeField, window, rebind, ids);
        set({ field: { kind: "ready", computed, dataRange }, ...scene });
        if (scene.layers.some(isTracingLayer)) void retrace();
      } catch (error) {
        if (!run.isCurrent()) return; // superseded — don't clobber with a stale error
        if (signal?.aborted) return; // the caller withdrew — leave the state as it was
        set({
          field: { kind: "error", message: errorMessage(error) },
        });
      }
    },
  );
}

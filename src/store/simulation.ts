import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import { createBindingsSlice } from "./bindingsSlice.ts";
import { createCameraSlice } from "./cameraSlice.ts";
import { createDataSlice } from "./dataSlice.ts";
import { createRecompute } from "./fieldCompute.ts";
import { createRetrace } from "./fieldTrace.ts";
import { createLayersSlice } from "./layersSlice.ts";
import { createOverlaySlice } from "./overlaySlice.ts";
import { createPickerSlice } from "./pickerSlice.ts";
import { createSceneIds, type SimulationState, type SliceContext } from "./state.ts";

export {
  selectActiveBinding,
  selectActiveLayer,
  selectComputed,
  selectDataRange,
  selectVisibleBindings,
} from "./selectors.ts";
export type { DataRange, SimulationState, TraceNotice } from "./state.ts";

// The simulation store: ONE zustand store (subscribers read dataset + layers + camera off a single
// object, and pypic-parity favors a single "simulation" value) composed from per-concern slices —
// data, layers, bindings, camera, picker, overlay — each owning its state + intents in its own file.
// The two async passes that span slices (the field compute and the field-line retrace) are
// superseding tasks the slices are handed; UI dispatches intents, the app subscribes and forwards to
// the render worker (the store never touches `render` — the DAG forbids it).

// Inferred from the factory so the `subscribeWithSelector` overload (selector + listener)
// survives — a plain StoreApi<SimulationState> annotation would erase it.
export type SimulationStore = ReturnType<typeof createSimulationStore>;

export function createSimulationStore() {
  return createStore<SimulationState>()(
    subscribeWithSelector((set, get) => {
      const context: SliceContext = { set, get };
      const ids = createSceneIds();
      const retrace = createRetrace(context);
      const recompute = createRecompute({ ...context, ids, retrace });
      return {
        ...createDataSlice({ ...context, recompute }),
        ...createLayersSlice({ ...context, ids, retrace }),
        ...createBindingsSlice(context),
        ...createCameraSlice(context),
        ...createPickerSlice(context),
        ...createOverlaySlice(context),
      };
    }),
  );
}

import { rejectionLogger } from "@schema/log.ts";
import { isFieldLayer, type SimulationStore } from "@store";
import type { DatasetEntry } from "./datasets.ts";

// The dataset dropdown's effect (app-only glue): the store records `datasetId`, and the app rebuilds
// the dataset here because store and ui cannot reach `data`. Seeds it on the main thread for an
// instant frame, resets the look to the dataset's default color scale, and re-opens the stream onto
// the new handle. Inert when no catalog was wired.

export interface DatasetSwitchOptions {
  readonly store: SimulationStore;
  readonly catalog?: ReadonlyMap<string, DatasetEntry>;
  // Withdraws a seed still in flight when the app is torn down mid-switch.
  readonly signal: AbortSignal;
  // A no-op when there is no stream (a single fixed dataset).
  readonly reopen: (entry: DatasetEntry) => void;
}

export function installDatasetSwitch(options: DatasetSwitchOptions): () => void {
  const { store, catalog, signal, reopen } = options;
  return store.subscribe(
    (state) => state.datasetId,
    (id) => {
      const entry = catalog?.get(id);
      if (entry === undefined) return;
      // setDataset re-seeds asynchronously; the scale and the stream follow once that lands.
      void store
        .getState()
        .setDataset(entry.makeDataset(), signal)
        .then(() => {
          applyDefaultScale(store, entry);
          reopen(entry);
        })
        .catch(rejectionLogger("app", "dataset switch failed"));
    },
  );
}

// Every field-drawing layer, not just the selected one — a field-lines layer is selected by its own
// add, and its binding only tints a line color, so scoping the scale to the selection can leave the
// volume linear (all-black on the dipole). setBindingScale identity-skips, so shared bindings cost
// nothing.
function applyDefaultScale(store: SimulationStore, entry: DatasetEntry): void {
  const state = store.getState();
  for (const layer of state.layers) {
    if (!isFieldLayer(layer) || layer.colormapBindingId === null) continue;
    state.setBindingScale(layer.colormapBindingId, entry.defaultScale);
  }
}

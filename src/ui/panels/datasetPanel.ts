import { DATASET_CATALOG } from "@schema/datasets.ts";
import type { SimulationStore } from "@store";
import { bindControl } from "../binding/index.ts";
import { createPane, type Disposer, type SelectOption } from "../controls/index.ts";

// The wired dataset selector: dispatches `selectDataset` on change (the app rebuilds the dataset on the
// main thread + re-opens the stream onto the new source) and reflects an external switch back into the
// control. Labels come from the schema catalog — the only thing the UI needs (it can't reach `data`).

const OPTIONS: SelectOption<string>[] = DATASET_CATALOG.map((d) => ({
  value: d.id,
  label: d.label,
}));

export function installDatasetPanel(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Dataset" });
  const folder = pane.addFolder({ title: "Source" });

  const select = bindControl(folder, {
    kind: "select",
    label: "Dataset",
    value: store.getState().datasetId,
    options: OPTIONS,
    onChange: (id) => store.getState().selectDataset(id),
  });

  const unsubscribe = store.subscribe(
    (s) => s.datasetId,
    (id) => select.set(id),
  );

  return () => {
    unsubscribe();
    pane.dispose();
  };
}

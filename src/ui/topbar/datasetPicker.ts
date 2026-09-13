import { DATASET_CATALOG } from "@schema/datasets.ts";
import type { SimulationStore } from "@store";
import { makeEl } from "../controls/dom.ts";
import { createPopover } from "../controls/index.ts";
import { datasetLabel } from "./info.ts";
import { makePickerButton, makeTopBarCaret } from "./parts.ts";

// The top bar's dataset dropdown. The button label prefers the loaded dataset's run name
// (attrs.run / simulation_toml, via datasetLabel's chain) over the static catalog entry, so it
// reads as what the data calls itself rather than what the menu called it.

export interface TopBarPicker {
  readonly element: HTMLButtonElement;
  // Re-read the label from the store (the id changed, or the run metadata landed after it).
  syncLabel(): void;
  // Re-render the open list against current state.
  refresh(): void;
  close(): void;
  dispose(): void;
}

export function installDatasetPicker(
  doc: Document,
  store: SimulationStore,
  onOpen: () => void,
): TopBarPicker {
  const element = makePickerButton(doc, "dataset", "webpic-topbar_dataset", "Dataset");
  const label = makeEl(doc, "span", "webpic-topbar_label");
  const syncLabel = (): void => {
    const state = store.getState();
    label.textContent = datasetLabel(state.datasetId, state.dataset?.metadata);
  };
  syncLabel();
  element.append(label, makeTopBarCaret(doc));

  const items = DATASET_CATALOG.map((d) => ({ value: d.id, label: d.label }));
  const popover = createPopover<{ value: string; label: string }>({
    anchor: element,
    shouldDismissOnOutside: false,
    onOpen,
    getItems: () => items,
    getSelected: () => store.getState().datasetId,
    onSelect: (id) => store.getState().selectDataset(id),
    renderRow: (rowDoc, item) => {
      const span = makeEl(rowDoc, "span", "webpic-popover_text");
      span.textContent = item.label;
      return span;
    },
  });

  return {
    element,
    syncLabel,
    refresh: () => popover.refresh(),
    close: () => popover.close(),
    dispose: () => popover.dispose(),
  };
}

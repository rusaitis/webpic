import type { FieldName } from "@schema/types.ts";
import type { SimulationStore } from "@store";
import { makeEl } from "../controls/dom.ts";
import { createPopover } from "../controls/index.ts";
import type { TopBarPicker } from "./datasetPicker.ts";
import { fieldButtonLabel, fieldMetaRows, orderedFieldNames } from "./info.ts";
import { makePickerButton, makeTopBarCaret } from "./parts.ts";

// The top bar's "content" dropdown: the dataset's available fields, each row carrying its canonical
// name and unit under the long name, so the menu doubles as the field's metadata readout.

export function installFieldPicker(
  doc: Document,
  store: SimulationStore,
  onOpen: () => void,
): TopBarPicker {
  const element = makePickerButton(doc, "field", "webpic-topbar_field", "Dataset contents");
  const label = makeEl(doc, "span", "webpic-topbar_label");
  const syncLabel = (): void => {
    label.textContent = fieldButtonLabel(store.getState().activeField);
  };
  syncLabel();
  element.append(label, makeTopBarCaret(doc));

  const renderRow = (rowDoc: Document, name: FieldName): HTMLElement => {
    const wrap = makeEl(rowDoc, "div", "webpic-popover_field");
    const title = makeEl(rowDoc, "span", "webpic-popover_text");
    title.textContent = fieldButtonLabel(name);
    const meta = makeEl(rowDoc, "span", "webpic-popover_meta");
    const unit = fieldMetaRows(name).find((r) => r.label === "Unit")?.value;
    meta.textContent = unit && unit !== "—" ? `${name} · ${unit}` : name;
    wrap.append(title, meta);
    return wrap;
  };

  const popover = createPopover<{ value: FieldName }>({
    anchor: element,
    className: "is-fields",
    shouldDismissOnOutside: false,
    onOpen,
    getItems: () =>
      orderedFieldNames(store.getState().availableFields, store.getState().activeField).map(
        (name) => ({ value: name }),
      ),
    getSelected: () => store.getState().activeField,
    onSelect: (name) => void store.getState().selectField(name),
    renderRow: (rowDoc, item) => renderRow(rowDoc, item.value),
  });

  return {
    element,
    syncLabel,
    refresh: () => popover.refresh(),
    close: () => popover.close(),
    dispose: () => popover.dispose(),
  };
}

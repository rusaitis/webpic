import type { FieldName } from "@schema/types.ts";
import type { SimulationStore } from "@store";
import { bindControl, fieldLabel } from "../binding/index.ts";
import { createPane, type Disposer, type SelectOption } from "../controls/index.ts";

// The wired field selector: reads the store's computed `availableFields`, dispatches
// `selectField` on change, and reflects external selections (and dataset switches) back
// into the control. Labels resolve through `fieldLabel` (loud on an unknown canonical name).

function buildOptions(
  available: readonly FieldName[],
  active: FieldName,
): SelectOption<FieldName>[] {
  const names = available.includes(active) ? available : [active, ...available];
  return names.map((name) => ({ value: name, label: fieldLabel(name) }));
}

export function installFieldPanel(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Field" });
  const folder = pane.addFolder({ title: "Active field" });

  const { activeField, availableFields } = store.getState();
  const select = bindControl(folder, {
    kind: "select",
    label: "Quantity",
    value: activeField,
    options: buildOptions(availableFields, activeField),
    onChange: (name) => store.getState().selectField(name),
  });

  // A dataset switch swaps the computable fields; rebuild options, then re-assert the
  // active field as the authoritative value.
  const unsubFields = store.subscribe(
    (s) => s.availableFields,
    (available) => {
      const { activeField: active } = store.getState();
      select.setOptions(buildOptions(available, active));
      select.set(active);
    },
  );
  // Mirror a selectField dispatched from elsewhere.
  const unsubActive = store.subscribe(
    (s) => s.activeField,
    (name) => select.set(name),
  );

  return () => {
    unsubActive();
    unsubFields();
    pane.dispose();
  };
}

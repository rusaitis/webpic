import { FIELD_REGISTRY } from "@schema/registry.ts";
import type { FieldName } from "@schema/types.ts";
import type { SimulationStore } from "@store";
import { createPane, type Disposer, type SelectOption } from "../controls/index.ts";

// The wired field selector: reads the store's computed `availableFields`, dispatches
// `selectField` on change, and reflects external selections back into the control.

// Display label from the registry; falls back to the raw key (validation already happened
// at load — a missing label here is a display concern, not a boundary check).
function labelFor(name: FieldName): string {
  return FIELD_REGISTRY[name]?.longName ?? name;
}

function buildOptions(
  available: readonly FieldName[],
  active: FieldName,
): SelectOption<FieldName>[] {
  const names = available.includes(active) ? available : [active, ...available];
  return names.map((name) => ({ value: name, label: labelFor(name) }));
}

export function installFieldPanel(host: HTMLElement, store: SimulationStore): Disposer {
  const pane = createPane({ parent: host, title: "Field" });
  const folder = pane.addFolder({ title: "Active field" });

  const { activeField, availableFields } = store.getState();
  const select = folder.addSelect<FieldName>({
    label: "Quantity",
    value: activeField,
    options: buildOptions(availableFields, activeField),
    onChange: (name) => store.getState().selectField(name),
  });

  // Options are fixed for the dataset loaded at install (a dataset switch rebuilds the
  // panel); here we only mirror selectField dispatched from elsewhere.
  const unsubscribe = store.subscribe(
    (s) => s.activeField,
    (name) => select.set(name),
  );

  return () => {
    unsubscribe();
    pane.dispose();
  };
}

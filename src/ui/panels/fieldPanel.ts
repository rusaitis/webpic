import { fieldInfo } from "@schema/registry.ts";
import type { FieldName } from "@schema/types.ts";
import type { SimulationStore } from "@store";
import { createPane, type Disposer, type SelectChoice } from "../controls/index.ts";
import { createSubscriptions } from "../subscriptions.ts";
import { orderedFieldNames } from "../topBarInfo.ts";

// The wired field selector: reads the store's computed `availableFields`, dispatches
// `selectField` on change, and reflects external selections (and dataset switches) back
// into the control. Labels come from the field registry, which throws on an unknown
// canonical name (pypic's KeyError rule) rather than rendering a mystery option.

function buildOptions(
  available: readonly FieldName[],
  active: FieldName,
): SelectChoice<FieldName>[] {
  return orderedFieldNames(available, active).map((name) => ({
    value: name,
    label: fieldInfo(name).longName,
  }));
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

  const subs = createSubscriptions();
  // A dataset switch swaps the computable fields; rebuild options, then re-assert the
  // active field as the authoritative value.
  subs.on(
    store,
    (s) => s.availableFields,
    (available) => {
      const { activeField: active } = store.getState();
      select.setOptions(buildOptions(available, active));
      select.set(active);
    },
  );
  // Mirror a selectField dispatched from elsewhere.
  subs.on(
    store,
    (s) => s.activeField,
    (name) => select.set(name),
  );

  return () => {
    subs.dispose();
    pane.dispose();
  };
}

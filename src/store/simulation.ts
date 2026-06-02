import { computableFields, computeField } from "@compute";
import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import type { FieldName } from "@schema/types.ts";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

// The simulation store: holds the loaded dataset + active field, and recomputes the
// derived field whenever either changes. UI dispatches `setDataset`/`selectField`; the
// app subscribes to `computed` and forwards it to the render worker (the store never
// touches `render` — the DAG forbids it).

const DEFAULT_FIELD: FieldName = "|B|";

export type SimulationStatus = "empty" | "ready" | "error";

export interface SimulationState {
  readonly dataset: FieldDataset | null;
  readonly activeField: FieldName;
  // Recipes computable from the current dataset — the UI's field-selector options
  // (the UI can't reach `compute` directly, so the store derives them on load).
  readonly availableFields: readonly FieldName[];
  readonly computed: FieldArray | null;
  readonly status: SimulationStatus;
  readonly error: string | null;
  setDataset(dataset: FieldDataset): void;
  selectField(name: FieldName): void;
}

// Inferred from the factory so the `subscribeWithSelector` overload (selector + listener)
// survives — a plain StoreApi<SimulationState> annotation would erase it.
export type SimulationStore = ReturnType<typeof createSimulationStore>;

export function createSimulationStore() {
  return createStore<SimulationState>()(
    subscribeWithSelector((set, get) => {
      const recompute = (): void => {
        const { dataset, activeField } = get();
        if (dataset === null) {
          set({ computed: null, status: "empty", error: null });
          return;
        }
        try {
          set({ computed: computeField(activeField, dataset), status: "ready", error: null });
        } catch (err) {
          set({
            computed: null,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      return {
        dataset: null,
        activeField: DEFAULT_FIELD,
        availableFields: [],
        computed: null,
        status: "empty",
        error: null,
        setDataset(dataset) {
          set({ dataset, availableFields: computableFields(dataset) });
          recompute();
        },
        selectField(name) {
          if (name === get().activeField) return; // recompute yields a fresh array — skip the no-op re-render
          set({ activeField: name });
          recompute();
        },
      };
    }),
  );
}

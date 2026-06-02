import { computableFields, computeField } from "@compute";
import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import type { FieldName, FloatArray } from "@schema/types.ts";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

// The simulation store: holds the loaded dataset + active field, and recomputes the
// derived field whenever either changes. UI dispatches `setDataset`/`selectField`; the
// app subscribes to `computed` and forwards it to the render worker (the store never
// touches `render` — the DAG forbids it).

const DEFAULT_FIELD: FieldName = "|B|";

export type SimulationStatus = "empty" | "ready" | "error";

// Full finite extent of the active field — the slider track bounds.
export interface DataRange {
  readonly min: number;
  readonly max: number;
}

// Value→color window in the canonical {center, width} form (no separate min/max). Restated, not
// shared, with the render-side WindowLevel (messages.ts / normalization.ts): the ui→store→render
// DAG forbids store importing render. The M2.4 ColormapBinding reifies this per field.
export interface WindowLevel {
  readonly center: number;
  readonly width: number;
}

export interface SimulationState {
  readonly dataset: FieldDataset | null;
  readonly activeField: FieldName;
  // Recipes computable from the current dataset — the UI's field-selector options
  // (the UI can't reach `compute` directly, so the store derives them on load).
  readonly availableFields: readonly FieldName[];
  readonly computed: FieldArray | null;
  // The active field's finite extent (slider bounds) and the current value→color window.
  readonly dataRange: DataRange | null;
  readonly windowLevel: WindowLevel | null;
  readonly status: SimulationStatus;
  readonly error: string | null;
  setDataset(dataset: FieldDataset): void;
  selectField(name: FieldName): void;
  setWindowLevel(center: number, width: number): void;
}

// Finite-only min/max in one pass (mirrors volumeTexture.ts; the store can't import `render`,
// and `reductions` isn't in store's allowed imports). A constant field is widened by 1 so the
// default window has a finite width; no finite samples → null.
function finiteRange(data: FloatArray): DataRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === undefined || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) return null;
  if (min === max) return { min, max: max + 1 };
  return { min, max };
}

function fullRangeWindow(range: DataRange): WindowLevel {
  return { center: (range.min + range.max) / 2, width: range.max - range.min };
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
          set({ computed: null, status: "empty", error: null, dataRange: null, windowLevel: null });
          return;
        }
        try {
          const computed = computeField(activeField, dataset);
          // Reset the window to the new field's full range — a fresh quantity has a fresh
          // value scale. M2.4's ColormapBinding will persist per-field windows instead.
          const dataRange = finiteRange(computed.data);
          const windowLevel = dataRange ? fullRangeWindow(dataRange) : null;
          set({ computed, status: "ready", error: null, dataRange, windowLevel });
        } catch (err) {
          set({
            computed: null,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            dataRange: null,
            windowLevel: null,
          });
        }
      };

      return {
        dataset: null,
        activeField: DEFAULT_FIELD,
        availableFields: [],
        computed: null,
        dataRange: null,
        windowLevel: null,
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
        setWindowLevel(center, width) {
          set({ windowLevel: { center, width } });
        },
      };
    }),
  );
}

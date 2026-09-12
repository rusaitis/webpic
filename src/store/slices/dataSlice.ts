import { computableFields } from "@compute";
import { worldHalfExtentForGrid } from "@containers/grid.ts";
import { DEFAULT_DATASET_ID } from "@schema/datasets.ts";
import { UNIT_BOX_HALF_EXTENT } from "@schema/math.ts";
import type { FieldName } from "@schema/types.ts";
import { EMPTY_FIELD, type Recompute } from "../fieldCompute.ts";
import { rerakeStaleSeeds } from "../layers.ts";
import type { DataSlice, SliceContext } from "../state.ts";

// The loaded dataset, the active field and its computed value, and the time cursor.

const DEFAULT_FIELD: FieldName = "|B|";

export interface DataSliceHost extends SliceContext {
  readonly recompute: Recompute;
}

// Element-wise step-domain equality, for identity-skipping a no-op setAvailableSteps.
function sameSteps(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Closest member of a domain (ties → the lower index), to keep the cursor valid when the
// available-step domain changes under it. An empty domain leaves the step unchanged.
function nearestStep(step: number, steps: readonly number[]): number {
  let best = step;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const s of steps) {
    const d = Math.abs(step - s);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

export function createDataSlice({ get, set, recompute }: DataSliceHost): DataSlice {
  return {
    dataset: null,
    datasetId: DEFAULT_DATASET_ID,
    worldHalfExtent: UNIT_BOX_HALF_EXTENT,
    activeField: DEFAULT_FIELD,
    availableFields: [],
    field: EMPTY_FIELD,
    currentStep: 0,
    availableSteps: [],
    setDataset(dataset, signal) {
      // The cursor tracks the loaded step; a direct/synthetic load (no reader listing) still needs a
      // valid 1-element domain, while a reader-populated one (setAvailableSteps) stays.
      const { availableSteps, layers } = get();
      set({
        layers: rerakeStaleSeeds(layers, dataset.grid),
        dataset,
        worldHalfExtent: worldHalfExtentForGrid(dataset.grid),
        availableFields: computableFields(dataset),
        currentStep: dataset.step,
        ...(availableSteps.length === 0 ? { availableSteps: [dataset.step] } : {}),
      });
      // A new run's values live on a new scale — rebind every layer on the active field, not just
      // the selected one. Resolves once the seed lands, so callers may await.
      return recompute("activeField", signal);
    },
    selectDataset(id) {
      if (id === get().datasetId) return; // unchanged → no fire (the app reacts to a real switch)
      set({ datasetId: id });
    },
    selectField(name, signal) {
      if (name === get().activeField) return Promise.resolve(); // no-op — skip the re-render
      // The selected layer follows the field selector — re-point it so its `field` stays honest (the
      // spread preserves the union member's kind-specific keys).
      const { selectedLayerId, layers } = get();
      const repointed =
        selectedLayerId !== null
          ? layers.map((layer) =>
              layer.id === selectedLayerId ? { ...layer, field: name } : layer,
            )
          : layers;
      set({ activeField: name, ...(repointed !== layers ? { layers: repointed } : {}) });
      return recompute("selected", signal); // resolves once the seed lands — callers may await
    },
    recomputeField() {
      return recompute();
    },
    setStep(step) {
      const { currentStep, availableSteps } = get();
      if (step === currentStep) return; // unchanged → no fire
      if (!availableSteps.includes(step)) return; // outside the domain → ignore (controls emit only valid steps)
      set({ currentStep: step });
    },
    setAvailableSteps(steps) {
      const { availableSteps, currentStep } = get();
      if (sameSteps(availableSteps, steps)) return; // identical domain → no fire
      const snapped = nearestStep(currentStep, steps); // keep the cursor inside the new domain
      set({
        availableSteps: [...steps], // own a copy — external mutation can't corrupt the cursor domain
        ...(snapped !== currentStep ? { currentStep: snapped } : {}),
      });
    },
  };
}

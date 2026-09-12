import type { FieldDataset } from "@containers/field_dataset.ts";
import {
  type DataHandle,
  DEFAULT_SYNTHETIC_STEPS,
  dipoleHandle,
  dipoleStep,
  syntheticHandle,
  syntheticStep,
} from "@data";
import type { ColorScale } from "@schema/colormap.ts";

// The id → factory map behind the dataset dropdown (the schema `DATASET_CATALOG` holds the labels). Each
// entry knows how to seed the main-thread step-0 dataset (instant frame) + the stream handle the data
// worker re-opens, plus the color scale that reads best for it. App-only: it imports `data`, which the
// store/ui can't. `n` is the flux rope's `?n=` resolution; the dipole's grid is fixed.

// Scaffold: a deterministic in-memory B field so the app renders a real |B| volume with no data
// source wired. It's step 0 of the synthetic multi-step flux rope (data/readers/synthetic.ts), so
// the main-thread seed here and the worker's streamed step 0 are bit-identical (no flash on
// scrub-back to 0). `n` is the per-axis resolution (n³ cells); the default is the small render
// scaffold, while a larger `n` (e.g. 256) feeds the 256³ raymarch gate / profiling.
export function createSyntheticDataset(n = 32): FieldDataset {
  return syntheticStep(n, 0, 1); // step 0 (phase 0): no drift, unit amplitude — the static rope
}

export interface DatasetEntry {
  readonly makeDataset: () => FieldDataset;
  readonly streamSource: DataHandle;
  readonly defaultScale: ColorScale;
}

export function datasetCatalog(n: number): ReadonlyMap<string, DatasetEntry> {
  return new Map<string, DatasetEntry>([
    [
      "fluxrope",
      {
        makeDataset: () => createSyntheticDataset(n),
        streamSource: syntheticHandle(n, DEFAULT_SYNTHETIC_STEPS),
        defaultScale: "linear",
      },
    ],
    [
      "dipole",
      {
        // A static Earth dipole — non-cubic bounds, |B| spanning orders of magnitude between the
        // inner cutoff and the box edge. symlog over the plain log: the zeroed interior puts the
        // window's low edge at 0, where log has no bottom and every real value crowds the top of the
        // ramp; symlog's linear waist near zero keeps the falloff readable. One timestep, so the scrub
        // collapses to a single step on switch.
        makeDataset: () => dipoleStep(),
        streamSource: dipoleHandle(),
        defaultScale: "symlog",
      },
    ],
  ]);
}

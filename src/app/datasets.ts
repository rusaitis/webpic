import type { FieldDataset } from "@containers/field_dataset.ts";
import {
  type DataHandle,
  DEFAULT_SYNTHETIC_STEPS,
  dipoleHandle,
  dipoleStep,
  syntheticHandle,
} from "@data";
import type { ColorScale } from "@schema/colormap.ts";
import { createSyntheticDataset } from "./syntheticDataset.ts";

// The id → factory map behind the dataset dropdown (the schema `DATASET_CATALOG` holds the labels). Each
// entry knows how to seed the main-thread step-0 dataset (instant frame) + the stream handle the data
// worker re-opens, plus the color scale that reads best for it. App-only: it imports `data`, which the
// store/ui can't. `n` is the flux rope's `?n=` resolution; the dipole's grid is fixed.

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

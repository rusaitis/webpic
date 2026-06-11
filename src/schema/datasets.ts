// The selectable built-in datasets — pure id+label descriptors, the single list the dataset dropdown
// and the app's factory map both key off. The app (`app/datasets.ts`) maps each id to its generator +
// stream handle; the UI panel reads only the labels here (it can't reach `data`). Adding a dataset is
// one entry here + one in the app factory map.

export interface DatasetDescriptor {
  readonly id: string;
  readonly label: string;
}

export const DATASET_CATALOG: readonly DatasetDescriptor[] = [
  { id: "fluxrope", label: "Flux rope" },
  { id: "dipole", label: "Dipole" },
];

// The boot dataset — the synthetic flux rope (matches the store's `datasetId` seed).
export const DEFAULT_DATASET_ID = "fluxrope";

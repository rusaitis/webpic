// The selectable built-in datasets — id+label descriptors the dataset dropdown and app/datasets.ts
// (id → generator + stream handle) both key off. Adding one is an entry here + one in the app map.

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

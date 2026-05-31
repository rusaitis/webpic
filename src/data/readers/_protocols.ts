import type { FieldDataset } from "@containers/field_dataset.ts";
import type { FieldName } from "@schema/types.ts";

// Stackable reader protocols (mirrors pypic.readers). Readers implement whichever
// subset they support; structural typing, no inheritance. The confidence probe that
// ranks readers belongs to the registry (M1.2 _registry.ts), not the reader — so a
// reader stays protocol-shaped and registration carries the probe.

// Format-agnostic source locator. A plain serializable value (it lives in the store),
// so zarrita/HDF5 store objects never leak into the protocol layer — each reader builds
// its own backend from the handle.
export type DataHandle =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "opfs"; readonly path: string };

export interface ReadTimestepOptions {
  /** Restrict the read to these canonical fields; omit to read every available field. */
  readonly fields?: readonly FieldName[];
  /** Cancels the read; honored between per-field reads and passed through to the store. */
  readonly signal?: AbortSignal;
}

export interface SimulationReader {
  readonly id: string;
  readTimestep(
    handle: DataHandle,
    step: number,
    options?: ReadTimestepOptions,
  ): Promise<FieldDataset>;
  availableTimesteps(handle: DataHandle): Promise<number[]>;
}

export interface FieldListingReader {
  availableFields(handle: DataHandle, step: number): Promise<FieldName[]>;
  /** Canonical name → on-disk name, or null for fields the reader synthesizes. */
  availableFieldsMapping(handle: DataHandle, step: number): Promise<Record<string, string | null>>;
}

// Registry-side dispatch (registerReader/openSimulation) lives in M1.2's _registry.ts;
// the probe type is defined here so readers can export a confidence function now.
export type ConfidenceFn = (handle: DataHandle) => Promise<number>;

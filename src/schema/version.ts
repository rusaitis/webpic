// Single source of truth for the persisted-artifact schema version: OPFS caches, exported Zarr and
// saved themes each carry this tag, and the codegen refuses a pypic bundle that does not. pypic v1.x
// is additive-only (breaking → "2.0").
export const SCHEMA_VERSION = "1.0";

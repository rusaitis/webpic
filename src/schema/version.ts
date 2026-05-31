// Single source of truth for the persisted-artifact schema version: OPFS caches,
// exported Zarr, saved themes each carry this tag. pypic v1.x is additive-only
// (breaking → "2.0"). scripts/codegen/bundle.ts's EXPECTED_SCHEMA_VERSION should
// adopt this constant later rather than re-declaring "1.0".
export const SCHEMA_VERSION = "1.0";

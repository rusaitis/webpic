export {
  type Cache,
  type CacheKeyParts,
  type CacheOptions,
  type CacheStore,
  type DataCacheRequest,
  type DataCacheResponse,
  DEFAULT_BUDGET_BYTES,
  installCache,
  MemoryCacheStore,
} from "./cache.ts";
export type {
  ConfidenceFn,
  DataHandle,
  FieldListingReader,
  ReadTimestepOptions,
  SimulationReader,
} from "./readers/_protocols.ts";
// Registry mechanism (reader-free) lives in _registry.ts; built-in reader wiring (imports zarr)
// lives in builtins.ts so importing openSimulation alone tree-shakes zarrita away.
export {
  createReaderRegistry,
  openSimulation,
  type ProbeResult,
  probeReaders,
  type ReaderRegistry,
  registerReader,
} from "./readers/_registry.ts";
export {
  type BuiltinReaderOptions,
  registerBuiltinReaders,
} from "./readers/builtins.ts";
export {
  createSyntheticReader,
  DEFAULT_SYNTHETIC_N,
  DEFAULT_SYNTHETIC_STEPS,
  dipoleHandle,
  dipoleStep,
  registerSyntheticReader,
  syntheticConfidence,
  syntheticHandle,
  syntheticStep,
} from "./readers/synthetic.ts";
export {
  createZarrConfidence,
  createZarrReader,
  type StoreOpener,
  type ZarrReaderOptions,
} from "./readers/zarr.ts";
export type {
  DataStreamRequest,
  DataStreamResponse,
  StreamFieldPayload,
  StreamStepMessage,
} from "./streamMessages.ts";

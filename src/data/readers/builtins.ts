import { type ReaderRegistry, registerReader } from "./_registry.ts";
import { createZarrConfidence, createZarrReader, type StoreOpener } from "./zarr.ts";

// webpic's built-in reader set. This is the ONE module that knows about concrete readers, kept
// apart from _registry.ts on purpose: the registry mechanism stays import-free of zarrita, so a
// consumer who imports only `openSimulation` tree-shakes the reader (and its ~heavy deps) away
// unless they call registerBuiltinReaders here. As HDF5 (h5wasm) and Parquet (hyparquet) land in
// v0.2 they register alongside zarr in this list.

export interface BuiltinReaderOptions {
  // Inject the storage backend (tests pass an in-memory store); defaults to FetchStore via zarr.ts.
  readonly openStore?: StoreOpener;
}

// Register the built-in readers and return a disposer that unregisters exactly what it added.
// Omit `registry` to target the process-wide default (the app/embed calls `registerBuiltinReaders()`
// with no args); pass one for isolated registries in tests.
export function registerBuiltinReaders(
  registry?: ReaderRegistry,
  options: BuiltinReaderOptions = {},
): () => void {
  const register = registry === undefined ? registerReader : registry.register.bind(registry);
  const disposers = [register(createZarrReader(options), createZarrConfidence(options.openStore))];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

import type { ConfidenceFn, DataHandle, SimulationReader } from "./_protocols.ts";

// Confidence-ranked reader dispatch (mirrors pypic.readers._registry.open_simulation). A caller
// hands over a DataHandle and the registry picks the reader without naming a format: every
// registered reader's probe scores the handle, highest wins.
//
// This module is deliberately reader-free — it imports no concrete reader (no zarr.ts). The
// built-in reader wiring lives in builtins.ts so that a consumer importing only `openSimulation`
// tree-shakes zarrita away unless they opt in via registerBuiltinReaders. Keeps the embed surface
// lean (DESIGN §Package shape: data/readers is exported; zarrita is not free).

// One reader's probe outcome — surfaced in the no-match error and available to UI/diagnostics via
// probeReaders(). Mirrors pypic.readers._registry.ProbeResult.
export interface ProbeResult {
  readonly id: string;
  readonly confidence: number; // [0,1]; 0 when the probe threw
  readonly error: string | null; // probe failure message, else null
}

export interface ReaderRegistry {
  // Register a reader with its confidence probe. Returns an identity-safe disposer (the
  // install/register*() => () => void contract). Registering an already-present id overwrites and
  // warns (mirrors pypic), so the disposer only removes the entry it actually installed.
  register(reader: SimulationReader, confidence: ConfidenceFn): () => void;
  // Probe every registered reader in parallel. Never throws — a probe that rejects becomes a
  // confidence-0 ProbeResult carrying its message.
  probe(handle: DataHandle): Promise<ProbeResult[]>;
  // Highest-confidence reader for the handle. Throws an actionable Error when the registry is empty
  // or no reader recognizes the handle.
  open(handle: DataHandle): Promise<SimulationReader>;
  // Registered reader ids, in registration order.
  ids(): string[];
  clear(): void;
}

interface ReaderEntry {
  readonly reader: SimulationReader;
  readonly confidence: ConfidenceFn;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createReaderRegistry(): ReaderRegistry {
  // Insertion-ordered: Map iteration preserves it, which keeps ids()/probe() output stable.
  const entries = new Map<string, ReaderEntry>();

  async function probeEntry(
    id: string,
    entry: ReaderEntry,
    handle: DataHandle,
  ): Promise<ProbeResult> {
    try {
      return { id, confidence: await entry.confidence(handle), error: null };
    } catch (error) {
      return { id, confidence: 0, error: errorMessage(error) };
    }
  }

  // Closure-level so open() doesn't depend on `this` (a destructured open() must still work).
  function probeAll(handle: DataHandle): Promise<ProbeResult[]> {
    return Promise.all([...entries].map(([id, entry]) => probeEntry(id, entry, handle)));
  }

  return {
    register(reader, confidence) {
      const id = reader.id;
      if (entries.has(id)) {
        console.warn(`reader registry: overwriting existing reader "${id}"`);
      }
      const entry: ReaderEntry = { reader, confidence };
      entries.set(id, entry);
      return () => {
        // Identity check: a later register(id) replaces `entry`, so disposing the stale handle
        // must not evict the replacement.
        if (entries.get(id) === entry) entries.delete(id);
      };
    },

    probe(handle) {
      return probeAll(handle);
    },

    async open(handle) {
      if (entries.size === 0) {
        throw new Error(
          "reader registry: no readers registered. Call registerBuiltinReaders() (the app/embed " +
            "default) or registerReader(reader, confidence) before openSimulation().",
        );
      }

      const probes = await probeAll(handle);
      const candidates = probes.filter((p) => p.confidence > 0);

      if (candidates.length === 0) {
        const breakdown = probes
          .map(
            (p) =>
              `  ${p.id}: ${p.confidence.toFixed(2)}${p.error === null ? "" : ` (${p.error})`}`,
          )
          .join("\n");
        throw new Error(
          `reader registry: no reader recognized ${describeHandle(handle)}.\nProbe results:\n${breakdown}`,
        );
      }

      // Highest confidence wins; alphabetical id tiebreak for determinism (mirrors pypic).
      candidates.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
      const winner = candidates[0];
      // candidates is non-empty (checked above), but noUncheckedIndexedAccess can't see that.
      if (winner === undefined) throw new Error("reader registry: unreachable empty candidate set");
      const entry = entries.get(winner.id);
      if (entry === undefined)
        throw new Error(`reader registry: reader "${winner.id}" vanished mid-open`);
      return entry.reader;
    },

    ids() {
      return [...entries.keys()];
    },

    clear() {
      entries.clear();
    },
  };
}

function describeHandle(handle: DataHandle): string {
  return handle.kind === "url" ? `URL "${handle.url}"` : `OPFS path "${handle.path}"`;
}

// Process-wide default registry + free-function facade (mirrors pypic's module-level _REGISTRY).
// Stays reader-free; populate it via registerBuiltinReaders (builtins.ts) or registerReader.
const defaultRegistry = createReaderRegistry();

export function registerReader(reader: SimulationReader, confidence: ConfidenceFn): () => void {
  return defaultRegistry.register(reader, confidence);
}

export function openSimulation(handle: DataHandle): Promise<SimulationReader> {
  return defaultRegistry.open(handle);
}

export function probeReaders(handle: DataHandle): Promise<ProbeResult[]> {
  return defaultRegistry.probe(handle);
}

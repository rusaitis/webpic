import { errorMessage, logWarn } from "@schema/log.ts";
import type { ConfidenceFn, DataHandle, SimulationReader } from "./_protocols.ts";

// Confidence-ranked reader dispatch (mirrors pypic.readers._registry.open_simulation): every
// registered reader's probe scores the DataHandle, highest wins — no format named by the caller.
// Deliberately reader-free (imports no concrete reader); built-in wiring lives in builtins.ts so
// importing `openSimulation` alone tree-shakes zarrita away (DESIGN §Package shape).

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
  // confidence-0 ProbeResult carrying its message (an aborted probe reads as confidence 0 too).
  probe(handle: DataHandle, signal?: AbortSignal): Promise<ProbeResult[]>;
  // Highest-confidence reader for the handle. Throws an actionable Error when the registry is empty
  // or no reader recognizes the handle; rethrows the signal's reason when aborted.
  open(handle: DataHandle, signal?: AbortSignal): Promise<SimulationReader>;
  // Registered reader ids, in registration order.
  ids(): string[];
  clear(): void;
}

interface ReaderEntry {
  readonly reader: SimulationReader;
  readonly confidence: ConfidenceFn;
}

export function createReaderRegistry(): ReaderRegistry {
  // Insertion-ordered: Map iteration preserves it, which keeps ids()/probe() output stable.
  const entries = new Map<string, ReaderEntry>();

  async function probeEntry(
    id: string,
    entry: ReaderEntry,
    handle: DataHandle,
    signal: AbortSignal | undefined,
  ): Promise<ProbeResult> {
    try {
      return { id, confidence: await entry.confidence(handle, signal), error: null };
    } catch (error) {
      return { id, confidence: 0, error: errorMessage(error) };
    }
  }

  // Closure-level so open() doesn't depend on `this` (a destructured open() must still work).
  function probeAll(handle: DataHandle, signal: AbortSignal | undefined): Promise<ProbeResult[]> {
    return Promise.all([...entries].map(([id, entry]) => probeEntry(id, entry, handle, signal)));
  }

  return {
    register(reader, confidence) {
      const id = reader.id;
      if (entries.has(id)) {
        logWarn("readers", `overwriting existing reader "${id}"`);
      }
      const entry: ReaderEntry = { reader, confidence };
      entries.set(id, entry);
      return () => {
        // Identity check: a later register(id) replaces `entry`, so disposing the stale handle
        // must not evict the replacement.
        if (entries.get(id) === entry) entries.delete(id);
      };
    },

    probe(handle, signal) {
      return probeAll(handle, signal);
    },

    async open(handle, signal) {
      if (entries.size === 0) {
        throw new Error(
          "reader registry: no readers registered. Call registerBuiltinReaders() (the app/embed " +
            "default) or registerReader(reader, confidence) before openSimulation().",
        );
      }

      const probes = await probeAll(handle, signal);
      signal?.throwIfAborted(); // every probe read as 0 under abort — surface the abort, not "no reader"
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

      // Highest confidence wins; alphabetical id tiebreak for determinism (mirrors pypic). A reduce
      // over the non-empty list yields a definite winner without an index the checker can't prove.
      const winner = candidates.reduce((best, candidate) =>
        candidate.confidence > best.confidence ||
        (candidate.confidence === best.confidence && candidate.id.localeCompare(best.id) < 0)
          ? candidate
          : best,
      );
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

export function openSimulation(
  handle: DataHandle,
  signal?: AbortSignal,
): Promise<SimulationReader> {
  return defaultRegistry.open(handle, signal);
}

export function probeReaders(handle: DataHandle, signal?: AbortSignal): Promise<ProbeResult[]> {
  return defaultRegistry.probe(handle, signal);
}

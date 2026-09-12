import type { GpuAdapterSummary } from "@gpu";
import { logWarn } from "@schema/log.ts";
import { z } from "zod";
import { BACKEND_IDS, type BackendId } from "./backend.ts";

// STAGED: not installed — field.ts picks backends first-wins until a second dispatcher backend
// (WASM) gives these scores something to rank; see docs/DESIGN.md §Compute dispatcher.
//
// Background backend microbench + calibration cache: warm-start from cached per-adapter scores, else
// seed heuristics so the dispatcher has scores immediately while a background bench refines them.
// `compute` may not import `data`, so the OPFS cache is injected as a structural port. DESIGN §Caching.

export const CALIBRATION_VERSION = "1"; // bump on kernel/bench change → silent invalidation
const CALIBRATION_NAMESPACE = "calibration";

export interface CalibrationScores {
  readonly calibrationVersion: string;
  readonly adapterKey: string;
  /** Throughput in Melem/s (higher = faster). Partial: only `ts` exists currently. */
  readonly throughput: Partial<Record<BackendId, number>>;
}

// Structural subset of @data's Cache (get/put/has) — no @data import. The real Cache
// (which also has delete/dispose) is assignable; calibration only borrows it.
export interface CalibrationCacheKey {
  readonly namespace: string;
  readonly parts: readonly string[];
}
export interface CalibrationCache {
  get(key: CalibrationCacheKey): Promise<Uint8Array | undefined>;
  put(key: CalibrationCacheKey, bytes: Uint8Array): Promise<void>;
  has(key: CalibrationCacheKey): boolean;
}

export interface BenchKernel {
  readonly backend: BackendId;
  /** Run the probe once over `elements`; the return is consumed to defeat DCE. */
  run(elements: number): number | Promise<number>;
}

const ScoresSchema = z.object({
  calibrationVersion: z.string(),
  adapterKey: z.string(),
  // Unknown backend ids and non-positive/NaN/Infinity throughputs are rejected.
  throughput: z.partialRecord(z.enum(BACKEND_IDS), z.number().positive()),
});

function sanitize(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "unknown"
  );
}

// Coarse by design: vendor+architecture only (browsers mask finer GPUAdapterInfo
// fields to limit fingerprinting), but the bucket has stable backend-crossover behavior.
export function adapterKey(adapter: GpuAdapterSummary): string {
  return `${sanitize(adapter.vendor)}/${sanitize(adapter.architecture)}`;
}

function calibrationKey(adapter: GpuAdapterSummary): CalibrationCacheKey {
  return {
    namespace: CALIBRATION_NAMESPACE,
    parts: [adapter.vendor, adapter.architecture, CALIBRATION_VERSION],
  };
}

export function encodeScores(scores: CalibrationScores): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(scores));
}

// Every failure (miss, corrupt bytes, wrong shape, stale version, wrong adapter)
// collapses to undefined = "treat as a cache miss → seed + bench". Never throws.
export function decodeScores(
  raw: Uint8Array | undefined,
  adapter: GpuAdapterSummary,
): CalibrationScores | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return undefined;
  }
  const result = ScoresSchema.safeParse(parsed);
  if (!result.success) return undefined;
  const scores = result.data;
  if (scores.calibrationVersion !== CALIBRATION_VERSION) return undefined; // stale
  if (scores.adapterKey !== adapterKey(adapter)) return undefined; // FNV-collision guard
  return scores;
}

// Hardcoded seed so scores exist the instant calibration installs, before any bench
// completes ("TS backend wins while calibration runs"). webgpu/wasm seeds + the
// `apple && size < 1<<14 → avoid webgpu` dispatcher exception land with those backends.
const SEED_THROUGHPUT: Partial<Record<BackendId, number>> = { ts: 1 };

export function seedHeuristics(adapter: GpuAdapterSummary): CalibrationScores {
  return {
    calibrationVersion: CALIBRATION_VERSION,
    adapterKey: adapterKey(adapter),
    throughput: { ...SEED_THROUGHPUT }, // fresh copy: scores() exposes this mutably
  };
}

// Placeholder probe until the real |B| `ts` backend lands. Times a representative typed-array
// magnitude (sqrt(x²+y²+z²) over three reused Float32Arrays); validates the pipeline end-to-end,
// not yet a dispatch-quality signal.
function syntheticMagnitudeProbe(): BenchKernel {
  let bx = new Float32Array(0);
  let by = new Float32Array(0);
  let bz = new Float32Array(0);
  let out = new Float32Array(0);
  return {
    backend: "ts",
    run(elements) {
      if (out.length !== elements) {
        bx = new Float32Array(elements);
        by = new Float32Array(elements);
        bz = new Float32Array(elements);
        out = new Float32Array(elements);
        for (let i = 0; i < elements; i++) {
          bx[i] = i * 0.5;
          by[i] = i * 0.25;
          bz[i] = i * 0.125;
        }
      }
      let checksum = 0;
      for (let i = 0; i < elements; i++) {
        const x = bx[i] ?? 0;
        const y = by[i] ?? 0;
        const z = bz[i] ?? 0;
        const mag = Math.sqrt(x * x + y * y + z * z);
        out[i] = mag;
        checksum += mag;
      }
      return checksum;
    },
  };
}

const DEFAULT_BENCH_PROBES: readonly BenchKernel[] = [syntheticMagnitudeProbe()];

const DEFAULT_SIZES = [1 << 14, 1 << 18, 1 << 20] as const;

export interface MicrobenchOptions {
  readonly sizes?: readonly number[];
  readonly reps?: number;
  readonly warmup?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly yield?: () => Promise<void>;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function runMicrobench(
  probes: readonly BenchKernel[],
  options: MicrobenchOptions = {},
): Promise<Partial<Record<BackendId, number>>> {
  const sizes = options.sizes ?? DEFAULT_SIZES;
  const reps = options.reps ?? 5;
  const warmup = options.warmup ?? 2;
  const now = options.now ?? (() => performance.now());
  const yieldFn = options.yield ?? defaultYield;
  const signal = options.signal;

  const throughput: Partial<Record<BackendId, number>> = {};
  for (const probe of probes) {
    const perSize: number[] = []; // Melem/s
    for (const elements of sizes) {
      signal?.throwIfAborted();
      for (let w = 0; w < warmup; w++) await probe.run(elements); // discarded: primes alloc + JIT
      const samples: number[] = [];
      for (let r = 0; r < reps; r++) {
        signal?.throwIfAborted();
        const start = now();
        await probe.run(elements);
        const elapsedMs = now() - start;
        if (elapsedMs > 0) samples.push(elements / elapsedMs / 1000); // → Melem/s
        await yieldFn(); // stay background between chunks
      }
      if (samples.length > 0) perSize.push(median(samples));
    }
    if (perSize.length > 0) throughput[probe.backend] = median(perSize);
  }
  return throughput;
}

export interface InstallCalibrationOptions {
  readonly cache: CalibrationCache;
  readonly adapter: GpuAdapterSummary;
  readonly probes?: readonly BenchKernel[];
  readonly signal?: AbortSignal;
  /** Default true: return immediately with heuristics; bench refines in the background. */
  readonly runInBackground?: boolean;
  // Bench tuning forwarded to runMicrobench (defaults there).
  readonly sizes?: readonly number[];
  readonly reps?: number;
  readonly warmup?: number;
  readonly now?: () => number;
  readonly yield?: () => Promise<void>;
  /** Non-throwing error sink for background bench/write-back failures. */
  readonly onError?: (error: unknown) => void;
}

export interface InstalledCalibration {
  /** Synchronous current best: heuristic seed, upgraded to benched scores when ready. */
  scores(): CalibrationScores;
  /** Resolves with the final scores for this install. Never rejects. */
  readonly ready: Promise<CalibrationScores>;
  dispose(): void;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function runBenchAndPersist(
  probes: readonly BenchKernel[],
  adapter: GpuAdapterSummary,
  key: CalibrationCacheKey,
  cache: CalibrationCache,
  options: MicrobenchOptions,
  reportError: (error: unknown) => void,
  onScores: (scores: CalibrationScores) => void,
): Promise<CalibrationScores> {
  const benched = await runMicrobench(probes, options); // may throw AbortError
  const scores: CalibrationScores = {
    calibrationVersion: CALIBRATION_VERSION,
    adapterKey: adapterKey(adapter),
    // Merge over the seed so a backend without a probe keeps its heuristic number.
    throughput: { ...SEED_THROUGHPUT, ...benched },
  };
  onScores(scores); // upgrade in-memory scores before persisting
  try {
    await cache.put(key, encodeScores(scores));
  } catch (error) {
    if (isAbort(error)) throw error;
    reportError(error); // a write-back failure must not discard freshly benched scores
  }
  return scores;
}

export async function installCalibration(
  options: InstallCalibrationOptions,
): Promise<InstalledCalibration> {
  const { cache, adapter } = options;
  const probes = options.probes ?? DEFAULT_BENCH_PROBES;
  const runInBackground = options.runInBackground ?? true;
  const reportError =
    options.onError ??
    ((error: unknown) => logWarn("calibration", "background bench failed", error));

  options.signal?.throwIfAborted();

  // Internal controller so dispose() can cancel an in-flight background bench; composed with the
  // caller's signal via AbortSignal.any so a caller abort still propagates to the bench.
  const disposeController = new AbortController();

  const key = calibrationKey(adapter);
  const cached = decodeScores(await cache.get(key), adapter);
  let current: CalibrationScores = cached ?? seedHeuristics(adapter);

  let ready: Promise<CalibrationScores>;
  if (cached !== undefined) {
    ready = Promise.resolve(cached); // warm start: cached scores valid → skip the bench
  } else {
    const benchOptions: MicrobenchOptions = {
      signal: options.signal
        ? AbortSignal.any([options.signal, disposeController.signal])
        : disposeController.signal,
      ...(options.sizes !== undefined ? { sizes: options.sizes } : {}),
      ...(options.reps !== undefined ? { reps: options.reps } : {}),
      ...(options.warmup !== undefined ? { warmup: options.warmup } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.yield !== undefined ? { yield: options.yield } : {}),
    };
    const raw = runBenchAndPersist(probes, adapter, key, cache, benchOptions, reportError, (s) => {
      current = s;
    });
    // ready never rejects: abort keeps heuristics; other errors are reported and swallowed.
    ready = raw.then(
      (benched) => benched,
      (error: unknown) => {
        if (!isAbort(error)) reportError(error);
        return current;
      },
    );
    if (!runInBackground) await ready;
  }

  return {
    scores: () => current,
    ready,
    dispose() {
      disposeController.abort();
    },
  };
}

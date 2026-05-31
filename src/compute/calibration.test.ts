import type { GpuAdapterSummary } from "@gpu";
import { describe, expect, it, vi } from "vitest";
import {
  adapterKey,
  type BenchKernel,
  CALIBRATION_VERSION,
  type CalibrationCache,
  type CalibrationCacheKey,
  type CalibrationScores,
  decodeScores,
  encodeScores,
  installCalibration,
  runMicrobench,
  seedHeuristics,
} from "./calibration.ts";

function fakeAdapter(vendor = "apple", architecture = "m2"): GpuAdapterSummary {
  return { vendor, architecture, device: "", description: "test adapter" };
}

function fakeCache(): {
  cache: CalibrationCache;
  entries: Map<string, Uint8Array>;
  puts: { key: CalibrationCacheKey; bytes: Uint8Array }[];
} {
  const entries = new Map<string, Uint8Array>();
  const puts: { key: CalibrationCacheKey; bytes: Uint8Array }[] = [];
  const id = (key: CalibrationCacheKey): string => [key.namespace, ...key.parts].join("|");
  return {
    entries,
    puts,
    cache: {
      get: (key) => Promise.resolve(entries.get(id(key))),
      put: (key, bytes) => {
        puts.push({ key, bytes });
        entries.set(id(key), bytes);
        return Promise.resolve();
      },
      has: (key) => entries.has(id(key)),
    },
  };
}

// Each measured rep spends two now() calls (start, end); a +1 step makes every rep
// 1 ms, so throughput = elements / 1 / 1000 = elements/1000 Melem/s — exact + assertable.
function steppingNow(stepMs = 1): () => number {
  let t = 0;
  return () => {
    const value = t;
    t += stepMs;
    return value;
  };
}

const immediateYield = (): Promise<void> => Promise.resolve();

function countingProbe(): { probe: BenchKernel; runs: () => number } {
  let runs = 0;
  return {
    runs: () => runs,
    probe: {
      backend: "ts",
      run: () => {
        runs += 1;
        return 0;
      },
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("score encode/decode", () => {
  it("round-trips through bytes", () => {
    const adapter = fakeAdapter();
    const scores: CalibrationScores = {
      calibrationVersion: CALIBRATION_VERSION,
      adapterKey: adapterKey(adapter),
      throughput: { ts: 3.5 },
    };
    expect(decodeScores(encodeScores(scores), adapter)).toEqual(scores);
  });

  it("treats miss / corrupt bytes / stale version / wrong adapter as undefined", () => {
    const adapter = fakeAdapter();
    expect(decodeScores(undefined, adapter)).toBeUndefined();
    expect(decodeScores(new Uint8Array([0xff, 0xfe]), adapter)).toBeUndefined();

    const stale = encodeScores({
      calibrationVersion: "0",
      adapterKey: adapterKey(adapter),
      throughput: { ts: 5 },
    });
    expect(decodeScores(stale, adapter)).toBeUndefined();

    const wrongAdapter = encodeScores({
      calibrationVersion: CALIBRATION_VERSION,
      adapterKey: "nvidia/ampere",
      throughput: { ts: 5 },
    });
    expect(decodeScores(wrongAdapter, adapter)).toBeUndefined();
  });
});

describe("runMicrobench", () => {
  it("returns median throughput per backend and discards warmup reps", async () => {
    const { probe, runs } = countingProbe();
    const throughput = await runMicrobench([probe], {
      sizes: [1000, 3000],
      reps: 1,
      warmup: 2,
      now: steppingNow(1),
      yield: immediateYield,
    });
    // median([1000/1000, 3000/1000]) = median([1, 3]) = 2.
    expect(throughput.ts).toBe(2);
    // (2 warmup + 1 rep) × 2 sizes — warmup ran but never touched the clock.
    expect(runs()).toBe(6);
  });
});

describe("installCalibration", () => {
  it("warm start uses cached scores and skips the bench", async () => {
    const adapter = fakeAdapter();
    const { cache, puts } = fakeCache();
    await cache.put(
      {
        namespace: "calibration",
        parts: [adapter.vendor, adapter.architecture, CALIBRATION_VERSION],
      },
      encodeScores({
        calibrationVersion: CALIBRATION_VERSION,
        adapterKey: adapterKey(adapter),
        throughput: { ts: 42 },
      }),
    );
    puts.length = 0; // drop the seeding put

    const { probe, runs } = countingProbe();
    const installed = await installCalibration({
      cache,
      adapter,
      probes: [probe],
      runInBackground: false,
    });

    expect(installed.scores().throughput).toEqual({ ts: 42 });
    expect(await installed.ready).toEqual(installed.scores());
    expect(runs()).toBe(0); // bench never constructed
    expect(puts).toHaveLength(0); // no write-back on a hit
  });

  it("cold start (foreground) benches a deterministic throughput and persists it", async () => {
    const adapter = fakeAdapter();
    const { cache, puts } = fakeCache();
    const { probe } = countingProbe();

    const installed = await installCalibration({
      cache,
      adapter,
      probes: [probe],
      runInBackground: false,
      sizes: [1000, 3000],
      reps: 1,
      warmup: 0,
      now: steppingNow(1),
      yield: immediateYield,
    });

    expect(installed.scores().adapterKey).toBe(adapterKey(adapter));
    expect(installed.scores().throughput.ts).toBe(2); // median([1, 3])
    expect(puts).toHaveLength(1);
    const stored = decodeScores(puts[0]?.bytes, adapter);
    expect(stored?.calibrationVersion).toBe(CALIBRATION_VERSION);
    expect(stored?.throughput.ts).toBe(2);
  });

  it("background mode exposes heuristics immediately, benched scores after ready", async () => {
    const adapter = fakeAdapter();
    const { cache } = fakeCache();
    const { probe } = countingProbe();
    const gate = deferred();

    const installed = await installCalibration({
      cache,
      adapter,
      probes: [probe],
      runInBackground: true,
      sizes: [1000],
      reps: 1,
      warmup: 0,
      now: steppingNow(1),
      yield: () => gate.promise,
    });

    expect(installed.scores().throughput).toEqual(seedHeuristics(adapter).throughput); // heuristic
    gate.resolve();
    const final = await installed.ready;
    expect(final.throughput.ts).toBe(1); // 1000/1000
    expect(installed.scores().throughput.ts).toBe(1);
  });

  it("abort during the bench keeps heuristics and writes nothing", async () => {
    const adapter = fakeAdapter();
    const { cache, puts } = fakeCache();
    const controller = new AbortController();
    const probe: BenchKernel = {
      backend: "ts",
      run: () => {
        controller.abort();
        return 0;
      },
    };

    const installed = await installCalibration({
      cache,
      adapter,
      probes: [probe],
      runInBackground: false,
      signal: controller.signal,
      sizes: [100, 200],
      reps: 1,
      warmup: 0,
      now: steppingNow(1),
      yield: immediateYield,
    });

    expect(installed.scores().throughput).toEqual(seedHeuristics(adapter).throughput);
    expect(await installed.ready).toEqual(installed.scores());
    expect(puts).toHaveLength(0);
  });

  it("throws AbortError when the signal is already aborted", async () => {
    const { cache } = fakeCache();
    const error = await installCalibration({
      cache,
      adapter: fakeAdapter(),
      signal: AbortSignal.abort(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("survives a write-back failure: ready resolves to benched scores, onError fires", async () => {
    const adapter = fakeAdapter();
    const failing: CalibrationCache = {
      get: () => Promise.resolve(undefined),
      put: () => Promise.reject(new Error("disk full")),
      has: () => false,
    };
    const onError = vi.fn();
    const { probe } = countingProbe();

    const installed = await installCalibration({
      cache: failing,
      adapter,
      probes: [probe],
      runInBackground: false,
      onError,
      sizes: [1000],
      reps: 1,
      warmup: 0,
      now: steppingNow(1),
      yield: immediateYield,
    });

    const final = await installed.ready;
    expect(final.throughput.ts).toBe(1); // in-memory upgrade survived the put failure
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("dispose() cancels an in-flight background bench", async () => {
    const adapter = fakeAdapter();
    const { cache, puts } = fakeCache();
    const { probe } = countingProbe();
    const gate = deferred();

    const installed = await installCalibration({
      cache,
      adapter,
      probes: [probe],
      runInBackground: true,
      sizes: [1000],
      reps: 2, // a second rep so an abort check fires after the gate releases
      warmup: 0,
      now: steppingNow(1),
      yield: () => gate.promise,
    });

    installed.dispose(); // aborts the internal controller
    gate.resolve();
    expect(await installed.ready).toEqual(installed.scores()); // heuristic
    expect(installed.scores().throughput).toEqual(seedHeuristics(adapter).throughput);
    expect(puts).toHaveLength(0);
  });

  it("a full Cache-shaped object is assignable to the narrow port", () => {
    const full = {
      get: (_key: CalibrationCacheKey): Promise<Uint8Array | undefined> =>
        Promise.resolve(undefined),
      put: (_key: CalibrationCacheKey, _bytes: Uint8Array): Promise<void> => Promise.resolve(),
      has: (_key: CalibrationCacheKey): boolean => false,
      delete: (_key: CalibrationCacheKey): Promise<void> => Promise.resolve(),
      dispose: (): void => {},
    };
    const port: CalibrationCache = full; // compiles ⇒ real @data Cache is assignable
    expect(typeof port.get).toBe("function");
  });
});

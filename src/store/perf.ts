import type { FrameClock } from "@schema/timing.ts";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

export type { FrameClock };

// Render timing + the dev performance HUD state, isolated from the simulation/ui stores so their
// per-frame churn never wakes panel/shell subscribers. The timing panel reads the frame timing
// (the app forwards the worker's frameTiming replies here) and owns the "Measure" toggle; the HUD
// bridge + overlay are dynamic-imported only under dev or ?perf. The `ui` layer reads this and
// dispatches intents; app/perfBridge writes the samples + topology fed from the workers.

/** Per-frame render metrics posted by the render worker (≤5 Hz while the HUD is open). All
 *  wall-clock — `frameWallMs` is NaN on ticks where the throttled GPU sync didn't run, and
 *  `frameIntervalMs` is NaN while the on-demand loop is idle (nothing painting). `computeMs`
 *  is null until a timed compute pass exists (the v0.1 |B| op runs on the TS backend). */
export interface PerfSample {
  readonly cpuEncodeMs: number;
  readonly frameWallMs: number;
  readonly frameIntervalMs: number;
  readonly isContinuous: boolean;
  /** Frame-time governor's render-scale ceiling: 1 unthrottled, 0.85/0.7 under sustained slow frames. */
  readonly governorScale: number;
  readonly computeMs: number | null;
  readonly vramBytes: number;
  readonly vramByKey?: readonly (readonly [string, number])[];
}

export type PerfWorkerRole = "main" | "render" | "data";

/** A row in the logical worker topology. Browsers can't enumerate OS processes, so this is
 *  the app's known thread set: main + render + (optional) data. `heapBytes` is null off-Chrome
 *  (no `performance.memory`); `note` carries a role-specific hint (e.g. the data worker's last
 *  read time) when available. */
export interface PerfWorker {
  readonly role: PerfWorkerRole;
  readonly live: boolean;
  readonly heapBytes: number | null;
  readonly note?: string;
}

/** Longest Long-Animation-Frame and count over the observed window (Chromium-only). */
export interface LoafSummary {
  readonly longestMs: number;
  readonly count: number;
}

/** Main-thread metrics the bridge pumps at their own (low) cadences. */
export interface MainPerfMetrics {
  readonly mainHeapBytes?: number | null;
  readonly pageMemoryBytes?: number | null;
  readonly loaf?: LoafSummary | null;
}

export interface PerfState {
  // The latest GPU frame time + its clock (`null` until the first frame), and the timing
  // panel's explicit "Measure" toggle that drives the worker's continuous-repaint mode.
  readonly frameTimeMs: number | null;
  readonly frameTimeClock: FrameClock | null;
  readonly isMeasuringContinuous: boolean;
  readonly isPerfHudVisible: boolean;
  readonly isPerfDetailOpen: boolean;
  readonly sample: PerfSample | null;
  readonly topology: readonly PerfWorker[];
  readonly mainHeapBytes: number | null;
  readonly pageMemoryBytes: number | null;
  readonly loaf: LoafSummary | null;
  togglePerfHud(): void;
  setPerfHudVisible(visible: boolean): void;
  toggleDetail(): void;
  setSample(sample: PerfSample): void;
  setTopology(topology: readonly PerfWorker[]): void;
  setMainMetrics(metrics: MainPerfMetrics): void;
  setFrameTiming(ms: number, clock: FrameClock): void;
  setMeasuringContinuous(on: boolean): void;
}

// Inferred from the factory so the `subscribeWithSelector` overload survives — mirrors
// createUiStore / createSimulationStore.
export type PerfStore = ReturnType<typeof createPerfStore>;

export function createPerfStore() {
  return createStore<PerfState>()(
    subscribeWithSelector((set, get) => ({
      frameTimeMs: null,
      frameTimeClock: null,
      isMeasuringContinuous: false,
      isPerfHudVisible: false,
      isPerfDetailOpen: false,
      sample: null,
      topology: [],
      mainHeapBytes: null,
      pageMemoryBytes: null,
      loaf: null,
      togglePerfHud() {
        set({ isPerfHudVisible: !get().isPerfHudVisible });
      },
      setPerfHudVisible(visible) {
        if (get().isPerfHudVisible !== visible) set({ isPerfHudVisible: visible });
      },
      toggleDetail() {
        set({ isPerfDetailOpen: !get().isPerfDetailOpen });
      },
      setSample(sample) {
        set({ sample });
      },
      setTopology(topology) {
        set({ topology });
      },
      // Shallow-merge patch: each main-thread metric arrives on its own cadence (heap ~2 Hz,
      // page memory ~0.04 Hz, LoAF on jank), so absent keys must keep their prior value.
      setMainMetrics(metrics) {
        set(metrics);
      },
      setFrameTiming(ms, clock) {
        const { frameTimeMs, frameTimeClock } = get();
        if (frameTimeMs === ms && frameTimeClock === clock) return; // identical sample → no fire
        set({ frameTimeMs: ms, frameTimeClock: clock });
      },
      setMeasuringContinuous(on) {
        if (get().isMeasuringContinuous === on) return;
        set({ isMeasuringContinuous: on });
      },
    })),
  );
}

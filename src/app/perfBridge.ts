import {
  REQUEST_IDS,
  type RenderWorkerRequest,
  type RenderWorkerResponse,
} from "@render/messages.ts";
import type { PerfStore, PerfWorker, UiStore } from "@store";
import { installPerfHud } from "@ui/perfHud.ts";

// The dev perf-HUD subsystem installer (app-only glue). Mounts the HUD overlay, gates the workers'
// per-frame sampling on HUD visibility, runs the main-thread metric pump (heap, whole-page memory,
// Long Animation Frames), and assembles the worker topology from the two workers' self-reports. main
// dynamic-imports this module behind import.meta.env.DEV || ?perf, so the whole feature (HUD + bridge)
// tree-shakes out of the default production bundle.

type RenderPerfSample = Extract<RenderWorkerResponse, { kind: "perfSample" }>;

const PUMP_INTERVAL_MS = 500; // main-heap + topology refresh (~2 Hz)
const PAGE_MEMORY_MIN_MS = 20_000; // measureUserAgentSpecificMemory cadence floor (it's slow + async)
const PAGE_MEMORY_JITTER_MS = 10_000;

export interface PerfBridgeOptions {
  readonly perfStore: PerfStore;
  readonly uiStore: UiStore;
  readonly uiParent: HTMLElement;
  readonly renderWorker: Pick<Worker, "postMessage">;
  /** Drives the data worker's self-report (backed by streamingBridge, or a no-op when no stream). */
  readonly setDataPerfActive: (active: boolean) => void;
  readonly isRenderReady: () => boolean;
  readonly isDataPresent: () => boolean;
}

export interface PerfBridge {
  /** Route a render-worker perfSample into the store (called from the worker message handler). */
  ingestRenderSample(sample: RenderPerfSample): void;
  /** Route a data-worker perfSample into the topology (called from streamingBridge.onPerfSample). */
  ingestDataSample(sample: {
    readonly heapBytes: number | null;
    readonly lastReadMs: number | null;
  }): void;
  dispose(): void;
}

export function installPerf(opts: PerfBridgeOptions): PerfBridge {
  const {
    perfStore,
    uiStore,
    uiParent,
    renderWorker,
    setDataPerfActive,
    isRenderReady,
    isDataPresent,
  } = opts;

  const disposeHud = installPerfHud(uiParent, perfStore, uiStore);

  // Latest per-thread numbers; reassembled into the topology on any update.
  let mainHeapBytes: number | null = null;
  let renderHeapBytes: number | null = null;
  let dataHeapBytes: number | null = null;
  let dataLastReadMs: number | null = null;

  const rebuildTopology = (): void => {
    const topology: PerfWorker[] = [
      { role: "main", live: true, heapBytes: mainHeapBytes },
      { role: "render", live: isRenderReady(), heapBytes: renderHeapBytes },
    ];
    if (isDataPresent()) {
      topology.push({
        role: "data",
        live: true,
        heapBytes: dataHeapBytes,
        ...(dataLastReadMs !== null ? { note: `read ${dataLastReadMs.toFixed(0)} ms` } : {}),
      });
    }
    perfStore.getState().setTopology(topology);
  };

  // performance.memory is Chrome-only and absent from the lib types; read defensively (cheap).
  const readHeapBytes = (): number | null => {
    const memory = (performance as { memory?: { readonly usedJSHeapSize: number } }).memory;
    return memory !== undefined ? memory.usedJSHeapSize : null;
  };

  // Whole-page breakdown — the modern, standardized API. Async + costly (can pause JS tens of ms) and
  // requires cross-origin isolation (the dev/preview server sets COOP/COEP); absent in the default
  // prod build, where the per-thread heaps carry the memory view instead. Sampled rarely.
  const samplePageMemory = (): void => {
    const measure = (
      performance as {
        measureUserAgentSpecificMemory?: () => Promise<{ readonly bytes: number }>;
      }
    ).measureUserAgentSpecificMemory;
    const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    if (typeof measure !== "function" || !isolated) return;
    void measure.call(performance).then(
      (result) => perfStore.getState().setMainMetrics({ pageMemoryBytes: result.bytes }),
      () => {}, // rejects when disallowed — keep the prior value
    );
  };

  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  let loafObserver: PerformanceObserver | undefined;
  let loafLongestMs = 0;
  let loafCount = 0;
  let ticksUntilPageMemory = 0;

  const nextPageMemoryTicks = (): number =>
    Math.round((PAGE_MEMORY_MIN_MS + Math.random() * PAGE_MEMORY_JITTER_MS) / PUMP_INTERVAL_MS);

  const pumpTick = (): void => {
    mainHeapBytes = readHeapBytes();
    perfStore.getState().setMainMetrics({ mainHeapBytes });
    rebuildTopology();
    ticksUntilPageMemory -= 1;
    if (ticksUntilPageMemory <= 0) {
      samplePageMemory();
      ticksUntilPageMemory = nextPageMemoryTicks();
    }
  };

  const startPump = (): void => {
    if (pumpTimer !== undefined) return;
    loafLongestMs = 0;
    loafCount = 0;
    ticksUntilPageMemory = nextPageMemoryTicks();
    // Long Animation Frames — near-zero-overhead main-thread jank signal (Chromium-only).
    const supported =
      typeof PerformanceObserver === "function" &&
      PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame") === true;
    if (supported) {
      loafObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          loafCount += 1;
          if (entry.duration > loafLongestMs) loafLongestMs = entry.duration;
        }
        perfStore
          .getState()
          .setMainMetrics({ loaf: { longestMs: loafLongestMs, count: loafCount } });
      });
      try {
        loafObserver.observe({ type: "long-animation-frame", buffered: true });
      } catch {
        loafObserver = undefined; // unsupported buffered/type combo — degrade silently
      }
    }
    pumpTick();
    samplePageMemory(); // a first whole-page sample on open
    pumpTimer = setInterval(pumpTick, PUMP_INTERVAL_MS);
  };

  const stopPump = (): void => {
    if (pumpTimer !== undefined) {
      clearInterval(pumpTimer);
      pumpTimer = undefined;
    }
    loafObserver?.disconnect();
    loafObserver = undefined;
  };

  const setActive = (active: boolean): void => {
    renderWorker.postMessage({
      kind: "setPerfActive",
      requestId: REQUEST_IDS.perf,
      active,
    } satisfies RenderWorkerRequest);
    setDataPerfActive(active);
    if (active) startPump();
    else stopPump();
  };

  // Apply the current visibility immediately so a toggle landed before this (async-loaded) bridge is
  // honored, then react to changes.
  setActive(perfStore.getState().isPerfHudVisible);
  const unsubVisible = perfStore.subscribe((s) => s.isPerfHudVisible, setActive);

  return {
    ingestRenderSample(sample) {
      perfStore.getState().setSample({
        cpuEncodeMs: sample.cpuEncodeMs,
        frameWallMs: sample.frameWallMs,
        frameIntervalMs: sample.frameIntervalMs,
        isContinuous: sample.isContinuous,
        governorScale: sample.governorScale,
        computeMs: sample.computeMs ?? null,
        vramBytes: sample.vramBytes,
        vramByKey: sample.vramByKey,
      });
      renderHeapBytes = sample.workerHeapBytes;
      rebuildTopology();
    },
    ingestDataSample(sample) {
      dataHeapBytes = sample.heapBytes;
      dataLastReadMs = sample.lastReadMs;
      rebuildTopology();
    },
    dispose() {
      unsubVisible();
      setActive(false); // stop the workers' sampling + the pump if torn down while visible
      disposeHud();
    },
  };
}

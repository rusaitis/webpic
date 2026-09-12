import type { FrameClock, PerfStore } from "@store";
import {
  type ControlHandle,
  createPane,
  type Disposer,
  type NoteHandle,
} from "../controls/index.ts";
import { createSubscriptions } from "../subscriptions.ts";

// The frame-timing panel: a rolling GPU frame-time readout + the "Measure" toggle that drives the
// worker's continuous-repaint mode for sustained timing. It's the instrument for the 8 ms raymarch
// budget. It dispatches perf-store intents only (ui → store; never render); the app forwards the
// worker's frameTiming replies into the perf store.

// Rolling window over the most recent valid samples — long enough to smooth per-frame jitter, short
// enough to track a workload change (camera move, dataset swap) within a fraction of a second.
const WINDOW = 30;
const GATE_MS = 8; // the per-frame raymarch budget this panel measures against

// Mean of the finite samples (NaN-skip); NaN when there are none yet. Pure — unit-tested.
export function rollingMean(values: readonly number[]): number {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    sum += v;
    count++;
  }
  return count === 0 ? Number.NaN : sum / count;
}

// Honest clock labels: timestamp-query is GPU-only; wall-clock includes JS/queue latency and
// over-reads the gate, so it's never presented as the same number.
function clockLabel(clock: FrameClock | null): string {
  if (clock === "timestamp") return "GPU · timestamp-query";
  if (clock === "wallclock") return "≈ wall-clock · incl. JS/queue";
  return "awaiting first frame";
}

function formatReadout(meanMs: number, clock: FrameClock | null): string {
  if (!Number.isFinite(meanMs)) return `— ms · ${clockLabel(clock)}`;
  const verdict = meanMs <= GATE_MS ? "≤" : ">";
  return `${meanMs.toFixed(2)} ms ${verdict} ${GATE_MS} ms gate · ${clockLabel(clock)}`;
}

export function installTimingPanel(host: HTMLElement, store: PerfStore): Disposer {
  const pane = createPane({ parent: host, title: "Frame timing" });
  const folder = pane.addFolder({ title: "GPU frame time" });

  const samples: number[] = []; // ring of the last WINDOW valid frame times
  const readout: NoteHandle = folder.addNote(formatReadout(Number.NaN, null));

  const refresh = (): void => {
    const { frameTimeMs, frameTimeClock } = store.getState();
    if (frameTimeMs !== null && Number.isFinite(frameTimeMs)) {
      samples.push(frameTimeMs);
      if (samples.length > WINDOW) samples.shift();
    }
    readout.element.textContent = formatReadout(rollingMean(samples), frameTimeClock);
  };

  const measure: ControlHandle<boolean> = folder.addCheckbox({
    label: "Measure (continuous)",
    value: store.getState().isMeasuringContinuous,
    onChange: (on) => store.getState().setMeasuringContinuous(on),
  });

  const subs = createSubscriptions();
  subs.on(store, (s) => s.frameTimeMs, refresh);
  // Reflect external toggles without echoing onChange (set()-in / callbacks-out contract).
  subs.on(
    store,
    (s) => s.isMeasuringContinuous,
    (on) => measure.set(on),
  );

  return () => {
    subs.dispose();
    store.getState().setMeasuringContinuous(false); // never strand continuous mode on teardown
    pane.dispose(); // cascades to the measure checkbox + readout note
  };
}

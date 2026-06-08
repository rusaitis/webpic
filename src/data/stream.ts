// The time-series ring buffer + prefetch orchestrator (M2.10a) — pure, no DOM/worker globals, so it
// unit-tests in Node against a fake `readStep`. It owns "which steps are decoded, what to prefetch,
// what to evict, what to abort" — the heart of "scrub without stalls" (DESIGN §Time-series).
//
// Lifecycle of a decoded value (DESIGN §518 "hold until upload, transfer on upload, re-read on
// scrub-back"): the cursor step is handed to `onDisplay` and *consumed* (the worker transfers its
// buffer, which detaches — the ring can't reuse it), while prefetched neighbours stay cached so a
// ±1 scrub displays instantly. Scrubbing back to a consumed/evicted step simply re-reads it.
//
// Neighbours are computed in domain-INDEX space over the sorted `steps` array (mirrors the M2.9
// index-based scrubber), so a sparse/non-contiguous domain prefetches real adjacent steps. The dumb
// ±1 policy lives here; M2.11's EWMA predictor swaps only `wantedSteps`.

type Entry<T> =
  | { state: "loading"; controller: AbortController; display: boolean }
  | { state: "ready"; value: T };

export interface StreamRingOptions<T> {
  /** The sorted timestep domain (step values); neighbours are its index-adjacent entries. */
  readonly steps: readonly number[];
  /** Decode one step. Must reject with AbortError (or resolve) when `signal` aborts. */
  readonly readStep: (step: number, signal: AbortSignal) => Promise<T>;
  /** The cursor step is decoded and ready to show — the value is consumed (transfer it). */
  readonly onDisplay: (step: number, value: T) => void;
  /** A non-abort read failure (aborted reads are expected and swallowed). */
  readonly onError?: (step: number, error: unknown) => void;
  /** Max cached (decoded-but-not-displayed) values; farthest-from-cursor evicted first. Default 5. */
  readonly capacity?: number;
  /** Prefetch radius in domain-index space (default 1 → the dumb ±1). */
  readonly prefetchRadius?: number;
}

export interface StreamRing {
  /** Move the cursor: display its step (instantly if cached), prefetch neighbours, abort the rest. */
  setCursor(step: number): void;
  /** Decoded-and-cached steps (not yet displayed) — introspection for tests. */
  resident(): number[];
  /** Steps with an in-flight read — introspection for tests. */
  pending(): number[];
  dispose(): void;
}

export function createStreamRing<T>(options: StreamRingOptions<T>): StreamRing {
  const capacity = options.capacity ?? 5;
  const radius = options.prefetchRadius ?? 1;
  const steps = options.steps;
  const indexOf = (step: number): number => steps.indexOf(step);

  const entries = new Map<number, Entry<T>>();
  let cursor: number | null = null;
  let disposed = false;

  // The cursor's index-adjacent neighbours (incl. the cursor), clamped to the domain.
  function wantedSteps(center: number): number[] {
    const ci = indexOf(center);
    if (ci < 0) return [];
    const out: number[] = [];
    for (let k = -radius; k <= radius; k++) {
      const step = steps[ci + k];
      if (step !== undefined) out.push(step);
    }
    return out;
  }

  // Drop cached (ready) values beyond capacity, farthest-from-cursor first. Loading entries aren't
  // counted — they're bounded by the wanted set and aborted when they leave it.
  function evict(): void {
    if (cursor === null) return;
    const ci = indexOf(cursor);
    const ready = [...entries].filter(([, e]) => e.state === "ready").map(([step]) => step);
    if (ready.length <= capacity) return;
    ready.sort((a, b) => Math.abs(indexOf(b) - ci) - Math.abs(indexOf(a) - ci));
    for (let i = 0; i < ready.length - capacity; i++) {
      const step = ready[i];
      if (step !== undefined) entries.delete(step);
    }
  }

  function onRead(step: number, value: T, controller: AbortController): void {
    if (disposed) return;
    const entry = entries.get(step);
    // Stale: aborted + deleted, or replaced by a newer read — drop silently.
    if (entry === undefined || entry.state !== "loading" || entry.controller !== controller) return;
    if (controller.signal.aborted) {
      entries.delete(step);
      return;
    }
    if (entry.display && step === cursor) {
      entries.delete(step); // consumed — the worker transfers the buffer (it detaches)
      options.onDisplay(step, value);
    } else {
      entries.set(step, { state: "ready", value }); // prefetched neighbour (or the cursor moved on)
    }
    evict();
  }

  function onReadError(step: number, error: unknown, controller: AbortController): void {
    if (disposed) return;
    const entry = entries.get(step);
    if (entry === undefined || entry.state !== "loading" || entry.controller !== controller) return;
    entries.delete(step);
    if (controller.signal.aborted) return; // expected — scrubbed past
    options.onError?.(step, error);
  }

  // Start a read unless the step is already loading/ready (no duplicate concurrent reads). A pending
  // load that's now the cursor is upgraded to display-on-complete.
  function startRead(step: number, display: boolean): void {
    const existing = entries.get(step);
    if (existing !== undefined) {
      if (existing.state === "loading" && display) existing.display = true;
      return;
    }
    const controller = new AbortController();
    entries.set(step, { state: "loading", controller, display });
    options.readStep(step, controller.signal).then(
      (value) => onRead(step, value, controller),
      (error: unknown) => onReadError(step, error, controller),
    );
  }

  function setCursor(step: number): void {
    if (disposed) return;
    cursor = step;
    const entry = entries.get(step);
    if (entry?.state === "ready") {
      entries.delete(step); // cached neighbour became the cursor → display instantly + consume
      options.onDisplay(step, entry.value);
    } else if (entry?.state === "loading") {
      entry.display = true; // display when it lands (if still the cursor)
    } else {
      startRead(step, true);
    }
    const wanted = wantedSteps(step);
    for (const neighbour of wanted) {
      if (neighbour !== step && !entries.has(neighbour)) startRead(neighbour, false);
    }
    // Abort in-flight reads the cursor has scrubbed past (outside the wanted window).
    const wantedSet = new Set(wanted);
    for (const [s, e] of [...entries]) {
      if (e.state === "loading" && !wantedSet.has(s)) {
        e.controller.abort();
        entries.delete(s);
      }
    }
    evict();
  }

  return {
    setCursor,
    resident() {
      return [...entries].filter(([, e]) => e.state === "ready").map(([step]) => step);
    },
    pending() {
      return [...entries].filter(([, e]) => e.state === "loading").map(([step]) => step);
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        if (entry.state === "loading") entry.controller.abort();
      }
      entries.clear();
    },
  };
}

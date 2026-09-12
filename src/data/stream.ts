// The time-series ring buffer + prefetch orchestrator — pure, no DOM/worker globals, so it unit-tests
// in Node against a fake `readStep`. It owns which steps are decoded, prefetched, evicted and aborted
// (DESIGN §Time-series). The cursor step is handed to `onDisplay` and *consumed* — the worker
// transfers its buffer, which detaches — while prefetched neighbours stay cached, so a ±1 scrub is
// instant and a scrub back to a consumed step simply re-reads it. Neighbours live in domain-INDEX
// space over the sorted `steps`, so a sparse domain still prefetches real adjacent steps.

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
  /** Override the symmetric ±radius with a direction-biased wanted set (data/prefetch.ts). */
  readonly plan?: (center: number) => readonly number[];
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
  const plan = options.plan;
  const steps = options.steps;
  // The domain is fixed for the ring's life (a changed domain builds a new ring), so index lookups
  // memoize to O(1) — otherwise evict()'s sort comparator calls indexOf O(k log k) times per move.
  const stepIndex = new Map<number, number>();
  let i = 0;
  for (const step of steps) stepIndex.set(step, i++);
  const indexOf = (step: number): number => stepIndex.get(step) ?? -1;

  const entries = new Map<number, Entry<T>>();
  let cursor: number | null = null;
  let disposed = false;

  // The cursor's index-adjacent neighbours (incl. the cursor), clamped to the domain.
  function wantedSteps(center: number): number[] {
    const ci = indexOf(center);
    if (ci < 0) return [];
    // An injected predictor (data/prefetch.ts) biases the window by scrub direction; trust no list it
    // returns — keep only in-domain steps. Default: the symmetric ±radius.
    if (plan !== undefined) return plan(center).filter((step) => stepIndex.has(step));
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
    // Abort in-flight reads the cursor has scrubbed past (outside the wanted window). The cursor is
    // always retained — an injected `plan` that omits it must not abort the live display read.
    const wantedSet = new Set(wanted);
    wantedSet.add(step);
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

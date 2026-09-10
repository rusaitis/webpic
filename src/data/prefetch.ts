// STAGED: dormant — no caller passes `plan` to createStreamRing yet; activates with the first slow real
// reader once ring capacity is raised to ≥ MAX_COUNT + 2 (data.worker.ts owns that wiring).
//
// Directional scrub predictor — a stateful, pure twin of the ring's symmetric ±1 prefetch
// (data/stream.ts). It watches the cursor's recent motion and biases the prefetch window in the
// direction of travel, so a fast directional scrub reads *ahead* instead of spending a symmetric
// budget on steps already behind it. DESIGN §Time-series playback: "direction from EWMA of recent
// step deltas (window=8, α=0.7); magnitude → prefetch count (1–5); 250 ms debounce on flips;
// stationary → ±1."
//
// Built dormant (profile-then-tune): the data worker still drives the ring's default ±1. Activate by
// passing `predictor.plan` to createStreamRing AND raising `capacity` to ≥ MAX_COUNT+2 (else evict()
// drops the farthest-ahead prefetch first) — once a slow real reader is shown to stall.
//
// Pure: no DOM/worker globals; time is injected via `observe(step, nowMs)`, so it unit-tests and
// fuzzes deterministically in Node. Works in domain-INDEX space over the sorted `steps`, like the
// ring, so a sparse/non-contiguous domain biases toward real adjacent steps.

import { clamp } from "@schema/math.ts";

const EWMA_ALPHA = 0.7; // direction smoothing — effective memory ~1/(1−α) ≈ 3 samples
const SPEED_WINDOW = 8; // |index-delta| samples averaged into the prefetch count
const MIN_COUNT = 1;
const MAX_COUNT = 5; // count ∈ [1,5]; the ring's capacity must be ≥ MAX_COUNT+2 when this drives it
const DIRECTION_EPS = 0.15; // |velocity| deadzone — jitter below this reads as stationary
const DEBOUNCE_MS = 250; // a direction *reversal* must persist this long before the window flips
const STATIONARY_MS = 2000; // no motion this long → drop the bias, fall back to symmetric ±1

export interface ScrubPredictorOptions {
  /** The sorted timestep domain — same array the ring holds; bias is computed in its index space. */
  readonly steps: readonly number[];
}

export interface ScrubPredictor {
  /** Record a cursor move at wall-clock `nowMs` (injected — keeps the module pure + testable). */
  observe(step: number, nowMs: number): void;
  /** The direction-biased prefetch set (step values, in-domain, deduped, always incl. `center`). */
  plan(center: number): readonly number[];
  /** Drop all motion state (dataset switch / reopen). */
  reset(): void;
}

export function createScrubPredictor(options: ScrubPredictorOptions): ScrubPredictor {
  const steps = options.steps;
  const stepIndex = new Map<number, number>();
  let i = 0;
  for (const step of steps) stepIndex.set(step, i++);
  const indexOf = (step: number): number => stepIndex.get(step) ?? -1;

  let velocity = 0; // EWMA of signed index-deltas → direction
  const recentSpeeds: number[] = []; // last ≤ SPEED_WINDOW |index-deltas| → count
  let committedDirection = 0; // −1 | 0 | +1 — the debounced direction plan() biases toward
  let pendingDirection = 0; // a candidate reversal awaiting DEBOUNCE_MS
  let pendingSinceMs = 0;
  let lastIndex = -1;
  let lastObserveMs = Number.NEGATIVE_INFINITY;

  function reset(): void {
    velocity = 0;
    recentSpeeds.length = 0;
    committedDirection = 0;
    pendingDirection = 0;
    pendingSinceMs = 0;
    lastIndex = -1;
    lastObserveMs = Number.NEGATIVE_INFINITY;
  }

  function observe(step: number, nowMs: number): void {
    const ci = indexOf(step);
    if (ci < 0) return; // out-of-domain — the ring already guards the cursor; ignore here
    // A long idle gap means the user stopped scrubbing: forget the old motion, restart clean.
    if (nowMs - lastObserveMs >= STATIONARY_MS) reset();
    if (lastIndex < 0) {
      lastIndex = ci;
      lastObserveMs = nowMs;
      return; // first sample only establishes the origin — no delta yet
    }
    const delta = ci - lastIndex;
    velocity = EWMA_ALPHA * delta + (1 - EWMA_ALPHA) * velocity;
    recentSpeeds.push(Math.abs(delta));
    if (recentSpeeds.length > SPEED_WINDOW) recentSpeeds.shift();

    const direction = velocity > DIRECTION_EPS ? 1 : velocity < -DIRECTION_EPS ? -1 : 0;
    if (direction === 0 || direction === committedDirection) {
      pendingDirection = 0; // motion agrees (or stalled) — nothing to debounce
    } else if (committedDirection === 0) {
      committedDirection = direction; // stationary → moving isn't a "flip"; commit at once
      pendingDirection = 0;
    } else if (direction !== pendingDirection) {
      pendingDirection = direction; // a fresh reversal — start its debounce clock
      pendingSinceMs = nowMs;
    } else if (nowMs - pendingSinceMs >= DEBOUNCE_MS) {
      committedDirection = direction; // the reversal held long enough — flip the window
      pendingDirection = 0;
    }
    lastIndex = ci;
    lastObserveMs = nowMs;
  }

  function prefetchCount(): number {
    if (recentSpeeds.length === 0) return MIN_COUNT;
    let sum = 0;
    for (const speed of recentSpeeds) sum += speed;
    return clamp(Math.round(sum / recentSpeeds.length), MIN_COUNT, MAX_COUNT);
  }

  // Collect domain index `k` (if in range) into `out` as a step value, deduped via `seen`.
  function pushIndex(out: number[], seen: Set<number>, k: number): void {
    const step = steps[k];
    if (step !== undefined && !seen.has(step)) {
      seen.add(step);
      out.push(step);
    }
  }

  function plan(center: number): readonly number[] {
    const ci = indexOf(center);
    if (ci < 0) return [];
    const out: number[] = [];
    const seen = new Set<number>();
    pushIndex(out, seen, ci); // the cursor is always wanted (the ring displays it)
    if (committedDirection === 0) {
      pushIndex(out, seen, ci - 1); // unsure → symmetric ±1, exactly the dumb policy
      pushIndex(out, seen, ci + 1);
      return out;
    }
    const dir = committedDirection;
    const count = prefetchCount();
    for (let k = 1; k <= count; k++) pushIndex(out, seen, ci + dir * k); // bias ahead of travel
    pushIndex(out, seen, ci - dir); // one trailing step — cheap single-backtrack insurance
    return out;
  }

  return { observe, plan, reset };
}

// A closed-loop frame-time governor — the "thermal governor". The open-loop quality tier
// (interactionQuality) reacts to INPUT ("am I gesturing? → go coarse"); this reacts to the measured
// OUTCOME: when sustained frame intervals blow the budget — the signature of a GPU thermal throttle,
// or a genuinely heavy view — it lowers a render-scale ceiling to claw back headroom, then restores
// it as frames recover. The render loop feeds it consecutive-painted-frame intervals; the quality
// controller multiplies scale() into renderScale. Pure + Node-testable: feed intervals, read scale().
//
// Hysteresis is the whole game. A dead-band between the trip and recover thresholds plus asymmetric
// dwell (drop fast, restore slow) means a frame rate parked near the setpoint holds its tier instead
// of hunting — and since tier changes land seconds apart, the render-target realloc a render-scale
// change costs is rare. It's really a *frame-time* governor; thermal throttle is just the loudest
// cause it exists to ride out.

// Render-scale ceilings, coolest first. Lower = cheaper + softer; a single sample steps at most one.
export const GOVERNOR_SCALES: readonly number[] = [1, 0.85, 0.7];

// Defend 30 fps — NOT 60. A full-res volume march is already ~30 fps by design, so a 60 fps budget
// would peg the governor permanently throttled. This is the floor we refuse to sink below.
const BUDGET_MS = 1000 / 30;
// Trip above 1.25× budget (≈24 fps): too slow. Recover below 0.8× (≈37 fps): real headroom. Between
// them is the dead-band — neither edge fires, so a rate sitting at ~30 fps neither trips nor recovers.
const TRIP_MS = BUDGET_MS * 1.25;
const RECOVER_MS = BUDGET_MS * 0.8;
// Sustained breach before acting, in accumulated frame time. Recover far slower than we trip, so a
// brief cool spell can't yank quality back up into the next throttle.
const TRIP_DWELL_MS = 1500;
const RECOVER_DWELL_MS = 4000;
// EWMA of the interval — smooths vsync-bucket jitter (16.7 / 33.3 / 50 …) into a trend, and lets a
// lone slow frame decay out instead of tripping a tier.
const EWMA_ALPHA = 0.1;
// Longer than this is an idle gap (the on-demand loop paused and resumed), not a slow frame — drop it
// and forget the trend, so the first frame back doesn't read as one catastrophic stall.
const IDLE_GAP_MS = 250;

export interface FrameGovernor {
  /** Feed one consecutive-painted-frame interval (ms). Returns true iff the scale tier changed. */
  sample(intervalMs: number): boolean;
  /** The current render-scale ceiling ∈ {@link GOVERNOR_SCALES} (1 = cool, unthrottled). */
  scale(): number;
}

export function createFrameGovernor(): FrameGovernor {
  let tier = 0; // index into GOVERNOR_SCALES; 0 = full
  let ewmaMs = Number.NaN; // NaN until the first real frame seeds it
  let breachAccumMs = 0; // frame time accumulated above TRIP_MS
  let recoverAccumMs = 0; // frame time accumulated below RECOVER_MS

  return {
    sample(intervalMs) {
      if (!(intervalMs > 0) || intervalMs > IDLE_GAP_MS) {
        // An idle gap or a nonsense delta carries no thermal signal — drop it and reset the trend.
        ewmaMs = Number.NaN;
        breachAccumMs = 0;
        recoverAccumMs = 0;
        return false;
      }
      ewmaMs = Number.isNaN(ewmaMs) ? intervalMs : ewmaMs + EWMA_ALPHA * (intervalMs - ewmaMs);
      if (ewmaMs > TRIP_MS) {
        recoverAccumMs = 0;
        breachAccumMs += intervalMs;
        if (breachAccumMs >= TRIP_DWELL_MS && tier < GOVERNOR_SCALES.length - 1) {
          tier += 1;
          breachAccumMs = 0;
          return true;
        }
      } else if (ewmaMs < RECOVER_MS) {
        breachAccumMs = 0;
        recoverAccumMs += intervalMs;
        if (recoverAccumMs >= RECOVER_DWELL_MS && tier > 0) {
          tier -= 1;
          recoverAccumMs = 0;
          return true;
        }
      } else {
        // Dead-band: parked at the setpoint — bleed both timers so brushing an edge can't creep
        // toward a tier change. This is the no-hunting guarantee.
        breachAccumMs = 0;
        recoverAccumMs = 0;
      }
      return false;
    },
    scale() {
      return GOVERNOR_SCALES[tier] ?? 1;
    },
  };
}

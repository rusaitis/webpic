import { bootstrap, createSyntheticDataset, DEFAULT_SYNTHETIC_STEPS, syntheticHandle } from "@app";

// `?n=<size>` overrides the scaffold volume's per-axis resolution — a dev/profiling affordance for
// feeding the raymarcher the M2 256³ gate workload (see scripts/profile-raymarch.ts). Absent or
// invalid → the small default scaffold. Bounded so a fat-fingered query can't OOM the tab.
const requested = Number.parseInt(new URLSearchParams(location.search).get("n") ?? "", 10);
const n = Number.isInteger(requested) && requested >= 2 && requested <= 512 ? requested : 32;

// Seed step 0 on the main thread (instant first frame) and stream the rest from the synthetic
// multi-step flux rope over the data worker (M2.10a) — scrub the time control to see it evolve.
bootstrap({
  dataset: createSyntheticDataset(n),
  streamSource: syntheticHandle(n, DEFAULT_SYNTHETIC_STEPS),
});

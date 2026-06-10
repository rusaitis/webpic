import { bootstrap, createSyntheticDataset, DEFAULT_SYNTHETIC_STEPS, syntheticHandle } from "@app";
import { parsePoseParam } from "@store";

// `?n=<size>` overrides the scaffold volume's per-axis resolution — a dev/profiling affordance for
// feeding the raymarcher the M2 256³ gate workload (see scripts/profile-raymarch.ts). Absent or
// invalid → the small default scaffold. Bounded so a fat-fingered query can't OOM the tab.
const params = new URLSearchParams(location.search);
const requested = Number.parseInt(params.get("n") ?? "", 10);
const n = Number.isInteger(requested) && requested >= 2 && requested <= 512 ? requested : 32;

// `?pose=` (+ `&proj=ortho`) restores a shared camera view (the readout's copy-link affordance);
// invalid → default.
const pose = parsePoseParam(params.get("pose") ?? "");
const orthographic = params.get("proj") === "ortho";

// Seed step 0 on the main thread (instant first frame) and stream the rest from the synthetic
// multi-step flux rope over the data worker (M2.10a) — scrub the time control to see it evolve.
// `?debugScene` opts into the RGB test triangle as the empty-layers frame (renderer-alive sanity).
bootstrap({
  dataset: createSyntheticDataset(n),
  streamSource: syntheticHandle(n, DEFAULT_SYNTHETIC_STEPS),
  ...(params.has("debugScene") ? { debugScene: true } : {}),
  ...(pose !== null ? { initialPose: pose } : {}),
  ...(orthographic ? { initialProjection: "orthographic" as const } : {}),
});

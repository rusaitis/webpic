import { bootstrap, createSyntheticDataset } from "@app";

// `?n=<size>` overrides the scaffold volume's per-axis resolution — a dev/profiling affordance for
// feeding the raymarcher the M2 256³ gate workload (see scripts/profile-raymarch.ts). Absent or
// invalid → the small default scaffold. Bounded so a fat-fingered query can't OOM the tab.
const requested = Number.parseInt(new URLSearchParams(location.search).get("n") ?? "", 10);
const size = Number.isInteger(requested) && requested >= 2 && requested <= 512 ? requested : null;

bootstrap(size !== null ? { dataset: createSyntheticDataset(size) } : {});

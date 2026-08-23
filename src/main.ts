import { bootstrap, datasetCatalog, requireWebGpu } from "@app";
import { DEFAULT_THEME_NAME, loadBundledThemes } from "@data/theme/loader.ts";
import { readThemePref } from "@data/theme/prefs.ts";
import { DEFAULT_DATASET_ID } from "@schema/datasets.ts";
import { parsePoseParam } from "@store";

// Bail before spawning workers or touching OPFS: without `navigator.gpu` nothing downstream can
// succeed, and a silent empty canvas is the worst way to say so.
if (!requireWebGpu()) {
  throw new Error("WebGPU unavailable");
}

// `?n=<size>` overrides the scaffold volume's per-axis resolution — a dev/profiling affordance for
// feeding the raymarcher the 256³ gate workload (see scripts/profile-raymarch.ts). Absent or
// invalid → the small default scaffold. Bounded so a fat-fingered query can't OOM the tab.
const params = new URLSearchParams(location.search);
const requested = Number.parseInt(params.get("n") ?? "", 10);
const n = Number.isInteger(requested) && requested >= 2 && requested <= 512 ? requested : 32;

// `?pose=` (+ `&proj=ortho`) restores a shared camera view (the readout's copy-link affordance);
// invalid → default.
const pose = parsePoseParam(params.get("pose") ?? "");
const orthographic = params.get("proj") === "ortho";

// The selectable datasets (the Dataset dropdown); the default (flux rope) seeds the boot dataset +
// stream. Seed step 0 on the main thread (instant first frame) and stream the rest over the data
// worker — scrub the time control to see it evolve; switch the dropdown to the dipole.
// `?debugScene` opts into the RGB test triangle as the empty-layers frame (renderer-alive sanity).
const catalog = datasetCatalog(n);
const initial = catalog.get(DEFAULT_DATASET_ID);
if (initial === undefined) throw new Error(`unknown default dataset: ${DEFAULT_DATASET_ID}`);

// Boot theme: the persisted OPFS pref when it names a bundled theme, else the default. Awaited
// (one small OPFS read, ~ms) so the first paint carries the user's theme — no default-theme flash.
const themes = loadBundledThemes();
const savedTheme = await readThemePref();
const themeName = savedTheme !== null && themes.has(savedTheme) ? savedTheme : DEFAULT_THEME_NAME;
const theme = themes.get(themeName);

bootstrap({
  dataset: initial.makeDataset(),
  streamSource: initial.streamSource,
  datasetCatalog: catalog,
  ...(theme !== undefined ? { theme } : {}),
  themeCatalog: themes,
  // Dev performance HUD (Shift+P): always in dev builds, opt-in via ?perf in production.
  perf: import.meta.env.DEV || params.has("perf"),
  ...(params.has("debugScene") ? { debugScene: true } : {}),
  ...(params.has("fieldlines") ? { fieldlines: true } : {}),
  ...(pose !== null ? { initialPose: pose } : {}),
  ...(orthographic ? { initialProjection: "orthographic" as const } : {}),
});

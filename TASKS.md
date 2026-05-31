# webpic — TASKS

Check off `[ ]` → `[x]` as steps land. The `/tasks` skill summarizes progress; `/task` reads this file.
Full rationale for every step: **`docs/DESIGN.md`** (read on demand — not auto-loaded).

**v0.1 = M0–M4 + M6.** v0.1 deliberately skips M5 (particles → v0.2): the sequence is M4 → M6.
**Current milestone: M0.**

> **Scope-risk decision point — M2 exit:** if M2 slips materially, first cut
> **M4 (streamlines)** to v0.2 — slice + volume is already a useful viewer. Cut M6 only if the Zarr
> writer / `attrs["reduction"]` round-trip proves harder than expected (export gates the analyzer).

---

## M0 — Foundation
Goal: toolchain + schema codegen + scaffolds boot; OffscreenCanvas worker alive.
- [x] 1. Vite + TS strict (`tsconfig.base.json`) + Biome + Vitest; `npm` scripts wired
- [x] 2. `src/<layer>/` skeleton (schema, containers, coordinates, numerics, gpu) + path aliases (`@schema/*`, …)
- [x] 3. `scripts/check-boundaries.ts` (ts-morph) — layer-DAG enforcement, runs in CI ahead of `biome ci`
- [x] 4. Schema codegen: `gen-schema.ts` (pypic `schema export` → Zod + TS types), `gen-aliases.ts`, `gen-recipes.ts`
- [x] 5. `gpu/`: device acquire, capability probe, `device.lost` recovery, timestamp-query + `performance.now` fallback profiler
- [x] 6. OffscreenCanvas-on-Worker scaffold (`transferControlToOffscreen`); main-vs-worker frame-parity test
- [x] 7. Theme loader — reads `pypic/plotting/themes/*.toml` `[webpic]` block (7 themes, incl. `anuppuccin-light`)
- [x] 8. OPFS cache w/ `navigator.locks`; writes confined to `data.worker.ts` (worker-only sync handle; Safari <26)
- [x] 9. Background backend microbench (seeds dispatcher calibration; scores cached in OPFS by GPU adapter)
- [ ] **Exit gate:** cold-start page paint <500 ms; first frame <1500 ms (M2 Pro Chrome stable)

## M1 — Static slice
Goal: read a Zarr store and render one themed orthogonal slice of `|B|`.
- [ ] 1. `data/readers/zarr.ts` (zarrita.js) implementing `SimulationReader` + `FieldListingReader`
- [ ] 2. `data/readers/_registry.ts` — `registerReader` + `openSimulation()` (confidence-ranked)
- [ ] 3. `containers/field_dataset.ts` — typed-array-backed `FieldDataset`; destagger to co-located grid on load
- [ ] 4. `derived/magnitude.ts` registered under canonical `'|B|'`; TS backend in `compute/backends/ts`
- [ ] 5. `render`: one orthogonal `Mesh` (`NodeMaterial` sampling `uVolume`) with themed colormap
- [ ] 6. `computeField('|B|', dataset)` wired store → compute → render end-to-end
- [ ] 7. Schema-parity test (`pypic schema diff` + regenerated-vs-checked-in Zod) + additive-compat test
- [ ] **Exit gate:** `computeField('|B|')` end-to-end; schema-parity + additive-compat green

## M2 — Volume + perf gate
Goal: single-scalar volume raymarcher hitting the perf gate; time-series scrub.
- [ ] 1. WESL fragment raymarcher (`NodeMaterial` + `wgslFn`); analytic ray-box, early-α (≥0.98) termination
- [ ] 2. **`ui/` scaffold** — hideable shell panels + dependency-free `Pane`/`Folder`/`Binding` controls facade (slider/select/checkbox/text, ported from `magviz/src/ui/controls`, no `tweakpane`) + `ControlDescriptor` schema-aware binder. `ui` dispatches typed store intents only — never imports `render` (DAG-enforced); embed renders without `@webpic/ui`. One smoke per panel. *(foundation for M2.3 `RangeControl`, M2.6 diagnostics panel, M6.5 theme switcher)*
- [ ] 3. Transfer-function texture (256×1 `rgba16float`) + window/level via **owned `RangeControl`**
- [ ] 4. **`ColormapBinding`** store/schema node — reified colormap registry (mirror `magviz/src/store/schema.ts` field-for-field: `kind`/`label`/`id` discriminators) so magviz session exports round-trip. **Land before v0.1 freeze.**
- [ ] 5. Min-max mipmap (`rg32float`/`rg16float`) empty-space skipping, built on upload
- [ ] 6. Gradient + Phong central-difference shading (~20 lines WGSL — shape-perception win)
- [ ] 7. `timestamp-query` diagnostics panel (+ `performance.now` fallback)
- [ ] 8. Time-series prefetcher `data/prefetch.ts`: EWMA direction + debounce, double-buffered GPU upload
- [ ] 9. Eager `material.compileAsync` at boot; WESL HMR (edit shader, keep camera pose)
- [ ] 10. **Package-split checkpoint** — decide: promote `src/<layer>/` → `@webpic/<layer>` packages vs. collapse math-y layers into one `@webpic/core` (see `docs/DESIGN.md` §Package shape)
- [ ] **Exit gate:** 256³ × 256-step dataset @ ≤8 ms/frame raymarch on M2 Pro — else defer 512³ to v0.2 + LOD bricks; scrub without stalls

## M3 — WebGPU compute + parity
Goal: GPU compute backend agreeing with pypic goldens. (WASM backend deferred → M9.)
- [ ] 1. `compute/backends/webgpu` for `field.{magnitude,curl,divergence}` (imports `shaders` + `gpu`)
- [ ] 2. `tests/tolerances.ts` — per-kernel, per-precision tolerance table (honest f32/f16 bounds)
- [ ] 3. Cross-backend equivalence harness: `ts` vs `webgpu` per kernel
- [ ] 4. `gen-fixtures.ts` — pypic golden outputs checked into `tests/fixtures/v1/`
- [ ] 5. `gen-synthetic.ts` — Orszag-Tang + Harris analytical fields
- [ ] **Exit gate:** TS-vs-WebGPU agree within tolerance against pypic goldens

## M4 — Field lines  *(first to cut if M2 slips)*
Goal: cancellable GPU streamlines matching pypic's Dormand-Prince traces.
- [ ] 1. `numerics/integrators`: port pypic `dormand_prince_step` + `i_step_controller` (CPU reference)
- [ ] 2. `numerics/tracing.ts`: `trace_field_line[s]_adaptive` + `TerminationReason` (mirror `pypic.traces`)
- [ ] 3. WESL streamline compute kernel — **DP5(4) + PI step control**, one invocation/seed; shared-shader scaffold w/ rustpic
- [ ] 4. Raycast seed picking against slice/volume bounds
- [ ] 5. `Line2`/`LineSegments2` indirect-draw render (no per-frame readback)
- [ ] 6. `AbortSignal` cancellation through the dispatcher (cancel mid-trace)
- [ ] **Exit gate:** cancellable DP5(4) traces match pypic golden traces within tolerance

## M6 — Writers + export
Goal: persist derived fields + screenshots; lock bundle budgets.
- [ ] 1. `data/writers/zarr.ts` — Zarr v3 writer (derived-field caching, modifications)
- [ ] 2. **Reduction-provenance round-trip** — preserve `attrs["reduction"]` verbatim (`axis`, `op`, `result_kind`, `weight`, `length_axes`)
- [ ] 3. `simulation.toml` round-trip (`attrs.run` preferred; `attrs.simulation_toml` fallback)
- [ ] 4. PNG screenshot (`canvas.toBlob('image/png')`)
- [ ] 5. Theme switcher (cycle bundled themes; saved via OPFS)
- [ ] 6. TypeDoc from public `@webpic/embed` exports
- [ ] 7. `size-limit` CI gate
- [ ] **Exit gate:** 1.0 MB embed / 1.6 MB app gzipped; reduction round-trip preserved

---

## Backlog (v0.2+)
- [ ] **M5 — Particles:** `hyparquet`, instanced billboards, GPU cull/sort, density-binning fallback, `particleAccessMode` enum, DuckDB dynamic import
- [ ] **M7 — UI polish:** command palette (Cmd-K), remappable-shortcuts UI, comparison view, high-contrast theme
- [ ] **M8 — HDF5 + LIC + oblique:** `h5wasm`, LIC compute pass, oblique clip planes
- [ ] WebCodecs video export (`VideoEncoder` + `MediaStreamTrackProcessor`)
- [ ] **Remote client** — `remote/client.ts` against pypic.server Arrow-IPC WebSocket; mirror `SubscribeRequest`/`*Spec`/`ReductionSpec`
- [ ] PWA manifest
- [ ] **M9 (contingent)** — WASM backend (`@rustpic/plasma-wasm`) when rustpic ships it; extend cross-backend parity to TS vs WASM vs WebGPU

## Post-v1.0
- [ ] Spherical/cylindrical raymarcher path · [ ] WebTransport (when pypic.server adopts) · [ ] Marching-cubes isosurfaces · [ ] Pre-integrated TF · [ ] Plugin / extensibility API

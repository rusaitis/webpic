# webpic — TASKS

Check off `[ ]` → `[x]` as steps land. The `/tasks` skill summarizes progress; `/task` reads this file.
Full rationale for every step: **`docs/DESIGN.md`** (read on demand — not auto-loaded).

**v0.1 = M0–M4 + M6.** v0.1 deliberately skips M5 (particles → v0.2): the sequence is M4 → M6.
**Current milestone: M2.**

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
- [x] **Exit gate:** cold-start page paint <500 ms; first frame <1500 ms (M2 Pro Chrome stable). Measured by `npm run perf:gate` (`scripts/perf-gate.ts` — Playwright drives system Chrome stable headed, prod preview). Cold on base M2 (conservative proxy for M2 Pro): page paint 146 ms, first frame 210 ms — both well under budget. Re-validate at M2 once the raymarcher + `compileAsync`-at-boot replace the scaffold triangle.

## M1 — Static slice
Goal: read a Zarr store and render one themed orthogonal slice of `|B|`.
- [x] 1. `data/readers/zarr.ts` (zarrita.js) implementing `SimulationReader` + `FieldListingReader`
- [x] 2. `data/readers/_registry.ts` — `registerReader` + `openSimulation()` (confidence-ranked)
- [x] 3. `data/stagger.ts` — destagger Yee components to the co-located grid on load (`destaggerToColocated`, wired into the Zarr reader behind a no-op fast path); typed-array-backed `FieldDataset` consumed verbatim
- [x] 4. `derived/magnitude.ts` registered under canonical `'|B|'`; TS backend in `compute/backends/ts`
- [x] 5. `render`: one orthogonal `Mesh` (`NodeMaterial` sampling `uVolume`) with themed colormap
- [x] 6. `computeField('|B|', dataset)` wired store → compute → render end-to-end
- [x] 7. Schema-parity test (`pypic schema diff` + regenerated-vs-checked-in Zod) + additive-compat test
- [x] **Exit gate:** `computeField('|B|')` end-to-end; schema-parity + additive-compat green. Verified: typecheck/boundaries/lint clean, 188 tests pass, schema-parity + additive-compat green vs live pypic (`WEBPIC_PYPIC_PARITY=1`).

## M2 — Volume + perf gate
Goal: single-scalar volume raymarcher hitting the perf gate; time-series scrub.
- [x] 1. Single-pass volume raymarcher (TSL `NodeMaterial` + `wgslFn`, render-local — not a shared kernel); analytic ray-box, early-α (≥0.98) termination. `render/raymarchScene.ts` (TSL `Loop` + `wgslFn` `hitBox` + front-to-back composite); `rayBox.ts` TS twin + Node tests; worker `showVolume` + real-GPU smoke. Slice stays app default until the M2.2 UI toggle.
- [x] 2. **`ui/` scaffold** — hideable shell panels + dependency-free `Pane`/`Folder`/`Binding` controls facade (slider/select/checkbox/text, ported from `magviz/src/ui/controls`, no `tweakpane`) + `ControlDescriptor` schema-aware binder. `ui` dispatches typed store intents only — never imports `render` (DAG-enforced); embed renders without `@webpic/ui`. One smoke per panel. *(foundation for M2.3 `RangeControl`, M2.8 diagnostics panel, M6.5 theme switcher)* Rewritten to webpic's callbacks-out / `set()`-in contract (no two-way binding), `ownerDocument` DI, `.webpic-*` classes; native `<select>` + basic linear slider (full `RangeControl` → M2.3). `installUi()` mounts a themed docked shell + wired field selector (options = store `availableFields`; `selectField` intent) + `layers`/`diagnostics` placeholders; `toggleUi` shortcut. `happy-dom` `*.dom.test.ts` project for DOM smokes (15 tests). typecheck/boundaries/lint/build clean, 212 tests pass.
- [x] 3. Transfer-function texture (256×1 `rgba16float`) + window/level via **owned `RangeControl`** — its `{center,width}` output is the canonical range form the M2.5 `ColormapBinding` stores (no separate `min/max`). `render/transferFunction.ts` bakes the colormap LUT from `colormapColor` (RGB; alpha=1, reserved for the M2.7 opacity TF), sampled in both scenes; window/level becomes `uWindowCenter`/`uWindowWidth` uniforms (full-range default = old normalization) with an in-place `setWindowLevel` so dragging never re-uploads the volume (new `setWindowLevel` render message, no field buffer). Store gains `dataRange` + `windowLevel {center,width}` (reset to full range per field) + `setWindowLevel` intent. **Owned `RangeControl`** ported from magviz (full linear/log/symlog/interval + `rangeMath`, `ownerDocument` DI, `.webpic-range*`, callbacks-out/set()-in) → `addRangeControl` facade. The **Layers** placeholder is now a real panel: a linear interval window/level control (interval↔`{center,width}` at the store seam; M2.5 adds colormap + scale pick). `colormapNode.ts` retired. typecheck/lint/boundaries/build clean, 269 tests pass (+ rangeMath port, TF LUT, store window/level, RangeControl + Layers DOM smokes).
- [ ] 4a. **Render loop + store-owned camera pose** — the interactive-camera foundation M2.1 punted (camera is static inside `createRaymarchScene`, `lookAt(0,0,0)`; rendering is one-shot `renderFrame` on data change). Lift the camera out of the scene factories — pose lives in the store and streams to the worker (`StoreToRender — camera pose`, DESIGN §443, unbuilt; `messages.ts` has no camera channel yet). Worker applies the pose to the current scene's camera and drives a continuous frame loop (one-shot → rAF). gl-matrix `Vec3` pose state store-side; THREE camera stays in `render/`. Unblocks honest per-frame perf measurement (M2.8 + exit gate need a real loop) and the M2.13 HMR "keep pose" prerequisite.
- [ ] 4b. **Orbit/turntable controls + pointer input** — the interaction on top of 4a. Pointer events land on the main-thread container (the `OffscreenCanvas` is transferred to the worker) → camera deltas → store intent → `StoreToRender`. Orbit (azimuth/elevation/target) + turntable (constrained up-axis); `navMode` selects. Owned controls — no `OrbitControls`-as-dep unless it earns its keep. Makes M2.7 Phong actually assessable (rotate to perceive shape). Can slip past 4a without blocking the loop/HMR work.
- [ ] 5. **`ColormapBinding`** store/schema node — reified colormap registry in webpic-native shape (typed `FieldName` + `ColormapId`, **window/level** `{center,width}` matching M2.3's `RangeControl`, discriminated `scale: linear|log|symlog`), *not* a field-for-field mirror of magviz's prototype (its bare-string `colormap`/`units`/`min,max` stay out). Primitives reference bindings by id so slice + volume share or split deliberately. v0.1 ships the minimal registry (slice + volume only — defer `merge`/GC/2-colormap-warn until contour M4 + fieldlines M5). **Land the abstraction before v0.1 freeze** — reified bindings are painful to retrofit once primitives hardcode color state. Magviz session round-trip is *not* the driver: it demotes to a boundary import adapter (`data/import/magviz.ts`, decoding magviz `{min,max,log,logFloor}` → window/level) at M6 session-export / v0.2.
- [ ] 6. Min-max mipmap empty-space skipping — **gate contingency, not unconditional**: do this only if 256³×256-step misses the 8 ms **exit gate** below. Profile first (CLAUDE.md "profile before tuning") — a space-filling turbulent `|B|` rarely trips "empty," so the win is real only for sparse fields (magnetosphere, isolated flux ropes). Min-max pyramid (`rg16float`/`rg32float`, nearest-sampled — no `float32-filterable` needed) built on upload as a pure typed-array reduction (testable; adds per-timestep CPU cost during time-series scrub, M2.10). Not additive: the fixed-step TSL `Loop` becomes a variable-step coarse-skip/fine-descend traversal (likely one `wgslFn`, re-integrating the colormap node).
- [ ] 7. Gradient + Phong central-difference shading (~20 lines WGSL — shape-perception win) — ships as a **toggle**, off by default for quantitative work (the lit "surface" is a TF-dependent opacity isosurface, not physical). Not free: 6 taps/step on a 256-step march, so gate the gradient on `sampleAlpha` or precompute a gradient volume lest it eat the 8 ms gate. Render-local — *not* `coordinates/operators/gradient`; a shading normal isn't a physics operator, don't dedupe them.
- [ ] 8. `timestamp-query` diagnostics panel (+ `performance.now` fallback) — `gpu/profiler.ts` (both backends) already exists, so this is wiring: drive it around the raymarch pass in `render/worker.ts`, add a frame-timing reply to `render/messages.ts` (none today; DESIGN §444 anticipates `RenderToStore`), fill the M2.2 `diagnostics` panel stub. **Label the active clock** — wallclock includes JS/queue latency and over-reads the GPU-time gate, so don't let it masquerade as the timestamp number; surface a rolling value (the async read NaNs one frame in flight). It's the instrument for the exit gate and the M2.6 contingency call — do it before the gate.
- [ ] 9. **Time cursor + scrub control** — the prefetch prerequisite. Store gains `currentStep`/`availableSteps` + a `setStep` intent; `ui` gains a scrub `RangeControl`. Reader substrate is ready (`readTimestep`/`availableTimesteps`, multi-step tested) — today the store has no time cursor at all, so this lands before any streaming.
- [ ] 10. **Time-series streaming core** (the exit-gate "scrub without stalls" clause — streaming is mandatory at 256³: ~64 MiB/field/step, ring depth N≈1–5, can't hold 256). Ring buffer + prefetch ±1 + double-buffered upload. Two workers: predict/read in `data.worker.ts` → `MessagePort` transfer → ping-pong `Data3DTexture` in `render/worker.ts` (today rebuilds+disposes per swap). Ring vs CLAUDE.md "transfer, don't clone": hold until upload, transfer on upload (buffer detaches), re-read evicted steps from OPFS on scrub-back.
- [ ] 11. **Prefetch prediction `data/prefetch.ts`** — profile-then-tune, added only if the task-10 dumb ±1 stalls ("profile before tuning"). EWMA direction (window=8, α=0.7) + magnitude→count(1–5) + 250 ms debounce-on-flip + stationary→±1. Fuzz scrubber in `tests/prefetch.test.ts`.
- [ ] 12. **Eager pipeline compile** (production — gates the first-frame budget). `renderer.compileAsync(scene, camera)` (the renderer method — there is no `material.compileAsync`) warms the heavy raymarch pipeline *before its first `renderOnce`*, off the critical path, so the first frame doesn't hitch on driver compile. Not literally "at boot": `worker.ts:init()` only builds the triangle then; warm each heavy scene in `showVolume`/`showSlice` (coincides with boot only if a default dataset auto-loads). Post a compile-complete reply (DESIGN §444 `RenderToStore`) so the UI can drop its spinner.
- [ ] 13. **Shader HMR** (dev-only — `import.meta.hot` is tree-shaken from prod). Edit WGSL/TSL in `raymarchScene.ts`, see it re-render **without a reload or losing state**. *Prerequisite:* camera pose must be **store-owned** (DESIGN §443 `StoreToRender — camera pose`) + an interactive camera must exist — today the camera is static and built *inside* `createRaymarchScene`, so a scene rebuild resets the very pose this promises to keep (built by M2.4a/4b). Mechanism: message-driven in-place rebuild (main watches the file → `rebuildShader` message → worker swaps the material), **preserving the `GPUDevice` + uploaded `Data3DTexture`** (don't re-upload 64 MiB per keystroke) and re-applying the stored pose — not vanilla worker `import.meta.hot`.
- [ ] 14. **Package-split checkpoint** — decide: promote `src/<layer>/` → `@webpic/<layer>` packages vs. collapse math-y layers into one `@webpic/core` (see `docs/DESIGN.md` §Package shape)
- [ ] **Exit gate:** 256³ × 256-step dataset @ ≤8 ms/frame raymarch on M2 Pro — else defer 512³ to v0.2 + LOD bricks; scrub without stalls

## M3 — WebGPU compute + parity
Goal: GPU compute backend agreeing with pypic goldens. (WASM backend deferred → M9.)
- [ ] 1. `compute/backends/webgpu` for `field.{magnitude,curl,divergence}` — kernels authored as standalone WGSL in `shaders/` (shared w/ rustpic, tested vs the `coordinates/` TS twin); imports `shaders` + `gpu`
- [ ] 2. `tests/tolerances.ts` — per-kernel, per-precision tolerance table (honest f32/f16 bounds)
- [ ] 3. Cross-backend equivalence harness: `ts` vs `webgpu` per kernel
- [ ] 4. `gen-fixtures.ts` — pypic golden outputs checked into `tests/fixtures/v1/`
- [ ] 5. `gen-synthetic.ts` — Orszag-Tang + Harris analytical fields
- [ ] **Exit gate:** TS-vs-WebGPU agree within tolerance against pypic goldens

## M4 — Field lines  *(first to cut if M2 slips)*
Goal: cancellable GPU streamlines matching pypic's Dormand-Prince traces.
- [ ] 1. `numerics/integrators`: port pypic `dormand_prince_step` + `i_step_controller` (CPU reference)
- [ ] 2. `numerics/tracing.ts`: `trace_field_line[s]_adaptive` + `TerminationReason` (mirror `pypic.traces`)
- [ ] 3. WGSL streamline compute kernel (standalone `shaders/` asset, shared w/ rustpic) — **DP5(4) + PI step control**, one invocation/seed
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

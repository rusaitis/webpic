# webpic — TASKS

Check off `[ ]` → `[x]` as steps land. The `/tasks` skill summarizes progress; `/task` reads this file.
Full rationale for every step: **`docs/DESIGN.md`** (read on demand — not auto-loaded).
Completed items are summarized to the load-bearing decisions; the git log is the full audit trail.

**v0.1 COMPLETE** (M0–M4 + M6, all gates met — 2026-07-03). Traces GPU≡CPU≡pypic on real M2; volume + slice + field lines co-display as managed layers; Zarr write + reduction/run-metadata round-trips proven against live pypic; embed documented (TypeDoc) and budget-gated in CI (538.6 kB / 1 MB embed, 396.7 kB app against the then-1.6 MB budget, gzip; app tightened to 550 kB in A below).

**v0.2 renumbers the backlog:** M5 = UI polish *(next up)*, M6 = Particles, M7 = HDF5 + LIC + oblique, M8 = Remote client, M9 = WASM (contingent). v0.1 had skipped its own M5 (particles) and jumped M4 → M6; the completed **"M6 — Writers + export"** below keeps that historical label, and `M<N>.<i>` anchors cited by DESIGN.md and session memory use v0.1 numbering.

---

## M0 — Foundation
Goal: toolchain + schema codegen + scaffolds boot; OffscreenCanvas worker alive.
- [x] 1. Vite + TS strict (`tsconfig.base.json`) + Biome + Vitest; npm scripts wired
- [x] 2. `src/<layer>/` skeleton + path aliases (`@schema/*`, …) pre-staging the eventual package split
- [x] 3. `scripts/check-boundaries.ts` (ts-morph) — layer-DAG enforcement, in CI ahead of `biome ci`
- [x] 4. Schema codegen: pypic `export bundle` → Zod + TS types (`npm run gen`; outputs checked in, `gen:check` guards drift)
- [x] 5. `gpu/`: device singleton, capability probe, `device.lost` recovery, profiler with `performance.now` fallback
- [x] 6. OffscreenCanvas-on-Worker scaffold (`transferControlToOffscreen`); main-vs-worker frame-parity test
- [x] 7. Theme loader — pypic themes' `[webpic]` block (7 themes bundled)
- [x] 8. OPFS cache with `navigator.locks`; writes confined to `data.worker.ts` (sync handle is worker-only; Safari <26)
- [x] 9. Background backend microbench — dispatcher-calibration seed, cached in OPFS by GPU adapter
- [x] **Exit gate:** cold paint <500 ms / first frame <1500 ms — **met** (146 / 210 ms base M2, `npm run perf:gate`)

## M1 — Static slice
Goal: read a Zarr store and render one themed orthogonal slice of `|B|`.
- [x] 1. `data/readers/zarr.ts` (zarrita) implementing `SimulationReader` + `FieldListingReader`
- [x] 2. `data/readers/_registry.ts` — confidence-ranked `registerReader` + `openSimulation()`
- [x] 3. `data/stagger.ts` — destagger Yee components to the co-located grid on load (no-op fast path)
- [x] 4. `derived/magnitude.ts` under canonical `'|B|'`; TS backend in `compute/backends/ts`
- [x] 5. One orthogonal slice `Mesh` (`NodeMaterial` sampling `uVolume`) with themed colormap
- [x] 6. `computeField('|B|', dataset)` wired store → compute → render end-to-end
- [x] 7. Schema-parity + additive-compat tests vs live pypic
- [x] **Exit gate:** end-to-end `|B|`; parity suites green vs live pypic (`WEBPIC_PYPIC_PARITY=1`) — **met**

## M2 — Volume + perf gate
Goal: single-scalar volume raymarcher hitting the perf gate; time-series scrub.
- [x] 1. Single-pass raymarcher (TSL `wgslFn`, render-local — not a shared kernel): analytic ray-box, early-α ≥0.98; `rayBox.ts` TS twin
- [x] 2. `ui/` scaffold — owned `Pane`/`Folder`/`Binding` controls facade (no tweakpane); ui dispatches store intents only, never imports render
- [x] 3. Transfer-function texture + owned `RangeControl` (linear/log/symlog); window/level are uniforms, so dragging never re-uploads the volume
- [x] 4a. Render loop + store-owned camera pose (orbit-spherical; `setCameraPose` message; on-demand dirty-flag rAF loop)
- [x] 4b. Orbit/dolly/pan as pure pose helpers + pointer input on the main-thread canvas; CSS-3D gnomon HUD
- [x] 5a. Layer model — ordered `layers` registry + worker composite of visible layers (≤1-layer fast path = old direct path)
- [x] 5b. `ColormapBinding` (`@schema/colormap.ts` is the authority) — layers share or split bindings; all three scales on-GPU with a pure-TS `windowedT` twin
- [x] 6. Min-max empty-space skipping — built, measured **1.7× slower** on space-filling |B| (skip-grid fetch + branch buys no skips), and removed; the plain march is the only path
- [x] 7. Central-difference Phong shading — per-layer toggle, off by default; taps gated on opacity + `uShade`; render-local, not a physics operator
- [x] 8. Frame-time diagnostics — Metal render-pass timestamp-query intermittently returns garbage → adaptive demote to wall-clock for the session
- [x] 9. Time cursor + scrub control — index-walking scrub over `availableSteps`, robust to sparse/non-contiguous steps
- [x] 10a. Streaming, data side — synthetic multi-step reader + tested ring (`data/stream.ts`: ±1 prefetch, abort-on-scrub-past, evict farthest-first); worker computes off-main, transfers to the render worker over a paired `MessageChannel`
- [x] 10b. Streaming, render side — ping-pong `Data3DTexture` double-buffer (`setField`): a bind-group swap, not a pipeline recompile; binding window fixed across steps (no autoscale flicker)
- [x] 11. Prefetch predictor (`data/prefetch.ts`) — built/tested/**dormant**; activation gated on a slow real reader + ring capacity ≥7 (~448 MiB resident at 256³)
- [x] 12. Eager pipeline compile + `layerCompiled` ack — loading pill bridges the cold-start compile gap
- [x] 13. Shader HMR (dev-only, build-verified tree-shaken) — message-driven material swap; pose + uploaded volume survive WGSL edits
- [x] 14. Package-split checkpoint — **stay single-package**; if ever split, coarse `@webpic/core` + `app` + `embed`, not 18 (DESIGN §Package shape)
- [x] **Exit gate:** **256³ is the v0.1 volume ceiling** (512³ + LOD bricks → backlog, the gate's prescribed contingency). Settled p50 ≈12.4 ms on base M2, wall-clock (M2 Pro target extrapolates ~6.5–7.5 ms — plausibly under, unconfirmed); scrub-without-stalls **met**. Instruments: `scripts/profile-raymarch.ts` + `scripts/verify-streaming-render.ts` (headed Chrome — they drive the live UI and drift on UI refactors)

## M3 — WebGPU compute + parity
Goal: GPU compute backend agreeing with pypic goldens. (WASM backend → M9.)
- [x] 1. `compute/backends/webgpu` for magnitude/curl/divergence — one standalone WGSL module (rustpic-shareable, not TSL); WGSL `diff1` exactly mirrors `partialAlongAxis` (np.gradient edge_order=1); **deliberately not in the dispatcher** — a worker holds no `GPUDevice`, so live routing needs the worker-reads/main-computes seam
- [x] 2. `tests/tolerances.ts` — per-kernel × per-precision `{rtol,atol}` matrix (`TOL.<kernel>.<precision>`); widen only with a measured reason
- [x] 3. Cross-backend equivalence harness (`tests/crossBackend.ts`) — TS vs WebGPU on data **and** metadata; parametrized to be reused by the M9 WASM backend
- [x] 4. pypic same-input goldens (`gen-fixtures.ts` + `pypic_goldens.py`) — TS ≡ golden at machine precision; input/analytic drift guards
- [x] 5. Synthetic MHD fixtures (Orszag-Tang, Harris, GEM) — divergence-free-by-construction oracles: exact-zero identities + N→2N convergence (order ≈2) instead of magic tolerances
- [x] **Exit gate:** **TS≡WebGPU≡pypic triangle closed** on real M2 (`npm run test:gpu`) across smooth + synthetic MHD fields — **met**

## M4 — Field lines + instance-first UI
Goal: cancellable GPU streamlines matching pypic's Dormand-Prince traces, plus the multi-layer UI (rail + Layers panel).
- [x] 1. `numerics/integrators.ts` — DP5(4) FSAL + I-controller (pypic ships I, not PI); Butcher tableau as exact fraction expressions → bit-for-bit vs numpy
- [x] 2. `numerics/{interp,tracing}.ts` — trilinear interpolator + adaptive tracer. **Load-bearing: pypic grids are cell-centered** (sample i at origin+(i+0.5)·dx) → the index map carries a −0.5 offset; TS ≡ pypic goldens with `reason`/`nPoints`/`nSteps` exact
- [x] 3. WGSL streamline kernel — one invocation per (seed, direction); **storage-buffer manual trilinear, NOT `textureSampleLevel`** (exact op-order parity; hardware filtering would risk the tolerance); stitch/`FieldLine` assembly stays CPU-shared; GPU≡CPU≡pypic counts-exact
- [x] 4. Raycast seed picking (`store/seedPick.ts`) — seeds are **physical, not index**, clamped to the cell-center domain so box-face picks still trace
- [x] 5. `Line2` batched render — one GPU-resident draw call, uploaded once, no per-frame readback; first in-app trace dispatch (`T`)
- [x] 6. `AbortSignal` through the dispatcher — per-step `throwIfAborted`; abort + generation-guarded `retrace()` mirrors `recompute()`
- [x] 7. Instance-first Layers UI — grouped side rail + Layers overlay (eye/reorder/select); `S` deliberately unbound (collides with W/S dolly)
- [x] 8. Per-layer settings — one floating window always reflecting the *selected* layer; slice position = live uniform, axis = rebuild from the retained field; raycast seed placement
- [x] 9. Colorbar — ≤2 distinct visible-binding stack + amber `+N` soft-warn; subscribe via `zustand/vanilla/shallow` (React-free build)
- [x] **Exit gate:** cancellable DP5(4) traces ≡ pypic goldens (uniform bit-tight; smooth/rotational at 1e-6, counts exact); volume + slice + field lines co-display as managed layers — **met** (real-Chrome E2E, zero console errors)

## M6 — Writers + export *(v0.1 numbering — predates the v0.2 renumber)*
Goal: persist derived fields + screenshots; lock bundle budgets.
- [x] 1. `data/writers/zarr.ts` — Zarr v3 writer mirroring `pypic.io.zarr.to_zarr`. **Cross-impl quirk:** zarrita writes `fill_value: null` + empty codecs, which spec-strict zarr-python rejects → stamp `fillValue: 0` + explicit LE `bytes` codec
- [x] 2. Reduction-provenance round-trip — `attrs["reduction"]` verbatim; key-presence semantics match `pypic.reductions` (no defaults, no normalization, no validation)
- [x] 3. `simulation.toml` round-trip — reserved-metadata-key mechanism lifts `attrs.run`/`simulation_toml` to root attrs; carried verbatim, **no Zod strip** (would drop additive v1.x fields)
- [x] 4. PNG screenshot — worker-side capture off the deterministic full-res readback (main canvas is transferred, so `toBlob` there is empty by construction); `P` → download
- [x] 5. Theme switcher — OPFS-persisted pref, live cycle via CSS-var re-apply + worker `setTheme` (no reload, no boot flash)
- [x] 6. TypeDoc on the embed facade — **star-export collision guard**: ES `export *` silently drops names exported twice; `tests/embed.test.ts` asserts facade completeness. 132 public names, 0-warning
- [x] 7. `size-limit` CI gate — embed 538.6 kB / 1 MB, app 396.3 kB / 1.6 MB; **`"gzip": true` per check is load-bearing** (v12 defaults to brotli); zero three.js in the embed (leak canary)
- [x] 8. Top bar — dataset name honors run metadata (typed `run.name` → TOML re-parse → catalog → id); projection chip mirrors the same `setProjection` intent; live export button
- [x] **Exit gate:** budgets green (~46% / 75% headroom, in CI); reduction + run-metadata round-trips proven against live pypic — **met. v0.1 (M0–M4 + M6) done.**

---

## Fixes since v0.1

- [x] **#1 — a null seed no longer kills a field-line layer.** Seed rejection moved from per-batch to per seed in the `compute/traceField` facade (`numerics/tracing` keeps pypic's strict batch behind `onInvalidSeed: "throw"`); the store publishes a per-layer `traceNotices` tally the field-lines panel reports and the status pill flashes when a layer draws nothing. **Breaking:** `traceFields` now resolves to `{ lines, skipped, fieldName }`, not `FieldLine[]`. Field lines also follow their layer's displayed field (`|E|` → E_1..3, falling back to B), re-rake seeds stranded by a dataset switch, and draw at a domain-scaled `max_step`. A dataset switch now rescales every layer on the active field, not just the selected one.

## Backlog (v0.2)

### M5 — UI polish *(next up)*
Pure-frontend, no new deps — make daily use pleasant before the heavy features land, and clear the deferred-UI debt in one sweep.
- [ ] 1. Floating **window manager** — lift magviz's `windowManager` + `draggablePanels`: free-drag/resize/persist/focus-stack for the fixed translucent overlays (`ui/floating/floatingWindow.ts` is the seed; the Developer window already floats)
- [ ] 2. Command palette (`Cmd+K`) — fuzzy match over the `ui/shortcuts.ts` registry (stays the cheat-sheet authority)
- [ ] 3. Remappable-shortcuts UI — runtime keymap editing, OPFS-persisted
- [ ] 4. Comparison view — side-by-side datasets via a secondary viewport
- [ ] 5. High-contrast theme
- [ ] 6. Carried UI deferrals: rail-menu hover-preview/click-pin (M4.7) · colorbar overflow chips with click-to-cycle (M4.9) · named theme *picker* + theme-driven `rail-items` (M6.5) · body-portaled popover dropdown control · binding merge/GC + magviz session import adapter (M2.5b) · top-bar upload/layers/layout actions + run-metadata popover (M6.8)

### M6 — Particles
The headline v0.2 feature: species point clouds beside the field layers.
- [ ] 1. `hyparquet` reader implementing `ParticleDataReader` (`data/readers/_protocols.ts` — the protocol is already designed; registration is one line in `builtins.ts`)
- [ ] 2. Instanced billboard pass — 2-tri quads via `InstancedMesh`
- [ ] 3. GPU cull/sort pre-pass — compute writes a `drawIndexedIndirect` list
- [ ] 4. `particleAccessMode` enum: `snapshot | sampled | aggregated | sql` — explicit, never inferred
- [ ] 5. DuckDB-wasm via `await import()` in **`sql` mode only** — never in the base bundle
- [ ] 6. Density-binning fallback above ~5×10⁶ visible particles
- [ ] 7. Particles keybinding + the rail's `+Particles` placeholder goes live (shipped disabled in M4.7)

### M7 — HDF5 + LIC + oblique
Local-first: round out the standalone analyzer before networking.
- [ ] 1. `h5wasm` reader for legacy pre-Zarr simulations — registers in `builtins.ts` beside zarr
- [ ] 2. Wire `registerBuiltinReaders()` into the data worker — the first real streaming reader replaces `data.worker.ts`'s synthetic-only registration
- [ ] 3. Prefetch-predictor activation call — profile the first slow real reader against the dormant M2.11 seam (needs ring capacity ≥7)
- [ ] 4. LIC compute pass — dense 2D flow texture sampled along slice planes
- [ ] 5. Oblique clip planes — fragment `discard` on a uniform `vec4` plane equation; extend `SliceAxis` beyond the three orthogonal axes

### M8 — Remote client
pypic.server foundations already shipped (HTTP discovery + WS Arrow-IPC stream) — this is wiring, not design. Activates the reserved `remote/` layer.
- [ ] 1. `remote/protocol.ts` — mirror pypic's wire types: `SubscribeRequest`, `Box/Plane/SphereSpec`, `ReductionSpec`, `Ack`, `ErrorFrame`
- [ ] 2. Typed error dispatch on `kind` (`unknown_sim`/`unknown_field`/`unknown_step`/`geometry_unsupported`/`validation`/`internal`) — never free-form message matching
- [ ] 3. `remote/client.ts` — `/health` + `/sims` discovery, WS subscribe, Arrow-IPC decode (schema metadata under the `"pypic"` key; `Ack` pre-sizes textures)
- [ ] 4. App datasource switch local ↔ remote + a UI connect toggle
- [ ] 5. Soft dep: pypic Step 37b (`attrs.selections` round-trip) before selection state persists across sessions; SSE/HTTP-2 fallbacks stay forward-looking

### M9 — WASM backend *(contingent — blocked on rustpic shipping `@rustpic/plasma-wasm`)*
- [ ] 1. `compute/backends/wasm` mirroring `backends/ts`; the dispatcher already reserves the `"wasm"` id
- [ ] 2. Three-way parity (TS vs WASM vs WebGPU) via the M3.3 cross-backend harness — built to be reused
- [ ] 3. `vite-plugin-wasm` + `vite-plugin-top-level-await` land here (deferred deps)
- [ ] 4. comlink compute-worker pool once WASM ops get heavy (the "M3+" trigger in CLAUDE.md)

### Unscheduled (slot opportunistically)
- [ ] WebCodecs video export (`VideoEncoder` + `MediaStreamTrackProcessor`) — mirrors the M6.4 screenshot path
- [ ] 512³ volumes + LOD bricks — the M2 exit-gate contingency
- [ ] GPU streamline dispatch + off-main tracing + scrub re-trace — the M4.6 seam; `traceFieldLinesWebgpu` is built and waiting on the worker-reads/main-computes routing
- [ ] Fieldlines true `drawIndirect` + trace-sampling texture fast path (M4.3/M4.5 deferrals)
- [ ] Poincaré sections (`poincare_section`/`PoincareSurface` scatter overlay) + `estimate_tracing_error` confidence overlay — candidates from the M4 primitives (DESIGN §Milestones)
- [ ] OPFS scrub-back caching (M2.10b option; synthetic re-reads are cheap, real readers may not be)
- [ ] Zarr consolidated-metadata write + timeseries append (M6.1 deferral)
- [ ] `WebpicViewer` embedding API + embed smoke (M6.7 — today's facade is the headless math+data surface)
- [ ] Offline service-worker (needs a real data source first)
- [x] PWA manifest + icons + iOS standalone meta — guarded by `tests/manifest.test.ts`

## Code health — 2026-09 review
Full findings + sequencing: the review plan (session 2026-09-09). Coverage baseline at review time: **75.4% statements / 76.4% lines**; after the three tiers **77.1% / 78.2%** (1240 → 1288 tests) (`npm run test:coverage`, report only — no gate until the number has a history).
- [x] A. Guardrails — v8 coverage, lefthook, `docs:api` in CI (`gen:themes:check` stays local-only — it reads the `../pypic` sibling), Biome `useExhaustiveSwitchCases`/`noFloatingPromises`/`noMisusedPromises`/`noConsole`/`noParameterAssign`, `lib: ES2024`, `erasableSyntaxOnly` for scripts, `engines >=22.18` + `.nvmrc` + dependabot, app size budget 1.6 MB → 550 kB, DESIGN §Testing/§CI brought back to reality
- [x] B. Hygiene — exhaustive response routers, `logError` seam + `.catch` at every fire-and-forget, per-frame allocs out of `cameraChrome` + composite assembly, `AbortSignal` on reader probe + `setDataset`, one `intersectRayBox`/`axisSpan`/`finiteRange` (stands up `reductions/`), render-worker `dispose` message, `Error.cause`, `// STAGED:` marker for built-not-wired code, test + scripts harness dedupe
- [x] C. Structure — shared types to `schema/`, split `store/simulation.ts` (+ discriminated field state, timing → `store/perf.ts`), `LAYER_KINDS` descriptor table + nested `upsertLayer` params, de-globalize `render/worker.ts`, `ui` subscription bridge, `colorbar`/`pointerCamera` splits, worker tsconfig, render "diagnostics" → "timing"

## Post-v1.0
- [ ] **Spherical/cylindrical raymarcher** — unlocks non-Cartesian sims (global magnetosphere, tokamak) the reader currently rejects outright; native curvilinear marching avoids the resampling smear that lands exactly where the physics concentrates (axes, poles, separatrices).
- [ ] **WebTransport** (when pypic.server adopts) — QUIC's independent streams end WebSocket head-of-line blocking, so one slow field can't stall the rest; matters when streaming from an HPC center over long or lossy links.
- [ ] **Marching-cubes isosurfaces** — explicit level-set meshes (|B| shells, current sheets) give crisp silhouettes and correct occlusion the raymarcher only approximates, re-render cheaply from any angle, and export (glTF/STL) for papers and Blender.
- [ ] **Pre-integrated transfer function** — removes slab-banding at coarse step counts, so the raymarcher holds visual quality at roughly half the steps: the cheapest lever toward both the 8 ms gate margin and the 512³ ambition.
- [ ] **Plugin / extensibility API** — formalizes the internal seams (reader confidence registry, recipe registry, panel registry) into stable extension points, so community formats (Athena++, FLASH) and custom diagnostics don't require forking webpic.

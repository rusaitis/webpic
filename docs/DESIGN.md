# webpic — Design

> The design rationale behind webpic: the layer DAG, schema sharing with pypic, the compute
> dispatcher, the rendering pipeline, and the open risks. `TASKS.md` tracks what is built;
> this document explains why it is shaped the way it is.
>
> *Citation anchor:* `file:line` references into sibling repositories were last re-verified
> **2026-06-07**. Line numbers drift on every commit — prefer the `file::Symbol` form, and
> re-verify when reading well after that date.

## Context

`webpic` is the third leg of a three-project plasma simulation toolchain:

- **pypic** (Python) — authoritative analysis library, schema authority. `pypic.server` foundations ship today (`create_app`, `serve`, Arrow IPC over WebSocket, typed `SubscribeRequest`/`BoxSpec`/`PlaneSpec`/`SphereSpec`/`ReductionSpec`/`Ack`/`ErrorFrame` protocol from `pypic/server/protocol.py`); webpic just needs to wire a client.
- **rustpic** (Rust) — future PIC simulator; plan reserves `@rustpic/plasma-wasm` (npm) and `@rustpic/shaders` (npm) for browser-side reuse. Neither exists yet.
- **webpic** (TypeScript / Three.js / WebGPU) — local and remote 3D viewer and lightweight analyzer.

**Why a clean restart.** The prototype `magviz` (a private WebGL predecessor, referenced
throughout this document for the lessons it produced) proved browser-side plasma viz is feasible, but its pre-refactor form entangled rendering, UI, data, and physics — extension was painful (since refactored to layered TS; the lesson, not the LoC, is what matters). webpic restarts with:

- Hard layer boundaries, WebGPU-first compute, strict TypeScript.
- Schema-level pypic compatibility — same `simulation.toml`, same Zarr/HDF5/Parquet on disk, eventually the same WGSL kernels in both browser and Rust simulator.
- Standalone-useful (drop in a Zarr URL → working scene); later streams from `pypic.server` and live rustpic runs.

### Why now / why this shape
- pypic's schema and reader infrastructure are stable. The pypic CLI ships today — `pypic export bundle` drives codegen, `pypic schema diff` guards drift — so codegen invokes it directly rather than shelling into Python or reimplementing the export.
- pypic's codegen-surface modules are public — `pypic.{aliases,compute,numerics,traces,server}` (full symbol inventory in §Critical files & references). webpic codegen reads them directly — no underscore-prefixed imports.
- rustpic's plan reserves `@rustpic/plasma-wasm` and `@rustpic/shaders` for webpic to consume; neither exists today, so v0.1 ships **TS-only compute** and adopts WASM / shared shaders as they land. Shared kernels are authored as **standalone WGSL** in `shaders/` — WGSL is a strict subset of WESL, so they migrate to WESL (`@if`, imports) for free if rustpic later publishes `@rustpic/shaders` that way. The WESL *toolchain* (`wesl-js`/`wesl-rs`) is deferred until there's a real cross-language kernel to share (see §Shader sharing with rustpic).
- WebGPU is shipped in Chrome/Edge (since 2023), Safari 18+ (2024), and Firefox 141+ (2025; behind a flag in earlier versions). Coverage is solid enough to make it the only path and skip the WebGL2 twin.

### Versioning scheme
Semver. **v0.1** = M0–M4 + M6 (writers/export — v0.1 numbering) = first publishable shell (early adopters; expect breaking schema changes). **v0.2** = +M5 (UI polish) + M6 (particles) + M7 (HDF5/LIC/oblique) + M8 (remote client) = feature-complete — the backlog was renumbered at v0.1 close; TASKS.md is the numbering authority. **v1.0** = production-stable after ≥3 months of v0.2 with no pending breaking schema changes. **"post-v1.0"** = explicitly deferred until after v1.0.

---

## Goals & non-goals

**Goals**
1. Render real plasma simulation data (PIC, MHD, hybrid) in 3D at interactive framerates: volume rendering, orthogonal + oblique slicing, GPU streamlines, particle clouds (v0.2).
2. Read pypic-blessed formats locally (Zarr v3, HDF5, Parquet); stream from `pypic.server` (foundations ship; webpic remote client lands v0.2).
3. Reuse pypic's canonical schema (names, units, normalizations, coordinate systems) end-to-end, with codegen so drift is caught by tests.
4. Hard layer separation — `schema`, `containers`, `coordinates`, `numerics`, `reductions`, `gpu`, `shaders`, `derived`, `diagnostics`, `compute`, `data`, `remote`, `render`, `store`, `ui` — each importable independently. UI is fully strippable; the render layer alone is a usable library for non-simulation uses.
5. Future-forward GPU compute: shared WGSL/WESL kernels with rustpic, GPU-resident derived quantities, streamline integration, particle binning.
6. Strict TypeScript from day one. Pragmatic testing — schema, numerics, data adapters, cross-backend equivalence.
7. Modern minimal UI: hideable panels, command palette (v0.2), remappable shortcuts. Own the control primitives (sliders, selects, checkboxes, text) as dependency-free DOM — lifted from magviz's proven `ui/controls` layer — plus custom shell, palette, keymap, theme.
8. Resilient: OffscreenCanvas-on-Worker render path, `device.lost` recovery, multi-tab OPFS safety, schema-versioned caches.

**Non-goals (now)**
- WebGL2 fallback. If `navigator.gpu` is missing, show a "webpic requires WebGPU" page.
- 2D plotting (Matplotlib-equivalent) — pypic owns that.
- Native desktop builds (Electron/Tauri). Browser-only for v1.0.
- Live rustpic streaming protocol design. Define HTTP/WS with `pypic.server` first; rustpic adopts or extends.
- Multi-user collaboration.
- WebXR / VR. Different product.

---

## Architecture overview

### Layered dependency DAG

Enforced by **three layers of defense in depth** (Biome has no `eslint-plugin-boundaries` equivalent):

1. **Primary:** `scripts/check-boundaries.ts` (`ts-morph`) gathers every cross-layer import edge under `src/<layer>/` and asserts it against the `ALLOWED_IMPORTS` DAG in `scripts/layers.ts`. Catches type-only, dynamic, and re-export escapes. Runs in CI ahead of `biome ci`, and again inside `npm test` via `tests/boundaries.test.ts` (which also unit-tests the checker itself).
2. **Secondary:** Biome `noRestrictedImports` — external-package bans the edge checker doesn't see: `three`/`three/**` error everywhere except `src/render/**` (override re-allows render).
3. **Deferred:** pnpm workspaces — install-time rejection of undeclared cross-package imports; arrives only if the package split ever happens (§Package shape).

```
schema       Zod, registry, units, aliases, selections — the root, depends on nothing
containers   FieldDataset, ParticleData, TabularData, StaggerInfo, GridInfo (pypic.containers + .dataset)
coordinates  curl, div, grad, transforms, GeometryType (pypic.coordinates)
numerics     interp (trilinear, tricubic), integrators (RK4, Dormand-Prince 5(4) + I step control)
reductions   reduce() (pypic.reductions); Reduction literal re-exported from schema (§Data layer)
derived      recipe-math (|B|, beta, v_A, …) (pypic.derived)
diagnostics  div_B, div_E, field_energy (pypic.diagnostics) — reserved
shaders      WGSL string assets (WESL-ready; §Shader sharing)
gpu          GPUDevice, capabilities, device.lost
compute      dispatcher + backends + recipe registry (pypic.compute); can chain a reduction onto a recipe
data         readers (stackable protocols), writers, prefetch, cache; round-trips attrs.reduction
remote       pypic.server client, ReductionSpec wire type — reserved
render       Three.js WebGPURenderer + WGSL passes
store        reactive state; canonical names as keys
ui           no direct render imports; theming is @schema/theme + ui/theme/ (not a layer)
app          composition root — imports everything
workers      no DOM, no THREE, no GPUDevice
embed        public lib surface; re-export facade only, never render/ui/app/store/remote
```

The **edges** are `ALLOWED_IMPORTS` in `scripts/layers.ts` — the single authority, and the only place
they are written down. A reserved layer's row carries the reason its edges are held open.

**Hard rules**
- `coordinates/` and `numerics/` use typed arrays + `Vec3 = readonly [number, number, number]`. No `THREE.Vector3`, and **no external math dep** — the planned `gl-matrix` adoption proved unnecessary (both layers shipped dependency-free in v0.1; adopt only if a future kernel demonstrates the need).
- `compute/` returns typed arrays packaged in `FieldDataset`-shaped values from `@webpic/containers`. Wrapping into `THREE.DataTexture`/`GPUTexture` is the render layer's job.
- `derived/` is pure functions over fields (mirrors `pypic.derived`). No backend awareness. `compute/` registers recipes from `derived/`; `derived/` does not import `compute/`.
- **Single TS reference impl per operator.** `compute/backends/ts/field.curl` delegates to `coordinates/operators/curl` rather than reimplementing — same for `divergence` and `gradient`; `field.magnitude` delegates likewise but to `derived/magnitude` (magnitude is a `derived/` recipe, not a `coordinates/` operator). Cross-backend equivalence tests then compare `coordinates.curl` against the WGSL kernel in `compute/backends/webgpu/`, not against a duplicate TS-side curl.
- `gpu/` owns the singleton `GPUDevice`. Both `compute/backends/webgpu/` and `render/` import from it. `gpu/` owns `device.lost` recovery and capability probing.
- `ui/` talks to `render` only through `store` intents. UI never calls `scene.add(...)`.
- `data/` produces canonical-named typed-array payloads in `FieldDataset` containers; it does not know what's plotted.
- **WebGPU backend runs inline on main thread** (`GPUDevice` can't transfer to workers). TS/WASM backends are *designed* to run in a `comlink`-backed worker pool; v0.1 runs the single TS backend synchronously on the main thread (one cheap `|B|` op), and the pool lands when compute gets heavy (M3+). The dispatcher routes based on selected backend.
- Boundary violations are CI errors.

### First load walkthrough

1. User pastes a Zarr URL → `app/bootstrap.ts`'s `bootstrap()` probes WebGPU + acquires a `GPUDevice` (or shows the requires-WebGPU page).
2. Hardcoded heuristics seed the dispatcher; OPFS-cached scores for a known GPU adapter restore instantly, else background calibration kicks off.
3. `data.worker.ts` fetches `simulation.toml`; Zod validates against the canonical schema.
4. `simulationStore` populated with dataset metadata, timesteps, and fields.
5. User clicks `B_1` → `computeField('|B|', dataset, ctx)` resolves through the dispatcher (TS backend wins while calibration runs).
6. Returned `Float32Array` transfers via dedicated `MessageChannel` to `render.worker.ts` → `device.queue.writeTexture` → `texture_3d<r32float>` (`r16float` fallback when `float32-filterable` is absent).
7. Next frame paints volume + 3 slices.

Example `simulationStore` shape:

```ts
type SimulationState = {
  dataset: { id: string; reader: 'zarr' | 'hdf5' | 'parquet'; handle: DataHandle } | null;
  step: number;
  activeField: FieldName;
  normalization: 'pic' | 'mhd' | 'si';
  comparisonTarget: SimulationState | null;
};
```

### Package shape

**Single package, `src/<layer>/` from day one.** v0.1 ships as one package whose source is split into `src/<layer>/` folders named per the DAG above; `scripts/check-boundaries.ts` enforces the layer boundaries on those directories. Path aliases (`@schema/*`, `@compute/*`, …) stand in for the eventual `@webpic/<layer>` package specifiers, so the workspace split is a mechanical lift later. The pnpm-workspace / `@webpic/<name>` packaging is **deferred** (M2.14, reaffirmed at M6 close) — see the decision below (stay single-package; if ever split, collapse the math-y layers into one `@webpic/core` rather than promoting all 18).

> **Trade-off acknowledged.** 18 packages is heavy for a single-dev browser app.
> - **Benefit:** defense-in-depth on layer enforcement (pnpm rejects undeclared cross-package imports at install).
> - **Costs:** inter-package version drift, slower install, `package.json` boilerplate, publish-flow complexity.
> - **Decided at M2 (M2.14): stay single-package for v0.1.** The DAG is already enforced three ways — `scripts/check-boundaries.ts` (ts-morph), Biome `noRestrictedImports`, and `tests/boundaries.test.ts` — so a workspace split buys only install-time enforcement at the cost of 18 `package.json` files, several for 3-line leaf layers (`coordinates`, `reductions`, `diagnostics`, `shaders`) with no external consumer yet. **Revisited at M6 close (2026-07-03): stayed single-package.** `@webpic/embed` shipped from the single package via `vite.embed.config.ts` + `size-limit` (M6.6 TypeDoc, M6.7 budget) — publishing needed a build target, not a package boundary. Next trigger: an actual npm publish of `@webpic/embed`, or a first external consumer. **If it ever splits, collapse to coarse packages** — one `@webpic/core` for the math-y mirror layers (`containers`, `coordinates`, `numerics`, `reductions`, `derived`, `diagnostics`; same external dep surface, ship together), plus `@webpic/app` and `@webpic/embed` — not 18. `check-boundaries.ts` keeps enforcing `src/<layer>/` dirs within the single package either way.

A `// packages/<layer>/src/…` header in a later code block names the eventual `@webpic/<layer>` *target* path; the same module lives under `src/<layer>/` today, and the path aliases (`@schema/*`, `@compute/*`, …) bridge the two.

```
src/<layer>/            one folder per DAG row; a layer's root holds its infrastructure and its
                        surfaces live in folders named for what they are (CLAUDE.md §Architecture)
scripts/                codegen, the boundary checker, and the headed-Chrome instruments
tests/                  cross-layer meta-guards + shared fixtures — anything importing vitest
docs/                   DESIGN.md (this file), cleanup.md, generated api/
```

`ls src/` is the current inventory; this section is the *shape*, not a manifest. Layer contents are
the DAG list above; the files worth naming are in §Critical files & references.

#### Public library export

The `@webpic/embed` surface: `schema/*`, `containers/*`, `coordinates/*`, `numerics/*`, `reductions/*`, `compute/{dispatcher,recipes,compute_field,trace_field}`, `derived/*`, `diagnostics/*`, `data/{readers,writers}` (writers joined the surface with the M6 Zarr writer — a headless analyzer persists derived fields). Does **not** export `render`, `ui`, `app`, `store`, `remote/client` — a downstream Jupyter widget imports the math + data layers without dragging in Three.js. The facade is `src/embed/index.ts` (star-exports over the layer barrels / curated modules; `tests/embed.test.ts` guards against ES's silent ambiguous-star-export drops); TypeDoc (`npm run docs:api`, `treatWarningsAsErrors`) documents exactly this surface. Bundle budgets enforced by `size-limit` (see §Deferred but tracked).

---

## Schema sharing with pypic

**Codegen via `pypic export bundle`** (root model `pypic.schema._models.SimulationSchema`, `SCHEMA_VERSION = "1.0"`; driven by `npm run gen` = `gen:export` then `gen:emit`):
- `pypic export bundle --inline-single-use-defs --include-x-extensions` emits one schema+aliases+recipes bundle to `src/schema/pypic-export.generated.json` (`--inline-single-use-defs` flattens `$defs` for json-schema-to-zod; `--include-x-extensions` keeps patternProperties for `x-*`).
- `scripts/codegen/bundle.ts` prefers the CLI (`uv run --project ../pypic`) when pypic is available; `scripts/codegen/emit.ts` renders the checked-in TS from the bundle.
- Emits Zod (json-schema-to-zod); TS types flow from `z.infer` of the Zod — no separate json-schema-to-typescript pass.
- Checked-in outputs (so webpic builds without Python): `src/schema/{validators,aliases,registry}.generated.ts`, `src/compute/recipes.generated.ts`.

**Drift detection.** Three tiers; breaking changes force a release, additive bumps don't:
- CLI diff (`pypic schema diff` in CI) flags additive vs breaking.
- Semantic-parity test: every pypic fixture validates against both regenerated and checked-in Zod.
- Additive-compat test: current fixtures vs prior N schemas.

**Canonical-name discipline.** `schema/registry.ts` is the *only* label→canonical mapping. Store keys, kernel inputs, remote API params, shader uniforms all use canonical names — `grep B_1` works across all three projects. Aliases resolve at boundaries only (see *Aliases & registry keys*).

**Schema versioning.** `SCHEMA_VERSION = "1.0"` is the single truth (pypic v1.x additive-only; breaking → v2.0). Every persisted artifact (OPFS field cache, calibration cache, exported Zarr, saved themes) carries a `schemaVersion` tag; loader has an explicit `migrate(oldVersion, newVersion)` hook (no-op for additive, code for breaking).

### Run metadata

**`attrs.run` over `attrs.simulation_toml`** (Zarr root carries both; schema.md §4.2):
- **Prefer `attrs.run`** — JSON-mode `Run.model_dump`, typed fields (`name`, `doi`, `license`, `authors`, `git_sha`, `host`, `funding`, `embargo`, `resources`, `ensemble`, …) — for everything the FieldDataset boundary preserves.
- **Fall back to `attrs.simulation_toml`** (verbatim source TOML, re-parsed smol-toml → same Zod) only for sections that don't survive that boundary: `[bodies]`, `[drivers]`, `[output.*]`, `[restart]`, `[[probes]]`, `[[collisions]]`, `[phase_space]`, `x-<code>`. Heavier path — reach for it only when those orphan sections are needed.

**Bundle split.** `@webpic/embed` uses `zod/v4-mini` (~1.9 KB); `@webpic/app` uses full zod (~50 KB) for richer errors — saves ~48 KB on embed.

**Reduction Literal sourcing.** The `Reduction` Literal (10 ops, see §"Reduction provenance round-trip") originates in `@webpic/schema` (`schema/src/selections.ts`), beside `Box`/`Plane`/`SphereSelection` — schema is the dependency root, so codegen consumers find it there.
- `@webpic/reductions` re-exports it for locality next to `reduce()`.
- Downstream (`@webpic/remote/src/protocol.ts`, `@webpic/data`) import `Reduction` from `@webpic/schema` directly to build `ReductionSpec`.
- Origin-in-the-root keeps the DAG acyclic (`reductions ──► schema`, never reverse).

**Local selections vs wire specs — deliberately distinct, thin map at the remote boundary; don't conflate:**
- `Box`/`Plane`/`SphereSelection` (`@webpic/schema`, mirror `pypic.selections`) — local on-disk/compute shapes.
- `Box`/`Plane`/`SphereSpec` (`@webpic/remote`, mirror `pypic.server.protocol`) — wire shapes.

**Runtime parser stack**
- TOML: `smol-toml` (TOML 1.0 compliant, ESM, ~7 KB)
- Validator: `zod/v4-mini` (embed) / `zod` v4 (app)

### Aliases & registry keys

Canonical registry keys (short: `'|B|'`, `'beta'`, `'v_A'`, `'omega_p_s0'`, `'e_B'`, `'div_B'`, …) live in `pypic.compute.RECIPES` and codegen into `recipes.generated.ts`. Descriptive aliases (`'plasma_beta'` → `'beta'`, `'alfven_speed'` → `'v_A'`, `'B_mag'` → `'|B|'`, …) come from `pypic.aliases.COMPUTE_ALIASES` → `aliases.generated.ts`. Magnitudes use literal pipes (`'|B|'`, not `'B_mag'`). Per-species suffix `_s(\d+)(_<modifier>)?` (`pypic.aliases.SPECIES_SUFFIX_RE`) mirrored in TS for runtime expansion.

**Naming rules.** File names in `@webpic/derived` mirror `pypic.derived` function names for grep parity, but each recipe registers under the canonical short key. **Aliases resolve at boundaries only** — store keys, kernel inputs, wire types, shader uniforms all use canonical names. **Component indexing:** field names 1-indexed (`B_1`); `Recipe.component` 0-indexed for array slicing (`pypic/compute.py:107` builds `name_tmpl.format(c=c+1)` → `Recipe(…, component=c)`; field declared `:66`).

**e/i aliases resolve at boundaries only.** `Pe → P_s0`, `Pi → P_s1`, etc. *are* in `pypic.aliases.COMPUTE_ALIASES` (`pypic/_aliases.py` — cite by symbol; its line numbers drift), but only as convenience aliases for the read/remote boundary — never store keys, wire types, or shader uniforms. webpic codegen, on-disk stores, and wire types use the numbered canonical form (`P_s0`); the `e`/`i` spellings resolve to it at the boundary, like every other alias. (Vector-group prefix shortcuts such as `EFe` live in the separate `GROUP_ALIASES` in the same module.)

---

## Compute dispatcher

A single facade with pluggable backends. Cancellation via `AbortSignal` from day one — essential for streamline integration (user clicks elsewhere mid-trace).

```ts
// packages/compute/src/kernels.ts
export type ComputeKernels = {
  'field.magnitude':   { input: VectorField3D; output: ScalarField3D };
  'field.curl':        { input: VectorField3D; output: VectorField3D };
  'field.divergence':  { input: VectorField3D; output: ScalarField3D };
  'derived.plasma_beta': { input: { p: ScalarField3D; b: VectorField3D }; output: ScalarField3D };
  'trace.streamline':  { input: StreamlineRequest;  output: StreamlineResult  };
  'particle.histogram':{ input: ParticleData;       output: Histogram         };
};

export type ComputeEvent<O> =
  | { kind: 'progress'; pct: number; partial?: O }
  | { kind: 'result';   value: O };

export interface Backend {
  readonly id: 'ts' | 'wasm' | 'webgpu';
  readonly available: boolean;
  supports<K extends KernelName>(kernel: K): boolean;
  run<K extends KernelName>(
    kernel: K,
    input: ComputeKernels[K]['input'],
    ctx: ComputeContext & { signal: AbortSignal },
  ): AsyncIterable<ComputeEvent<ComputeKernels[K]['output']>>;
}

// Promise primitive (90% case)
export function compute<K extends KernelName>(
  kernel: K, input: ComputeKernels[K]['input'],
  ctx?: Partial<ComputeContext> & {
    signal?: AbortSignal;
    onProgress?: (pct: number, partial?: ComputeKernels[K]['output']) => void;
  },
): Promise<ComputeKernels[K]['output']>;

// Iterator (streamline-style partial-result consumers)
export function computeIter<K extends KernelName>(
  kernel: K, input: ComputeKernels[K]['input'],
  ctx?: Partial<ComputeContext> & { signal?: AbortSignal },
): AsyncIterable<ComputeEvent<ComputeKernels[K]['output']>>;
```

**Recipe registry** (mirrors `pypic.compute.RECIPES` + the public `pypic.compute.Recipe` dataclass):
- `compute/recipes.ts` maps canonical names (`|B|`, `beta`, `v_A`) → functions in `@webpic/derived` + dispatch hints.
- `recipes.generated.ts` is codegen'd from pypic's registry (keys, dependencies, flags); recipe *bodies* stay hand-written in `@webpic/derived`.
- The TS `Recipe` shape mirrors pypic's field-for-field:

```ts
// packages/compute/src/recipes.ts
export type Recipe = {
  func: (...args: ArrayLike<number>[]) => Float32Array | Float64Array;
  fields: readonly FieldName[];          // canonical input field names
  speciesIndex?: number;                  // for per-species templates (s0, s1, …)
  needsGrid?: boolean;                    // injects (dx, dy, dz)
  needsGamma?: boolean;                   // injects adiabatic index
  needsC?: boolean;                       // injects speed of light (relativistic)
  component?: 0 | 1 | 2;                  // 0-indexed; name uses 1-indexed (B_1 ↔ component=0)
  speciesArgs?: SpeciesArgs;              // injects charge/mass
  passesGeometry?: boolean;               // injects GeometryType for coordinate-aware ops
  supportsRelativistic?: boolean;         // recipe has optional c= kwarg
};

export function registerRecipe(name: string, recipe: Recipe): void;
export function unregisterRecipe(name: string): void;
export function availableQuantities(): string[];                  // mirrors pypic.compute.available_quantities()
export function recipeDependencies(name: string): Set<string>;    // mirrors pypic.compute.field_dependencies()

// Public surface (mirrors pypic.compute.compute_field):
await computeField('|B|', dataset, ctx?);

// Internal memoization layer behind computeField (one cache, not two):
// _recipes.get(name, { datasetId, step, structuredHash(params) })
//   - Memo key: (recipeName, datasetId, step, structuredHash(params))
//   - Invalidation: counter bumped by store mutations; recompute on next pull
//   - Params hashed via inline FNV-1a; stable-stringify first (xxhash-wasm not a v0.1 dep)
// Not exported from @webpic/compute's barrel. Callers only see computeField.
```

- **Selection policy.** `ctx.prefer` overrides; else per-kernel scores from `calibration.ts`. Heuristic exceptions for driver pathologies (e.g. `vendor === 'apple' && size < 1<<14` → avoid webgpu for tiny kernels). Local backends only — remote streaming emits `FieldDataset` into `@webpic/data`, not kernel-level dispatch.
- **Worker routing.** `GPUDevice` can't transfer, so `webgpu` runs inline on main; `ts`/`wasm` are designed to dispatch to a `comlink` pool sized `Math.min(hardwareConcurrency - 1, 8)` (cap avoids thrashing render/data workers), with transferable typed arrays + SharedArrayBuffer when COOP/COEP set. **v0.1 reality:** the only worker is `data.worker.ts` (OPFS writes, raw `postMessage`); TS compute runs inline on main until an op is heavy enough to need the pool.
- **Boundary discipline.** Callers get a `Float32Array`; backends marshal internally.
- **Cross-backend equivalence.** Every kernel runs `ts` and (when available) `webgpu`, asserting agreement within per-kernel per-precision tolerance (see §Testing).

---

## Worker message protocol

The render wire lives in `src/render/messages.ts` — two discriminated unions, each carrying `requestId` for response correlation (and to pre-stage cancellation):

- **`RenderWorkerRequest`** (main → render worker) — `init` · `renderFrame` · `resize` · `upsertLayer`/`upsertFieldlines`/`removeLayer`/`setLayerOrder` (the instance-first layer channel) · `setLayerColormap`/`setLayerShading`/`setSliceParams` (live per-layer appearance) · `setCameraPose`/`setProjection`/`setCameraMotion` (high-frequency, delta-only via Zustand `subscribeWithSelector`) · `setSceneOverlay`/`setMarker`/`setPickerPoint`/`pickRay` · `setContinuous`/`setPerfActive` (timing + the dev HUD) · `pair` (the streaming port) · `screenshot` · `rebuildShader` (dev HMR) · `dispose` (orderly teardown before `terminate()`).
- **`RenderWorkerResponse`** (render worker → main) — `ready` · `frame` (RGBA8 readback) · `frameTiming` · `perfSample` · `pickResult` · `layerCompiled` (the pipeline-warm ack that drops the loading pill) · `screenshot` · `error` · `gpuRecoveryFailed` · `disposed`.

Both sides are exhaustive: the worker's `handle()` and the app's response router each end in a `never` arm, so an added kind is a compile error until routed. `upsertLayer` carries its kind-specific build params nested as `params: FieldLayerParams` (discriminated on `layerKind`: a slice's axis + plane, a volume's march/look/box aspect) — a slice never sees volume fields and vice versa. Field array buffers ride `upsertLayer` as transferred `ArrayBuffer`s; the transfer detaches the store's copy, which is why `app/layerBridge` — not the store — decides when a later layer needs a `recomputeField`.

**Worker-to-worker pairing (built — M2.10).** `app/streamingBridge.ts` pairs the data and render workers over a `MessageChannel`: the data-side port rides the `open` request, the render-side port rides `pair` on the render worker's `ready`, and each scrubbed timestep's scalar flows data → render with no main-thread hop (`data/streamMessages.ts` is that wire). Main relays only the timestep domain and drives the cursor + active field. `render/worker.streaming.test.ts` covers the ping-pong swap; `data/cache.browser.test.ts` the OPFS side.

---

## Rendering pipeline

### Renderer
- **`THREE.WebGPURenderer`** (`three/webgpu`) — **pinned to `three@0.185.1`**, not a floating `r172+` range; bump the pin deliberately, with the full GPU gate. r179 broke OffscreenCanvas-in-worker (#31605); PR-#31607 fixed it (guards `HTMLVideoElement instanceof` with a `typeof … !== 'undefined'` presence check) and first shipped in r180/`0.180.0`; `0.185.1` still carries it (worker-frame parity smoke green on bump). Canonical pin reference for the whole doc. CI smoke asserts worker-frame vs main-frame within 1 px.
- **OffscreenCanvas-on-Worker from day one.** `render/worker.ts` owns canvas + scene + renderer; `app/bootstrap.ts` transfers via `transferControlToOffscreen()`; talks to `store/` via `MessageChannel`.
- **Raw `GPUComputePassEncoder` pipelines** owned by `compute/backends/webgpu/`; shared kernels in `@webpic/shaders`.
- Frame timing is wall-clock: `render/runtime/frameTimer.ts`, gated to continuous mode. `gpu/profiler.ts` carries the `GPUQuerySet`/`timestamp-query` path `STAGED:` — render-pass timestamps lost the Metal device and were removed.
- **`device.lost` recovery** (`gpu/device.ts`): rebuild `compute/` + `render/` from OPFS-cached source, restore scene from `store/`. UX: canvas freezes on last frame; "GPU was reset; recovering…" banner with elapsed seconds; UI stays interactive (Zustand survives in main); 200 ms fade-in on recovery; OPFS-evicted fields marked "unavailable, refetching" — never silent.
- Memory pressure: interaction-time pressure scales the swapchain render scale (`render/runtime/qualityController.ts`), not texture resolution. Big allocations report bytes to `gpu/vramLedger.ts`.
- Boot: `main.ts` shows a blocking "requires WebGPU" banner naming the supported browsers when `navigator.gpu` is absent, and the same banner (with a reload) when adapter/device acquisition fails before the first frame. There is no WebGL fallback.
- **Pipeline compile:** `renderer.compileAsync(scene, camera)` (the renderer method — there is no `material.compileAsync`) warms each heavy scene's pipeline before its first `renderOnce`, off the critical path, so first frame doesn't hitch on driver compile. "At boot" only if a default dataset auto-loads — `worker.ts:init()` builds just the triangle at startup, so the warm hangs off `upsertLayer` (the volume/slice layer-build seam). Streamlines/particles compile lazily on toggle. First-frame: <500 ms cold, <100 ms warm. (Dev-only shader HMR is a separate concern — see §Build system & tooling / §Milestones M2 (M2.13); it ships nothing in the prod bundle.)

### Volume rendering
Single-pass WGSL fragment raymarcher; gradient + Phong from M2. The fixed-step march is the only path.

- Front-face of bbox → analytic ray-box → march in normalized data space; early termination at α ≥ 0.98.
- **Empty-space skipping was built, measured 1.7× slower on the representative space-filling `|B|`, and removed** (git `27acce5`). A coarse per-brick max grid (nearest-sampled `r32float`) skipped transparent bricks and snapped back onto the fixed lattice, so it was output-equivalent — but a space-filling turbulent field has almost no skippable brick, and every step still paid the skip-grid fetch + branch. It only wins on genuinely sparse data (vacuum, isolated ropes, magnetosphere lobes); the levers that would move the gate are step count, resolution cap, and LOD.
- Transfer function: 256×1 `texture_2d<rgba16float>`, re-baked on colormap (and scale) change; window/level applies via shader uniforms (`uCenter`/`uWidth` in `normalization.ts`), so a window drag never re-bakes the LUT.
- **Gradient + Phong** via central differences (~20 lines WGSL, M2) — major shape-perception win on plasma blobs. Ships as a **toggle**, off by default for quantitative work: the lit "surface" is a TF-dependent opacity isosurface, not a physical boundary. The 6 taps/step aren't free on a 256-step march — gate the gradient on sample opacity or precompute a gradient volume so it doesn't eat the 8 ms budget. Render-local lighting normal, deliberately *not* `coordinates/operators/gradient` (the physics operator) — don't dedupe them.
- Volume texture: **`r32float` preferred** (when `float32-filterable` is present — the Metal-stable trilinear path; `r16float`+linear sampling loses the device on some Metal drivers, so f16 trilinear is *not* the default), **`r16float` fallback** (core-filterable). No `r8unorm` path. The format is chosen by `float32-filterable`, *not* `shader-f16` — that feature is the in-shader `f16` ALU type, not a texture format, and is unused here. (The f16/f32 dual path for *compute* kernels is a separate TS-templating concern; see §Shader sharing.)
- `NodeMaterial` wrapping hand-written WGSL via TSL's `wgslFn` escape hatch. Parallel raw-WebGPU raymarcher behind a flag as top-risk fallback.

### Slicing
- Three orthogonal `Mesh`es with `NodeMaterial` sampling the shared `uVolume`. Position is a uniform `f32` in [0..1]. **MPR is free** — no CPU resampling like magviz did.
- Oblique clip planes via fragment `discard` keyed off a uniform `vec4` plane equation (v0.2).
- Slab MIP/mean: variant material with slab half-thickness `T`, 16–32 samples slab-normal. Reduction (max/mean/composite) picked by material define so we get three compiled pipelines, not branchy uniforms. *(Note: "slab MIP" here is the standard volume-rendering term for a thick maximum-intensity projection along a view ray — distinct from `pypic.reductions.reduce`, which is a data-side operation. The two never alias on the wire.)*

### Field lines
**Primary: GPU compute streamlines, WGSL kernel shared with rustpic (eventually).**
- Seed buffer `array<vec4<f32>>` (xyz + arclength); compute shader Dormand-Prince 5(4) with I (elementary) step control (`i_step_controller`), one invocation per seed. The WGSL kernel mirrors pypic's `dormand_prince_step` + `i_step_controller` scheme-for-scheme so M4 golden-trace parity holds at tight numeric tolerance (a PI controller would diverge from the goldens — pypic reserves PI behind an `err_prev` kwarg but ships I).
- Writes to vertex buffer + segment-count buffer.
- Render with `Line2`/`LineSegments2` via indirect draw. No CPU readback per frame.
- **Vector field lookup is a manual trilinear read of three storage buffers**, not `textureSampleLevel` on a packed `texture_3d`: the hand-written blend reproduces the f64 reference's operation order exactly, so the only GPU/CPU gap is f32 roundoff, while hardware sampling has implementation-defined sub-texel rounding that would put the trace tolerance at risk. Sampling is cell-centered (the −0.5 index map), row-major `(i·ny + j)·nz + k`.
- **The WGSL kernel is a line-for-line transliteration of the f64 reference**, which is what holds GPU ≡ CPU ≡ pypic golden parity at f32 tolerance:

  | WGSL (`shaders/kernels/streamline.wgsl.ts`) | TS reference |
  |---|---|
  | `sampleField` | `numerics/interp.ts` `sample`/`blend` |
  | `rhs` | `numerics/tracing.ts` `makeRhs` (unit field direction, sign-bearing; null on exit/null) |
  | `dpStep` | `numerics/integrators.ts` `dormandPrinceStep` (7-stage FSAL, exact tableau fractions) |
  | `errorNorm` | `numerics/integrators.ts` `embeddedErrorNorm` |
  | `iController` | `numerics/integrators.ts` `iStepController` |
  | `streamline_main` | `numerics/tracing.ts` `traceSingleDirectionAdaptive` |

  The `"both"`/backward stitch and `FieldLine` assembly stay on the CPU — the GPU orchestrator reuses `tracing.ts` `stitch`.
- Cancellable via `AbortSignal` through the dispatcher.
- **Which vector a layer traces** follows the layer's displayed field: `compute/vectorComponentsForField` maps a magnitude to its stored components through `RECIPES` (`|B|` → `B_1/B_2/B_3`, `|E|` → `E_1/E_2/E_3`), falling back to B when the field names no stored vector. A perpendicular magnitude resolves to its unprojected family (`|E_perp|` → E) — the vector actually stored; tracing derived vectors (`curl_B_*`) waits for on-the-fly component compute.
- **Seed failure is per seed, not per batch.** `numerics/tracing` keeps pypic's strict validate-then-throw batch (`onInvalidSeed: "throw"`); the `compute/traceField` facade partitions seeds, traces the rest, and reports the dropped ones — a field null (a masked planetary interior, a reconnection X-line) must cost one line, not the layer. The store surfaces the tally per layer (`traceNotices`) rather than a console warning.
- Traces that will be *drawn* refine `max_step` to ~2% of the domain diagonal (`displayTraceSteps`), never coarser than pypic's default — a rendering choice kept out of the pypic-mirroring defaults.

**Secondary: LIC (Line Integral Convolution) for dense 2D slice flow viz (v0.2).** Separate compute pass writes a 2D LIC texture from vector field sampled along a slice plane.

### Particles (v0.2)
- Instanced 2-tri billboard quads via `InstancedMesh`.
- GPU-driven culling: compute pre-pass writes `drawIndexedIndirect` list of visible instances.
- Density-binning fallback at >5×10⁶ visible per snapshot.
- `particleAccessMode: 'snapshot' | 'sampled' | 'aggregated' | 'sql'` — explicit enum. DuckDB-wasm (~6–10 MB gzipped via ducklings minimal build) is `await import('@duckdb/duckdb-wasm')` **only** in `sql` mode. Extensions lazy-load from CDN at runtime.

### Coordinate systems
- All data stays in code units (normalized PIC or MHD per pypic conventions).
- A single data↔world mapping per dataset — the pure typed-array `gridToWorld`/`worldToGrid` bijection in `store/interaction/seedPick` (no matrix dep; the planned gl-matrix `Matrix4` was never needed). Volume bounding box is always a unit cube in *data* space.
- Spherical/cylindrical (post-v1.0): keep texture indexed by (r, θ, φ); raymarcher converts world-space sample position inside the fragment.

### Time-series playback
Streaming is mandatory at 256³ (~64 MiB/field/step as a decoded `Float32Array`; ring depth N≈1–5 per §Performance gate (GPU memory) — can't hold 256), so "scrub without stalls" is a perf-gate clause, not a nicety. **Prerequisite chain:** the reader substrate is ready (`readTimestep`/`availableTimesteps`), but the store has no time cursor yet — it gains `currentStep`/`availableSteps` + a `setStep` intent, and `ui` a scrub `RangeControl`, before prefetch has anything to track.

**Necessary core** (what passes the gate): ring buffer of N steps around cursor + prefetch ±1 + double-buffered GPU upload. Two workers: predict/read in `data.worker.ts`, transfer the decoded buffer over the `MessagePort` (§Worker message protocol), ping-pong two `Data3DTexture`s in the render worker. The ring vs CLAUDE.md's "transfer, don't clone" tension resolves as: hold until upload, transfer on upload (the buffer detaches), re-read evicted steps from the OPFS cache on scrub-back.

**Profile-then-tune prediction** (`data/prefetch.ts`, added only if dumb ±1 stalls — "profile before tuning"): direction from EWMA of recent step deltas (window=8, α=0.7); magnitude → prefetch count (1–5); 250 ms debounce on flips; stationary (2 s) → drop EWMA, prefetch ±1. Fuzz scrubber in `src/data/prefetch.test.ts`.

### Performance gate (not a budget)

**Canonical definition of the perf gate** (other sections cross-ref here). Numbers are per-frame GPU time, single pass, M2 Pro Chrome stable.
- **8 ms** = per-frame raymarch budget on a 256³ volume at any single timestep.
- **"256 steps"** = dataset depth on disk; the ring buffer holds only N≈1–5 prefetched steps around the cursor (see §Time-series playback), not all 256.

| Element                       | M2 gate (256³ volume, 256-step dataset) | Stretch (512³, 256-step, v0.2) |
|-------------------------------|----------------------------------------:|-------------------------------:|
| Volume raymarch (per frame)   | ≤ 8 ms                                  | ≤ 8 ms with LOD bricks         |
| Slices (3 MPR, per frame)     | ≤ 0.5 ms                                | ≤ 0.5 ms                       |
| Streamlines (10⁴ seeds, M4)   | ≤ 2 ms                                  | ≤ 2 ms                         |
| Compute (derived on change)   | ≤ 1 ms                                  | ≤ 1 ms                         |

**Rule:** if 256³ at 256-step depth doesn't hit 8 ms/frame on the volume raymarch by end of M2, defer 512³ to v0.2 with LOD bricks. Measure with `render/runtime/frameTimer.ts` (wall clock around `onSubmittedWorkDone()`).

**GPU memory:** 256³ × 6 fields × `r32float` ≈ 384 MiB (`r16float` fallback ≈ 192 MiB); 512³ × 6 × `r16float` ≈ 1.5 GiB. A single 256³ field is 64 MiB at `r32float` (32 MiB at `r16float`); the decoded CPU ring buffer (`Float32Array`, §Time-series playback) and the resident GPU texture are distinct allocations. Resident GPU is several× the single-timestep figure (× ring depth N≈1–5, + min-max grid, + TF texture) — which forces 256³ preview + LOD bricks for anything larger.

---

## Data layer

### Reader protocols (mirrors pypic's stackable `SimulationReader` family)

pypic exposes a base `SimulationReader` + three opt-in protocols at `pypic/readers/_protocols.py:15-110`. webpic mirrors the same shape — readers compose by implementing whichever protocols they support. No inheritance; structural typing matches.

```ts
// packages/data/src/readers/_protocols.ts
export interface SimulationReader {
  readonly id: string;
  readTimestep(handle: DataHandle, step: number,
               options?: { fields?: FieldName[] }): Promise<FieldDataset>;
  availableTimesteps(handle: DataHandle): Promise<number[]>;
}

export interface FieldListingReader {
  availableFields(handle: DataHandle, step: number): Promise<FieldName[]>;
  availableFieldsMapping(handle: DataHandle, step: number): Promise<Record<string, string | null>>;
  // canonical name → native (on-disk) name, or null for synthesized fields
}

export interface ParticleDataReader {
  availableParticleSteps(handle: DataHandle): Promise<number[]>;
  readParticles(handle: DataHandle, step: number, species: SpeciesIdx,
                options?: { columns?: string[] }): Promise<ParticleData>;
}

export interface AuxiliaryDataReader {
  availableAuxiliary(handle: DataHandle): Promise<string[]>;
  loadAuxiliary(handle: DataHandle, name: string): Promise<TabularData>;
}

// Registry-side dispatch (mirrors pypic.readers._registry / pypic.readers.Simulation)
export function registerReader(reader: SimulationReader,
                                confidence: (h: DataHandle) => Promise<number>): () => void; // disposer
export function openSimulation(handle: DataHandle): Promise<SimulationReader>;
// (selective-read is expressed per call via readTimestep's `fields?` option, not a reader predicate.)
```

- `canRead` confidence belongs to the **registry**, not the reader (matches `pypic.readers._registry.can_read_confidence`). Readers stay protocol-shaped; registration carries the probe function.
- Subregion reads happen via `readTimestep(handle, step, { fields: [...], region: BoxSelection })` (`region` extends the options bag with selections from `@webpic/schema`).
- Config loading lives in `packages/data/src/config.ts` + `packages/schema/src/toml.ts` (mirrors `pypic.readers.config`).

### Formats
- **Zarr v3** — `zarrita.js`; primary working format (v0.1).
- **HDF5** — `h5wasm` for legacy reads (v0.2).
- **Parquet** — `hyparquet` for particles (v0.2).
- **Arrow** — `apache-arrow` for in-memory exchange.
- **DuckDB** — `@duckdb/duckdb-wasm` dynamic import only when `particleAccessMode === 'sql'`.

### Caching
- **OPFS** preferred; **IndexedDB** fallback.
- Cache key: `(reader, source-URL, step, field, chunk-coords, schemaVersion)`.
- LRU eviction with configurable budget (default 1 GB).
- **Worker-confined writes (canonical):** all cache writes happen in `data.worker.ts` via `createSyncAccessHandle()` — the synchronous fast path, which is worker-only in every engine. Main thread only issues read requests. *(Safari <26 additionally lacked `createWritable()` entirely, making the worker path mandatory there; Safari 26+ (GA Sept 2025) added it on the main thread, but the worker/sync-handle path stays preferred for perf and covers the Safari 18.x tail.)*
- **Multi-tab safety:** `navigator.locks.request('webpic-cache', { mode: 'exclusive' })` around cache writes. Losing tab degrades to read-only with UI banner.
- **Calibration cache (separate namespace):** per-kernel backend scores from `calibration.ts` persist under key `(adapterKey, calibrationVersion, schemaVersion)`, where `adapterKey = GPUAdapterInfo.{vendor, architecture}` — coarse by design (browsers mask finer fields to limit fingerprinting), but a vendor+architecture bucket has stable crossover behavior. Warm start on a known adapter loads scores and **skips the microbench**; miss/stale → seed heuristics + background bench + write-back. Written via `data.worker.ts` like all OPFS writes (the bench itself runs `webgpu` timings on main + `ts` timings in the pool, then hands the aggregated blob to the writer). `calibrationVersion` bumps whenever kernel code or bench methodology changes — timings are otherwise silently stale.

### Subregion streaming
A `BoxSelection` from `@webpic/schema` (mirrors `pypic.selections.BoxSelection`) lets callers fetch axis-aligned subregions of a field without pulling the full 3D array. Passed to `readTimestep(handle, step, { fields, region })`. Zarr v3 native; HDF5 via hyperslab; Parquet via row-group + min-max stats. (Reducing a subregion onto a 2-D surface — column densities, LOS integrals — is a separate concern owned by `@webpic/reductions` and the remote `ReductionSpec`; see §"Reduction provenance round-trip".)

### Writers (M6)
Zarr v3 writer only — for caching derived fields and exporting simulation modifications. Screenshot export via `canvas.toBlob('image/png')`. Video export (WebCodecs `VideoEncoder` + `MediaStreamTrackProcessor`) deferred to v0.2.

#### Reduction provenance round-trip

Fields produced by `pypic.reductions.reduce` (top-level `from pypic import reduce, Reduction`) carry an `attrs["reduction"]` block (`{ axis, op, result_kind?, weight?, length_axes? }`, built at `pypic/reductions.py:370-403`; the `Reduction` Literal itself is at `:55-66`). The Zarr writer must preserve this attr verbatim. Field shapes:

- `axis: string | string[]` — single axis (`"z"`) or list (`["y","z"]`) for chained multi-axis reductions.
- `op: Reduction` — Literal: `"integrate" | "sum" | "mean" | "median" | "max" | "min" | "std" | "var" | "argmax" | "argmin"`.
- `result_kind?: "axis_position"` — set only when `op ∈ {argmax, argmin}` (the array now holds a coordinate value at the extremum, not the field value).
- `weight?: string` — name of the weighting field; only valid for `op ∈ {mean, integrate}`.
- `length_axes?: number` — accumulated count of length-dimension axes shifted out by chained unweighted `integrate` calls; drives `in_si()`'s length-factor accumulation. Dropping it produces silently-wrong SI conversion on integrated fields (column densities, LOS-integrated J·E). The loader treats a missing `length_axes` as 0 (back-compat with non-reduced fields).

Selection provenance is the dual symmetric attr (`attrs.selections`) — pending in pypic Step 37b; until it lands, the writer leaves that attr unset and the loader doesn't expect it. See §"Remote API" for the v0.2 session-export implication.

---

## Remote API (pypic.server contract) — v0.2

> **Status.** `pypic.server` foundations ship today: `create_app(root="/data/runs")` + `serve()`, JSON HTTP discovery (`/health`, `/sims`, …), and Arrow-IPC WebSocket at `/sims/{sim}/stream`. Wire contract in `pypic/server/protocol.py`: `BoxSpec`, `PlaneSpec`, `SphereSpec`, `SubscribeRequest`, `ReductionSpec`, `Ack`, `ErrorFrame`. webpic's `remote/protocol.ts` mirrors field-for-field. v0.1 ships without remote (M6 = writers + export); v0.2 remote client is wiring, not design.

**Typed error dispatch (Step 37a).** Dispatch on `kind` (not free-form `message`). WS `ErrorFrame.message: str` (`pypic/server/protocol.py:200`); HTTP `{kind, detail}` with status from exception's `status_code` ClassVar (`pypic/server/app.py:87-103`). Kinds: `unknown_sim`/`unknown_field`/`unknown_step` (404), `geometry_unsupported` (400), `validation` (422), `internal` (500). Full hierarchy: `pypic/exceptions.py` + `pypic/server/exceptions.py`.

**Selection-state persistence (pending pypic Step 37b).** `Box`/`Plane`/`SphereSelection` round-trip the wire but **not** through `to_zarr` (no `attrs.selections` yet). Until Step 37b, treat selection state as session-only (`uiStore`, not in M6 exports). Soft v0.2 dependency.

Shipped today (real endpoints on `create_app(root)`, `pypic/server/routes.py:64-97` + `stream.py:61`):

```
GET  /health                  → { status: "ok", pypic_version, ... }
GET  /sims                    → { sims: [...] }           (discovery under root)
GET  /sims/{sim}              → { name, model_name, model_type, grid,
                                  normalization, species, physics }
GET  /sims/{sim}/steps        → { steps: [...] }          (cheap step listing)
GET  /sims/{sim}/fields?step=N → { step, fields: { canonical: native|null, ... } }
WS   /sims/{sim}/stream       # JSON SubscribeRequest in (one per stream),
                              # JSON Ack out, Arrow IPC binary frame out,
                              # optional ErrorFrame on failure
```

The `SubscribeRequest` JSON shape (mirror in `remote/protocol.ts` field-for-field, `pypic/server/protocol.py:149-170`):

```
{
  type: "subscribe",            // discriminator
  request_id: string,           // client-issued correlation id
  sim?: string,                 // optional; defaults to {sim} from path
  step: number,
  fields: string[],             // [] = all available
  selection?: SelectionSpec,    // BoxSpec | PlaneSpec | SphereSpec (tagged union)
  reduction?: ReductionSpec,    // axis: string | string[], op, weight?, nan_policy
  units: "code" | "si"          // SI conversion happens server-side
}
```

`Ack` echoes `{ type: "ack", request_id, shape, dims, fields, units }` (`protocol.py:172-181`) so the client sizes its texture pre-IPC. Arrow IPC RecordBatch follows; schema metadata under the `"pypic"` key (`_PYPIC_META_KEY`, `pypic/server/arrow.py:51`; payload assembled `:140`).

**Transport.** Arrow IPC over WebSocket (browser: `apache-arrow` `tableFromIPC`; server: `pyarrow` — `arrow-rs` is the rustpic Rust reader, not pypic.server). SSE for live-timestep + HTTP/2 snapshot fallbacks are forward-looking; WebTransport deferred until pypic.server adopts it. **Auth:** token in `Authorization` header. **Compat:** a future capabilities field on `/health` would let the client disable missing features gracefully — pypic.server advertises none today.

---

## State management

**Zustand** (vanilla, `subscribeWithSelector`) — three stores, no React:

- `simulationStore` (`store/simulationStore.ts`) — ONE store composed from per-concern slices, each a `create*Slice(ctx)` in its own file owning its state + intents: `dataSlice` (dataset, active field, the `field` lifecycle, time cursor), `layersSlice` (the instance-first layer list, selection, traces, seed placement), `colormapSlice` (ColormapBindings), `cameraSlice`, `pickerSlice`, `overlaySlice`. The shape lives in `store/state.ts`; subscribers read dataset + layers + camera off the single object. The active field is a discriminated `FieldState` (`empty` | `ready` {computed, dataRange} | `error` {message}) — an illegal combination cannot be represented; `selectComputed`/`selectDataRange` (`store/selectors.ts`) are the stable-reference reads. Per-kind layer facts (label, defaults, draws-field, traces-lines) are one registration in `store/layerKinds.ts`, a complete `Record<LayerKind, …>` so a new kind is a compile error until described.
- The two async passes that span slices — the field compute (`store/fieldCompute.ts`) and the field-line retrace (`store/fieldTrace.ts`) — are `createSupersedingTask` instances: every call aborts the previous run's signal and discards its pending commit, so only the newest result lands (the pull-based invalidation counter in its v0.1 shape). `setDataset`/`selectField` accept an `AbortSignal` for the caller's own withdrawal (bootstrap disposed mid-load).
- `perfStore` (`store/perf.ts`) — render timing (frame time + clock, the "Measure" toggle) and the dev perf HUD samples/topology, isolated so per-frame churn never wakes panel subscribers.
- `uiStore` — panel open/closed, visibility, loading phases, selection chrome.
- `compute/recipes` — recipe registry + backend dispatch; `computableFields` derives the selector's options from RECIPES × backend support.

**Intent dispatching.** UI calls typed methods on the stores. The app's bridges subscribe selectively and forward to the render worker; `app/layerBridge` owns the field transfer and asks the store to `recomputeField` when a later layer needs data it already handed over. UI never touches the scene graph directly.

---

## Security model

- **CORS for untrusted Zarr URLs.** Require CORS preflight; surface a banner on failure (no opaque-response inference). Document `Access-Control-Allow-Origin` requirement for self-hosted Zarr stores.
- **TOML rendering.** User-supplied TOML never goes through `innerHTML` or template-string DOM injection. Field labels render via `textContent` only. Zod validates every field name against the canonical registry before display.
- **JSON schema fetched from server (v0.2).** Validates against checked-in Zod schema before binding to UI. Rejects on schema mismatch with a banner.
- **Shader provenance.** WGSL strings from `@rustpic/shaders` are not user-controllable; rejected at build if not from the pinned npm version. Shader source files in `packages/shaders/` (WGSL today, WESL-ready) are part of the bundle and tamper-evident via build hash.
- **No execution of remote code.** No `eval`, no dynamic `import()` from non-bundled URLs.

---

## UI

**Layout — "the visualization is the product."** Full-bleed 3D canvas with thin, translucent floating overlays over a fixed icon rail — never a docked frame that steals canvas area. *magviz's skin, instance-first bones*: keep magviz's full-bleed look (left icon rail, draggable floating colorbar, bottom gnomon/coords) and borrow only the instance-first *data model* (below) from napari — explicitly **not** napari's layout, whose layer dock + controls consume ~half the viewport (disqualifying under this philosophy). Overlays are translucent and content-sized, not window-sized. **Embed** degrades by hiding/toggling overlays — same components, fewer of them (`[webpic.embed]`) — not by reflowing; panels are container-agnostic (`install(host) → Disposer`, intents out), so a docked container for very cramped embeds is a possible v0.2 fallback. **v0.1 reality (M2.2):** today's `shell` is a *docked* hideable container — the scaffold, not the target. The rail + Layers panel + instance-first layer model land across M2.5a (model + render composite) and M4 (the UI); from M4 the overlays are **fixed-position translucent** (the immersive *look*, cheap — no window manager), and only user **drag/resize/persist/focus** (magviz's `windowManager` + `draggablePanels`) defers to M5/v0.2. Until M4 lands, panels mount in the docked scaffold.

### Layers & navigation

**Instance-first.** The scene is a flat, ordered list of *renderable instances* — each volume, slice, fieldline set, or particle cloud is one layer carrying its own visibility, opacity, `ColormapBinding`, and draw order. You navigate by instance ("the things on screen"), not by type ("the volume pane") — the one idea worth taking from napari.

- **Rail** (left, fixed, translucent): magviz's per-primitive buttons, verb shifted to *add*. `+Volume`/`+Slice`/`+Field lines`/`+Particles` open a **hover-preview, click-to-pin** panel (tap-pin on touch) that lists existing instances of that type as quick-jumps **plus** "Add new" — create and navigate from one seam. Tool buttons below (`Reductions`, `Selections`, `Diagnostics`, `Theme`) open their own overlays — *operations/instruments, never layers*. A dedicated **Layers** button toggles the Layers overlay.
- **Layers panel**: a *collapsible* floating overlay (rail-toggled — not an always-open dock, which would betray the full-bleed philosophy). One row per layer with an **eye** (show/hide) and a **gear**; the gear opens a *separate* small floating settings panel for that layer — the rail create-panel's controls **plus** opacity, draw order, remove. Create-panel and gear-panel are **one settings component, two entry points** (create vs. edit existing), so a layer is never configured in two places — closing the seam magviz had between its visibility checklist and its typed panes.
- **Viewport = always-on composite**: like a Photoshop canvas it is *always* the blend of every visible layer by draw order + opacity — no "combine" action, no row-merge. Two volumes are two rows; reordering changes blend order. A layer driven by two fields (`|B|` color × `n_e` opacity — a 2-field TF) is a **per-layer property**, not a merge of rows. Layer groups/folders defer to v0.2.
- **Colorbar** (top-right): draggable + hideable (magviz). Content = the ≤2 *distinct* `ColormapBinding`s among visible layers — "max two for sanity" is a property of the stack, exactly what the M2.5b registry models.
- **Bottom-left**: projection toggle (persp/ortho) + coordinate readout + camera gnomon (magviz).
- **Top bar** (thin, translucent): dataset, the **timestep scrubber** (global — not per-layer), camera/projection, export. Coarse and infrequent.
- **Boundary**: the layer stack lives in the store; every panel dispatches typed intents and never imports `render` or touches the scene graph (DAG-enforced — the discipline that let magviz's UI port here at all).

```text
┌────────────────────────────────────────────────────────────┐
│ ▸run-001    t ▬▬●▬▬ 42/256        persp ⤓ ⚙         │ top bar (translucent)
│ ┌──┐ ┌── Layers ──────────┐                ┌────────┐      │
│ │▦◀┼─┤ ◉ Volume |B|    ⚙ │                │ |B|    │      │
│ │+▤│ │ ◉ Slice  B_z    ⚙ │                │ ▮▮▮▮   │◀ colorbar
│ │+≣│ │ ○ Lines  |J|    ⚙ │                │ 0   12 │  (drag/hide)
│ │+✳│ └─────────────────────┘                └────────┘      │
│ │≋ │   ▦ Layers toggle · +X add (hover/pin) · ⚙ settings    │
│ │⬚ │                                                        │
│ │⏱ │          full-bleed 3D canvas — the composite          │
│ └──┘                                                        │
│  persp ⟲   (0.42, 0.10, 0.88)                     ⌖ gnomon │ bottom-left
└────────────────────────────────────────────────────────────┘
```

**Own the control primitives; custom code for shell + palette + keymap + theme.** magviz proved this out:
- Its dependency-free `ui/controls` layer (a `RangeControl` slider + pure-DOM select/checkbox/text behind a tiny `Pane`/`Folder`/`Binding` facade) carries no `three`/scene/framework deps and lifts into `@webpic/ui/controls` unchanged. Dropped Tweakpane entirely (~50 KB + plugin) once the primitives landed.
- Store contract is callbacks-out / `set()`-in (intent dispatch + selective subscribe — no two-way binding, *not* magviz's mutate-the-target `addBinding`).
- **Aim small** — magviz's TS UI tree (~3 kLoC) is the comparison, not a target. If the shell starts looking like a framework, stop.
- **CSP:** control styles inject via a single `<style>` at init (`applyControlStyles`); for strict-CSP hosts, ship extracted CSS via `<link>` with a nonce.
- **v0.1 reality (M2.2):** the facade is `kind`-tagged callback methods (`addSlider`/`addSelect`/`addCheckbox` + `set()`/`dispose()`), *not* magviz's mutate-the-target `addBinding(target, key)` — webpic's no-two-way-binding rule made the rewrite cleaner than the lift, and controls build DOM off `parent.ownerDocument` (no global `document`). `select` is a native `<select>`; the log/symlog/interval `RangeControl` (+ `rangeMath`) shipped with M2.3 window/level, and magviz's body-portaled popover dropdown is an M5 deferral. A control resolves its *label* from the registry (`fieldInfo`) where it names a canonical field, but numeric bounds come from the call site since `FieldMeta` carries no ranges. The field-selector's option list is the store's `availableFields` (UI can't reach `compute`).


**Theme.** Reads pypic's shared TOML themes (`pypic/plotting/themes/*.toml`): the `[webpic]` section for app-specific colors, plus `[colors]`/`[colormaps]`/`[fonts]` for cross-project values. **Canonical fact:** the `[webpic]` block has shipped upstream in all 7 bundled themes — webpic is purely a consumer (other sections cross-ref here). Schema kept for reference and additive bumps:

```toml
[webpic]
version = 1

# Rail + translucent floating overlays (instance-first Layers). webpic is a *consumer* of
# these themes, so this is a proposed *additive* bump to coordinate upstream — the shipped v1
# keys (default-panels/docked-side/panel-collapsed-default) still read as the docked fallback.
[webpic.layout]
rail-side = "left"
rail-items = ["volume", "slice", "fieldlines", "particles", "reductions", "selections", "diagnostics", "layers"]
overlay-opacity = 0.92
layers-collapsed-default = true
colorbar-visible = true

[webpic.shortcuts]
toggle-volume = "V"
toggle-slices = "S"
toggle-layers = "L"
toggle-ui = "F"
command-palette = "Cmd+K"

[webpic.diagnostics]
fps-overlay = true
gpu-memory-overlay = false
timestamp-query-overlay = false

[webpic.embed]
banner-on-cors-failure = true
default-controls-visible = true
```

Fallback: missing `[webpic]` → built-in defaults silently. Bundled themes mirror pypic's set (7): `dark`, `light`, `catppuccin-mocha`, `lcars`, `synthwave`, `andromeda`, `anuppuccin-light`.

### Point-picker gestures

`ui/picking/pointerPicker.ts` owns these; the marker itself lives in the render worker.

- Drag the sphere to move it on the equatorial plane; Shift — or a steep view — switches the drag to vertical z. The ↕/↔ handles drag along a single axis.
- A press on empty volume falls through to `pointerCamera` (orbit/pan; its double-click focuses). There is deliberately **no tap-to-place**, so a stray tap — touch especially — never jumps the marker; reposition by dragging it or with the held arrow keys.
- Held arrows slide the marker **view-relative**: ←/→ along the horizontal screen-right axis, ↑/↓ into and out of the screen, Shift+↑/↓ vertically in z. View-relative rather than world-fixed, so the on-screen direction always matches the key.
- Everything here is inert while the marker is hidden (`overlay.showPicker` false).

### Shortcuts

Hand-rolled registry (`ui/keys/shortcuts.ts` is the cheat-sheet authority; OPFS remapping rides the M5 shortcuts UI). Shipped defaults: `V`/`T` add volume/field-lines — `S` is **deliberately unbound** (collides with the W/S dolly; slices add via the rail) and `P` went to the PNG screenshot, so particles get a binding at M6 — `L` toggle Layers, `F` toggle UI, `O` projection, `R`/`Z` reset/fit, digits axis-snap, `?`/`H` shortcut overlay, `Cmd+K` palette (v0.2). Stepping rides the top bar's scrub chip + prev/next buttons (no `[`/`]` binding shipped).

**Accessibility.** Tab order, focus rings, palette keyboard nav, ARIA roles. High-contrast theme to v0.2.

**Embedding.** `new WebpicViewer({ canvas, datasource })` — UI fully strippable (bundle budget in §Deferred but tracked).

---

## Build system & tooling

- **Vite 8** (`vite.config.ts`); `vite-plugin-wasm` + `vite-plugin-top-level-await` are deferred with the WASM backend (M9-contingent), not present deps today. Vite dev config sets COOP/COEP headers for SharedArrayBuffer. *(Deferred with the WESL toolchain: a custom `vite-plugin-wesl` `handleHotUpdate` that recompiles `.wesl` → WGSL over `import.meta.hot` and rebuilds the affected `GPUShaderModule` without page reload; v0.1 ships WGSL strings and HMRs them directly.)*
- **WESL toolchain (deferred):** `wesl-js`/`wesl-rs` are a pre-1.0 (`2026_pre`) community WGSL superset. v0.1 ships **standalone WGSL** instead — WGSL is a strict subset of WESL, so kernels migrate for free. Adoption is gated on rustpic publishing compute kernels to share across the Rust + TS paths (see §Shader sharing), *not* on f16 (TS templating covers that). Pin an exact `wesl-js` version on adoption so `2026_pre` churn can't surprise the build.
- **TypeScript:** `target: "ES2024"`, `module: "ESNext"`, `moduleResolution: "bundler"`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, `noUnusedLocals`/`noUnusedParameters`. Three tsconfigs — app, worker (`WebWorker` lib), node (scripts + tests) — not project references.
- **Workers:** literal `new Worker(new URL(…), { type: 'module' })`, so Vite emits each worker as its own chunk (two today: `render/worker.ts`, `workers/data.worker.ts`). The compute pool is designed around `comlink` (~5 KB) for RPC + a 20-line round-robin pool over `new Worker(new URL(...), { type: 'module' })`, sized to `Math.min(navigator.hardwareConcurrency - 1, 8)` (not `tinypool` — Node-only). **v0.1 reality:** only `data.worker.ts` exists, using raw `postMessage`; `comlink` is added when the compute pool lands (M3+).
- **Lint + format:** **Biome** (single binary, integrated formatter — replaces ESLint + Prettier). Layer enforcement is not a Biome plugin; see §Layered dependency DAG.
- **Test runner:** Vitest. Node mode for `coordinates`, `numerics`, `reductions`, `schema`, `compute/backends/ts`, `derived`. A `happy-dom` project (devDep) runs the `ui` DOM-unit tests (`*.dom.test.ts`) — node mode can't construct DOM, and these are deterministic, not visual. Browser mode (`@vitest/browser-playwright`) runs the `*.browser.test.ts` real-GPU suites in headed system Chrome via `npm run test:gpu` — local-only (WebGPU on macOS/Metal is unreliable headless), env-gated out of plain `vitest`/CI. Coverage via `@vitest/coverage-v8` (`npm run test:coverage`) is **gated** at a floor of 86/84/87/74 (lines/statements/functions/branches, `vitest.config.ts`); it only ever rises. Playwright E2E flows are deferred (see §Testing strategy).
- **Git hooks:** `lefthook` (installed by `npm run prepare`) — Biome on staged files at commit; typecheck, boundaries, lint and tests at push. Mirrors CI so a red build is caught locally first.
- **Docs:** TypeDoc from public exports.
- **Bundle size:** `size-limit` with a 545 kB ceiling on `@webpic/embed`, 385 kB on `@webpic/app` (gzipped). Both are ratchets at the measured value, not aspirations.
- **Shader validation:** `tests/wgsl.test.ts` parses the assembled WGSL with `wgsl_reflect` and pins each kernel's binding layout, workgroup size and `Params`/`TraceMeta` byte lengths against the `gpu/` runners that duplicate them. Parse-level only: CI proves the kernels compile, `test:gpu` proves they run (a `tint` CLI tier was considered and dropped — `wgsl_reflect` is in-process and needs no toolchain).

**Key dependencies.** *Shipped in v0.1:* `three` (exact pin carrying #31607, not a floating range), `zarrita`, `zod` (app), `smol-toml`, `zustand`. *Adopted when their layer lands:* `comlink` (with the compute worker pool, M3+), `zod/v4-mini` (the embed build), `xxhash-wasm` (only if FNV-1a proves insufficient — it currently doesn't), `wesl-js` (gated on rustpic shared kernels). `gl-matrix` was planned here for `coordinates`/`numerics` but both shipped dependency-free — don't add it without a demonstrated need. Control widgets are owned, not a dependency — see §UI (magviz dropped `tweakpane` + `@tweakpane/plugin-essentials` once its `ui/controls` primitives landed).

---

## Testing strategy (pragmatic — only what matters)

**Tested**
1. **Schema validators** against pypic-emitted JSON Schema and real TOMLs (10 fixtures including the canonical `pypic.simulation.toml`).
2. **Schema parity (semantic):** every fixture validates against both regenerated and checked-in Zod schemas.
3. **Schema additive-compatibility:** fixtures from prior N schema versions still validate.
4. **Numerical kernels** in `coordinates/`, `numerics/`, `derived/`, and `compute/backends/ts/` against pypic golden outputs and analytical synthetic fixtures (Orszag-Tang, Harris, GEM). Tolerances per-kernel, per-precision.
5. **Cross-backend equivalence** — every kernel in `ts` vs `webgpu` (and `wasm` when wired).
6. **Data adapters** — Zarr readers against pypic-written stores.
7. **TOML round-trip parity** — `smol-toml` vs Python `tomllib`.
8. **OffscreenCanvas worker render parity** — frame from worker matches main-thread frame within 1 pixel diff (`render/parity.browser.test.ts`, `test:gpu`, local-only).
9. **Prefetch fuzz** — `src/data/prefetch.test.ts` exercises EWMA direction detection with seeded random scrub patterns.
10. **Data-worker message boundary** — `src/workers/data.worker.test.ts` covers the unknown-request-kind report, an unrecognized handle, pre-stream cursor/field moves, an unlandable cache write, and perf self-report start/stop.
11. **Render-worker integration** — the `render/worker.*.test.ts` suites drive the real message loop against mocked scenes (quality tiers, device recovery, streaming ping-pong, shader HMR).
12. **Meta-guards** — the 17 suites in `tests/`: `boundaries` + `aliases` (layer DAG, alias parity), `embed` + `embed-bundle` (star-export ambiguity and the built facade), `live-modules` (code only its own test keeps alive), `comment-budget` (JSDoc-free layers, header cap, prose a rename sweep corrupted), `design-citations` (every `§` resolves), `manifest`, `codegen` + `schema-parity`, `tolerances` (the ladder stays monotone), `wgsl` (struct layout), `goldens` / `traces.golden` / `analytic-parity` / `seed-domain-parity` / `writer-parity` — plus `ui/panels/themeCoverage.test.ts` beside its layer.

**Planned, not yet written** (listed here so the gap is visible, not implied):
- **Multi-tab cache safety** — two concurrent tabs writing to OPFS; assert no corruption. Needs a two-context browser test.
- **Migration** — a `tests/migration.test.ts` exercising schema-version transitions, once a second schema version ships (item 3 covers additive compatibility today).
- **One smoke E2E** — load Zarr URL, render volume, scrub timestep, no crashes. The closest live check is `scripts/verify-streaming-render.ts` (manual, headed Chrome).

**Tolerance table (`tests/tolerances.ts`).** Honest per-kernel × per-precision; bare operator keys, `{rtol, atol}` cells (the atol floor is what keeps curl/div honest at their zero-crossings — magnitude needs none). The matrix itself lives in that file, guarded for completeness and ladder order by `tests/tolerances.test.ts`; what follows is why the cells read as they do.

Header marks each cell measured vs derived: magnitude/curl/div @ `webgpu_f32` measured (M3.1, small smooth grid); f16 has no compute kernel in v0.1 (`shader-f16` unrequested), so those cells are paper bounds from the f16 unit roundoff (~5×10⁻³ for the cancelling FD ops). The 1e-6 rel f32 row is honest for `|B|` but fiction for curl — f32 cancellation in the difference, so curl/div carry a looser floor. M3.4 may widen curl/div `ts_f64` toward ~1e-10 and the `webgpu_f32` atol on 256³ turbulent goldens — widen only with that measurement. A `tests/tolerances.test.ts` guard keeps the matrix complete and the ladder honest (f64 tightest, f16 loosest, magnitude ≤ the FD ops).

**Not tested**
- Three.js scene state, materials, render output (visual regressions flaky).
- Zustand mechanics (library).
- Visual output of UI chrome; the `*.dom.test.ts` suites assert structure, bindings, and dispatched intents only.

**Fixture generation.** `scripts/gen-fixtures.ts` invokes pypic in dev; outputs checked into `tests/fixtures/v{N}/`. `scripts/gen-synthetic.ts` generates analytical fields (no pypic dep). CI does not require pypic.

---

## CI infrastructure

**What runs (`.github/workflows/ci.yml`, one `ubuntu-latest` job, Node 24):** the steps of `package.json`'s `check`, in order, one `run:` each so a failure annotates its own step. Two ordering constraints are load-bearing and carry their reason in `ci.yml`: `build`/`build:embed` precede `test:coverage` (`tests/embed-bundle.test.ts` skips when `dist-embed` is absent), and the coverage-artifact upload sits between `test:coverage` and `docs:api`. `pages.yml` deploys `dist/` plus the API reference under `/api/` on every push to `main`, queued rather than cancelled. `gen:themes:check` and `test:parity` need the `../pypic` sibling checkout, so they stay local-only guards.

**Local-only tiers** (need a real GPU or a pypic checkout; never in CI): `test:gpu` (cross-backend parity, streamlines, composite, pick, worker frame parity — headed system Chrome), `perf:gate` (cold-paint / first-frame numbers), `test:parity` (`WEBPIC_PYPIC_PARITY=1`, schema + writer parity against live pypic). The pre-push lefthook runs the four cheap CI gates — `typecheck`, `check:boundaries`, `lint:ci`, `test` — so CI-shaped failures surface before a push.

**Deferred (was the original CI design; nothing here exists yet):** a Linux SwiftShader WebGPU tier (`--enable-unsafe-webgpu --use-vulkan=swiftshader` — functional but too slow and unrepresentative to gate on), a macOS/M2-Pro runner for the perf gate and real-WebGPU suites, a Chrome stable + Canary matrix with Safari TP nightly, and screenshot/`timestamp-query` artifacts on render failures. Revisit when a self-hosted Apple-silicon runner is available; until then the GPU tier is a documented manual step before any render-touching merge.

---

## Shader sharing with rustpic

**v0.1 ships standalone WGSL; WESL is the *eventual* shared format, not a day-one dependency.** Separate the *format* decision from the *toolchain* decision:

- **Format (now):** shared numeric kernels (`field.{magnitude,curl,divergence}` at M3; the DP5(4) streamline step at M4) live in `src/shaders/kernels/` as **standalone WGSL** strings, imported by `compute/backends/webgpu` and any render path needing the same math, and cross-backend-tested against their `coordinates/`/`numerics/` TS reference twins. WGSL is a **strict subset of WESL**, so these carry *zero* rewrite cost toward WESL — rename `.wgsl`→`.wesl` and add `@if`/imports when there's a reason to.
- **Toolchain (gated on rustpic):** `wesl-js`/`wesl-rs`, a `vite-plugin-wesl` HMR step, and `scripts/sync-shaders.ts` (copy kernels from a rustpic checkout into `src/shaders/kernels/`, CI diff-checked) land **only when rustpic publishes compute kernels** to share across the Rust + TS paths — that's the moment imports + dual npm/cargo packaging earn their keep. *Not* f16: the f16/f32 dual path is handled by TS string templating in v0.1 with no preprocessor. Pin an exact `wesl-js` version on adoption so `2026_pre` churn is contained. Once rustpic publishes `@rustpic/shaders`, webpic adds it as a normal npm dep and the sync script retires.

**Where a kernel lives:** `shaders/` (standalone WGSL, shared, TS-twin-tested) iff it's a numeric operator with a TS reference impl *or* rustpic would want it; otherwise it stays render-local TSL `wgslFn` in `render/`.

Render-only shaders (raymarch compositing, ray-box, transfer function, Phong, particle billboard, axes gizmo) are webpic-private; v0.1 authors them as inline TSL `wgslFn` in `render/` (e.g. `render/field/raymarchScene.ts`), graduating to `src/shaders/visual/` only if a non-TSL consumer needs them.

---

## Milestones

Scope per §Versioning scheme; M9 contingent on rustpic shipping plasma-wasm. Each milestone is end-to-end runnable.

> **Execution checklist + live status: `../TASKS.md`** (single source of truth for step-by-step progress). The table below is design intent — headline scope + exit gate — not a tracker.

> **Scope risk acknowledged.** The v0.1 bundle is ambitious (codegen + raymarcher + cross-backend parity + WGSL streamlines + Zarr writer + reduction round-trip + OffscreenCanvas worker + perf gate), with no slack for the perf-gate-fails branch it anticipates. Decision point: M2 exit.
> - If M2 slips materially, **first cut M4 (streamlines)** to v0.2 — slice + volume is already a useful viewer.
> - Cutting M6 (Zarr writer + screenshot) is harder — export gates the analyzer use-case; cut only if the writer or `attrs["reduction"]` round-trip proves harder than expected.

| Milestone | Headline | Exit gate |
|---|---|---|
| **M0 — Foundation** | Vite + TS strict + Biome + npm + Vitest; schema/aliases/recipes codegen (§Schema sharing); `@webpic/{schema,containers,coordinates,numerics,gpu}` scaffolds; `check-boundaries.ts`; OffscreenCanvas-on-Worker scaffold; theme loader; OPFS cache; backend microbench in background | Cold-start: page paint <500 ms; first frame <1500 ms on M2 Pro Chrome stable |
| **M1 — Static slice** | `data/readers/zarr.ts` (zarrita.js) implementing `SimulationReader`+`FieldListingReader`; `_registry.ts` with `openSimulation()`; `magnitude` operator registered as `'|B|'`; TS backend; one orthogonal slice with themed colormap | `computeField('|B|', dataset)` end-to-end; schema-parity (`pypic schema diff` + Vitest) + additive-compat tests green |
| **M2 — Volume + perf gate** | single-pass TSL raymarcher (NodeMaterial + `wgslFn`), single-scalar volume; transfer-function texture + window/level (owned RangeControl); interactive camera (render loop + store-owned pose; orbit/turntable); gradient + Phong shading; `timestamp-query` diagnostics; time-series prefetcher (EWMA + debounce); eager `compileAsync`; shader HMR | **Perf gate:** 256³ × 256-step dataset @ 8 ms per-frame raymarch on M2 Pro by end of M2, scrubbed without stalls. 512³ deferred to v0.2 if missed |
| **M3 — WebGPU compute + parity** | WebGPU backend for `field.{magnitude,curl,divergence}`; cross-backend equivalence (TS vs WebGPU) at per-precision tolerances; pypic fixture suite checked in; Orszag-Tang, Harris, GEM synthetic fixtures. WASM backend deferred to M9 | Cross-backend parity within tolerance against pypic goldens |
| **M4 — Field lines + instance-first UI** | WGSL streamline compute (Dormand-Prince 5(4) + I step control) as a standalone `shaders/` kernel shared w/ rustpic; raycast seed picking against slice/volume bounds; Line2 indirect-draw render; `AbortSignal`-cancellable mid-trace; plus the instance-first UI (rail + Layers panel + per-layer settings + colorbar) | Cancellable traces match pypic golden traces; volume + slice + field lines co-display as managed layers |
| **M6 — Writers + export** | Zarr v3 writer for derived fields; PNG screenshot (`canvas.toBlob`); `simulation.toml` round-trip; reduction-provenance round-trip (see §Data layer › Reduction provenance round-trip); theme switcher; TypeDoc from public exports; `size-limit` CI gate; top bar (dataset/run name · timestep scrubber · projection · export — see §UI) | 1.0 MB embed / 550 kB app (gzipped); reduction round-trip preserved |

**M0 detail.**
- **Codegen** (per §Schema sharing): `validators.generated.ts`; `aliases.generated.ts` (from `pypic.aliases.{COMPUTE_ALIASES,GROUP_ALIASES,SPECIES_SUFFIX_RE}` — the regex powers per-species runtime expansion); `recipes.generated.ts` stubs (from `pypic.compute.RECIPES`; `Recipe` dataclass for field types; `SPECIES_TEMPLATES` codegened separately; recipe bodies hand-written in `@webpic/derived`).
- **Numerics:** port `pypic.numerics.{dormand_prince_step,i_step_controller}` into `@webpic/numerics` as the v0.1 reference adaptive integrator — matches pypic's field-line tracer for cross-tool equivalence.
- **`@webpic/gpu`:** device acquisition, capability probe, `device.lost` recovery, profiler (see §Renderer).
- **Theme loader** reads `pypic/plotting/themes/*.toml` `[webpic]` block (already upstream, see §UI; e.g. lcars `docked-side="left"`, synthwave `timestamp-query-overlay=true`, light `fps-overlay=false`).
- **OPFS cache** via `navigator.locks`, writes in `data.worker.ts` (see §Caching). Boot page does the WebGPU probe + fallback. Main-vs-worker frame-parity test green.

**M2 detail.**
- Perf gate per §Performance gate (8 ms = raymarch only; 256 = disk depth).
- Shader HMR working — edit raymarcher color, see update without losing camera pose.
- Gradient + Phong is ~20 lines for a scientific quality win. `timestamp-query` panel falls back to `performance.now()`.

**M4 detail.** Reference implementations to mirror in `@webpic/numerics`:
- `pypic.traces.trace_field_line_adaptive` (DP5(4) + I step control via `pypic.numerics`); `trace_field_lines_adaptive` (batched, for seed fans).
- `VectorFieldInterpolator` (trilinear) → WGSL `textureSampleLevel` lookup; tricubic (pypic Step 44b roadmap) already supported by storage-texture backing.
- Termination mirrors `pypic.traces.TerminationReason` (out-of-bounds, max-steps, low-step-size, …), re-exported under `@webpic/numerics`.
- **v0.2 candidates from these primitives:** `poincare_section` + `PoincareSurface`/`PoincareSection` (2-D scatter overlay, no new compute); `estimate_tracing_error` (embedded-RK45 norm) for a per-streamline confidence overlay / tolerance-slider that retraces.

**v0.2 (post-launch)** — renumbered at v0.1 close (TASKS.md is the numbering authority; the completed v0.1 "M6 — Writers + export" keeps its historical label):
- **M5 — UI polish** *(next up)*: floating window manager (magviz's `windowManager` + `draggablePanels`), command palette (Cmd+K), remappable shortcuts UI, comparison view, high-contrast theme, plus the carried UI deferrals (rail-menu previews, colorbar overflow chips, theme picker, popover dropdown, binding merge/GC + magviz import adapter, top-bar actions)
- **M6 — Particles:** `hyparquet`, instanced billboards, GPU cull/sort, density-binning fallback, `particleAccessMode` enum, DuckDB dynamic import
- **M7 — HDF5 + LIC + oblique slicing:** `h5wasm`, LIC compute pass, oblique clip planes; real readers register into the data worker (replacing the synthetic-only streaming registration)
- **M8 — Remote client:** `remote/client.ts` against shipped `pypic.server` Arrow-IPC WebSocket endpoint; mirror `SubscribeRequest`/`BoxSpec`/`PlaneSpec`/`SphereSpec`/`ReductionSpec` from `pypic/server/protocol.py`; SSE for live timestep when pypic.server exposes it
- **WebCodecs video export** (unscheduled)
- **PWA manifest** — shipped

**M9 (contingent):** WASM backend integration when rustpic ships `plasma-wasm`. Cross-backend equivalence extends to TS vs WASM vs WebGPU.

**Post-v1.0:**
- Spherical/cylindrical raymarcher path
- WebTransport (when pypic.server adopts it)
- Live rustpic integration
- Marching cubes isosurfaces
- Pre-integrated TF (if step count proves limiting)
- Plugin / extensibility API

---

## Risks & open questions

**Top risks (ordered)**

1. **TSL `wgslFn` escape hatch instability.** The volume raymarcher depends on it (shared *compute* kernels are standalone WGSL pipelines, not TSL, so they're insulated). Three deprecating it would break the raymarcher. Mitigation: parallel raw-WebGPU raymarcher behind a flag.
2. **Schema codegen drift.** Mitigation: semantic parity (every fixture validates against regenerated + checked-in schema) + additive-compatibility test against prior N versions.
3. **WebGPU adapter quirks.** Storage texture formats vary; `shader-f16` is Chrome-mostly with Qualcomm exclusion. Mitigation: capability matrix in `gpu/capabilities.ts`, TS-templated f32/f16 kernel variants (a WESL `#if SHADER_F16` once the toolchain lands), `?backend=ts` URL override for triage.
4. **Perf gate may fail.** 256³ × 256 steps at 8 ms is not guaranteed. Mitigation: measure end of M2; defer 512³ to v0.2 with LOD bricks if needed.
5. **WESL pre-1.0 (`2026_pre`) churn.** v0.1 takes no WESL dependency (ships standalone WGSL), so this risk stays dormant until adoption is triggered by rustpic shared kernels; the mitigation then is the exact `wesl-js` version pin (§Build).
6. **Three.js OffscreenCanvas worker bugs.** Mitigation: the exact-version pin in §Renderer + worker-vs-main parity smoke test in CI.
7. **`render/adapters/` god-module risk.** Magviz failure mode. Mitigation: one adapter file per scene concern, boundary-check enforced.

**Open questions for execution time**

- **`pypic.server` shipped** (Step 37: Arrow-IPC WebSocket + JSON discovery; Step 37a: typed exception hierarchy + HTTP `kind` field). v0.2 remote client dispatches on `kind`, not `detail` strings — now wiring against a real contract, not co-designing. v0.1 still skips remote (M6 = writers/export).
- **pypic Step 37b** (`attrs.selections` round-trip; symmetric to `attrs["reduction"]`) pending — soft v0.2 dependency for session save/reload that bakes selection state into exported Zarr. Live streaming + in-memory selection unaffected; revisit M6 session-export once it lands.
- **rustpic `plasma-wasm` timing** — unknown; v0.1 is TS-only compute regardless.
- **Theme block** — already upstream (see §UI); a consumer concern, not M0 prep.
- **`data/writers`** ship v0.1 (M6), Zarr v3 only — derived-field caching, `simulation.toml` round-trip, reduction-provenance (see §Data layer). Other formats deferred.

---

## Deferred but tracked

Cross-cutting concerns and explicitly deferred items. Milestone-bound work lives in Milestones; this table is for the rest.

| Concern                       | Status   | Notes                                                |
|-------------------------------|----------|------------------------------------------------------|
| Bundle size budget            | v0.1     | `size-limit` 545 kB embed / 385 kB app gzipped       |
| TypeDoc API docs              | v0.1     | M6                                                   |
| Crash telemetry (opt-in)      | v0.2     | Sentry-compatible endpoint, off by default           |
| Accessibility (keyboard nav)  | v0.1     | Tab order, focus rings; command palette is v0.2      |
| Accessibility (high contrast) | v0.2     | Theme variant                                        |
| PWA manifest                  | v0.2     | Zero-cost "install" for demo URL                     |
| Schema migration              | v0.1     | `schemaVersion` tags on every cached artifact        |
| Pre-integrated TF             | post-v1.0| Revisit if perceptual quality at <128 steps suffers  |
| WebXR / VR                    | never    | Out of scope                                         |
| Plugin / extensibility API    | post-v1.0| Dynamic import + manifest                            |
| Spherical/cylindrical raymarch| post-v1.0| ~15% perf hit, exact correctness                     |
| Marching cubes isosurfaces    | post-v1.0|                                                      |
| WebTransport                  | post-v1.0| Contingent on pypic.server                           |

---

## Critical files & references

**Codegen + scripts.** Shipped (M0): `scripts/codegen/{bundle,emit,render-schema,render-aliases,render-recipes,render-registry}.ts` (driven by `npm run gen`), `scripts/check-boundaries.ts`, `scripts/sync-themes.ts`, `scripts/perf-gate.ts`. Shipped since: `tests/tolerances.ts` (per-kernel × per-precision `{rtol,atol}` matrix `TOL.<kernel>.<precision>` + structural guard `tests/tolerances.test.ts` — landed M3.2), `gen-synthetic.ts` (analytical fields), `gen-fixtures.ts` + `gen-trace-fixtures.ts` (dev), and the four headed-Chrome instruments (`perf:raymarch`, `verify:streaming`, `verify:orientation`, `shot:readme`). Not built: `sync-shaders.ts` (rustpic-gated).

**Upstream PR.** pypic theme TOMLs — `[webpic]` section (shipped M0; see §UI for schema).

**To read for ground truth (sibling repos).**

*pypic* — [`src/pypic/`](https://github.com/rusaitis/pypic/tree/main/src/pypic) (MIT, public):
- `schema/{_models.py,_export.py,cli.py,simulation.schema.v1.0.json}` — Pydantic v2 root `SimulationSchema`, JSON Schema 2020-12 export, Typer CLI, bundled output
- `fields.py` (FieldInfo registry), `derived.py` (recipes), `diagnostics.py` (div_B, div_E, field_energy)
- `compute.py` — `Recipe` dataclass (lines 49-79), `RECIPES` (`MappingProxyType`), `SpeciesArgs`, `SpeciesTemplate`, `SPECIES_TEMPLATES`; API: `compute_field`, `available_quantities`, `field_dependencies`, `register_recipe`, `unregister_recipe`
- `aliases.py` — public shim re-exporting `COMPUTE_ALIASES`, `GROUP_ALIASES`, `SPECIES_SUFFIX_RE`, `species_name_aliases`
- `numerics/__init__.py` — Dormand-Prince RK45 (`dormand_prince_step[_batched]`, `i_step_controller[_batched]`, `embedded_error_norm[_batched]`, `DPStepResult[Batched]`). Not in `pypic.__all__` — import from `pypic.numerics`. `_batched` variants reference the WGSL streamline kernel
- `traces/__init__.py` — `VectorFieldInterpolator`, `FieldLine`, `ParticleTrace`, `TerminationReason`, `trace_field_line[s]_adaptive`, `PoincareSection`/`PoincareSurface`/`poincare_section`, `estimate_tracing_error`, sampling + analysis helpers. Wider `__all__` than top-level — codegen consumes `pypic.traces.__all__` directly. M4 reference implementation
- `server/{protocol.py,arrow.py,__init__.py}` — wire types (`SubscribeRequest`, `BoxSpec`/`PlaneSpec`/`SphereSpec`, `ReductionSpec`, `Ack`, `ErrorFrame`), Arrow IPC encode/decode, `create_app(root)` + `serve()` entry points
- `units.py`, `coordinates/`, `containers.py`, `dataset.py`, `selections.py` — directly mirrored by `@webpic/{schema,coordinates,containers,reductions}`
- `reductions.py` — `reduce()` + `Reduction` Literal (lines 55-66, the 10-op Literal; lines 14-24 explain `reduce` naming vs Three.js `Vector3.project()`)
- `readers/{_protocols.py,_registry.py,config.py}` — stackable reader protocols, `can_read_confidence` dispatch, TOML config loader
- `plotting/themes/*.toml`, `pypic.simulation.toml` — themes (incl. `[webpic]`), canonical config example

*magviz* — the private WebGL prototype webpic replaces. Referenced here for the lessons carried
forward (RK4 + trilinear tracing, keymap and panel patterns) and, more importantly, for the failure
mode webpic's layer DAG exists to avoid: rendering, UI, data, and physics entangled to the point
where extension was painful. Its GLSL raymarcher is obsoleted by the WebGPU one.

---

## Verification

End-to-end smoke before declaring v0.1 done *(v0.1 closed 2026-07-03 — items 5/6/8 carry their negotiated outcomes inline)*:

1. **Boot smoke.** `npm run dev`, page loads, WebGPU check passes on Chrome stable, fails gracefully where `navigator.gpu` is absent. OffscreenCanvas-on-Worker active.
2. **Schema codegen.** `npm run gen` produces Zod that all fixtures validate against. Additive-compatibility test green against prior schemas.
3. **Numerical parity.** `npm test` (cross-validation suite) — every kernel agrees with pypic golden output within the tolerance table.
4. **Cross-backend parity.** Same kernel in TS and WebGPU agree per-precision tolerance.
5. **End-to-end render.** *(met, renegotiated — no `run-001.zarr` fixture shipped; fixtures stayed JSON + in-app synthetic datasets per §Testing.)* The equivalent smoke is the M4/M6 real-Chrome E2Es: volume + slice + field lines co-display as managed layers, timestep scrub, Phong toggle live, zero GPU errors.
6. **Perf gate.** *(closed by decision at M2 exit — 256³ is the v0.1 ceiling, 512³ + LOD deferred.)* Measured p50 ≈ 12.4 ms on base M2 wall-clock (~6.5–7.5 ms extrapolated M2 Pro, unconfirmed); render-pass `timestamp-query` was removed (it loses the Metal device), so the instrument is wall-clock.
7. **Theme switching.** Cycle dark → light → catppuccin-mocha; all UI + colormaps update; saved across reload via OPFS. `[webpic]` section in pypic upstream.
8. **Embedding smoke.** *(split — the budget half is met and CI-gated at M6.7: 538.6 kB ≤ 1.0 MB gzipped; the `WebpicViewer` embedding API is v0.2, M6.6 shipped the headless facade + TypeDoc instead.)* `new WebpicViewer({ canvas, datasource: <Zarr URL> })` renders without `@webpic/ui` imported.
9. **Resilience.** Force `device.lost` via DevTools; recovery rebuilds scene from store + OPFS cache, banner shown, 200ms fade-in on success. Two tabs concurrently writing to OPFS — no corruption.
10. **Migration.** Test loading a v1.0 cached artifact against v1.1 schema — migration runs (no-op for additive).
11. **Cold start.** Page paint <500ms; first frame <1500ms on M2 Pro Chrome stable.
12. **Worker render parity.** Worker-rendered frame matches main-thread-rendered frame within 1 pixel diff (regression catch for r179-style Three.js bugs).

If 1–12 pass on a clean checkout against pinned pypic + browser versions, ship v0.1.

---

## Store schema additions — colormap bindings & selections

Three store-node shapes, one shipped and two proposed. All live in `@webpic/schema`, which is the
**authority**: the prototype that motivated them conforms to webpic naming, not the reverse, and any
imported session state crosses through a boundary adapter rather than webpic mirroring a foreign shape.

1. **`ColormapBinding`** *(shipped, M2.5b)* — a reified colormap registry: primitives reference
   bindings by id and share or split deliberately, rather than each hardcoding its own color state.
   webpic designs the shape it wants — typed `FieldName` + `ColormapId`, window/level as
   `{center, width}` consistent with the `RangeControl`, and a discriminated `scale: linear|log|symlog`.
   Deliberately excluded: per-binding `units` (they come from the schema/theme) and raw `min`/`max`
   (the window/level pair is the range representation). Landed **before the v0.1 freeze** — reified
   bindings are painful to retrofit once primitives hardcode color state. v0.1 ships the minimal
   registry (slice + volume); `merge`/GC and the two-colormap soft-warning wait for the multi-layer UI.
2. **`CriterionSelection`** *(proposed, v0.2)* — predicate selection:
   `{ kind, id, label, field, op: '>' | '<' | '>=' | '<=' | '==' | '!=', value }`. A joint addition
   with pypic rather than a webpic-only shape.
3. **`CompositeSelection`** *(proposed, v0.2)* — set algebra over selection primitives:
   `{ kind, id, label, op: 'union' | 'intersection' | 'difference', left, right }`. Same pypic pairing.

Importing session state from another tool is a **boundary concern, not a schema constraint** (see
CLAUDE.md §"Schema, validation, boundaries"): a one-shot adapter decodes the foreign
`{min, max, log, logFloor, centerOnZero}` form into webpic's window/level binding on load and drops
prototype-only fields. That rides session-export in v0.2, which is itself gated on the upstream
selection work — there is no corpus of saved sessions to gate v0.1 on.

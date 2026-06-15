# Project: webpic

webpic is a modern TypeScript/WebGPU plasma-physics data visualizer + lightweight analyzer — the 3D viewer leg of the pypic / rustpic / webpic toolchain. It reads pypic-blessed formats (Zarr v3, HDF5, Parquet), streams from `pypic.server` (v0.2), and shares WGSL/WESL kernels with the upcoming `rustpic` simulator. Sibling `pypic` is the schema + physics authority.

## Docs map

- **CLAUDE.md** (this file) — conventions + layer model + commands. Always loaded; keep it lean.
- **TASKS.md** — milestone checklist (M0–M6); check off `[ ]` as you go. `/tasks` summarizes.
- **docs/DESIGN.md** — full design rationale (layer DAG, schema codegen, remote protocol, tolerances, risks). Read on demand — *not* `@`-imported, so it never bloats session context.
- `../pypic/CLAUDE.md` — sibling ground truth for canonical names + physics equations (read when needed).

## Architecture

- **Hard layer boundaries (pypic-mirrored).** Layers: `schema`, `containers`, `coordinates`, `numerics`, `reductions`, `derived`, `diagnostics`, `gpu`, `shaders`, `compute`, `data`, `remote`, `render`, `store`, `ui`, `app`, `workers`, `embed`. Full dependency DAG in `docs/DESIGN.md`. Rule of thumb: `schema` depends on nothing (root + canonical-name authority + shared scalar/geometry primitives — `@schema/math`'s `clamp`, `UNIT_BOX_HALF_EXTENT`); the math layers (`coordinates`/`numerics`/`reductions`/`derived`/`diagnostics`) are pure leaves; `ui` → `store` → `render`, and `ui` never imports `render` or calls `scene.add(...)` — it dispatches typed store intents. Boundary violations are CI errors (`scripts/check-boundaries.ts`, ts-morph).
- **Built vs reserved layers.** Live today: `schema`, `containers`, `coordinates` (curl/div/grad), `derived` (magnitudes), `gpu`, `compute` (TS magnitude backend), `data`, `render`, `store`, `ui`, `app`, `workers`. Reserved stubs — `export {}` until their milestone, file header says which — `numerics`, `reductions`, `diagnostics`, `shaders`, `remote`, `embed`. The DAG is wired for all 18; the empty ones just have no impl yet.
- **v0.1 packaging: one package, `src/<layer>/` folders.** The 18-package pnpm-workspace split is deferred (DESIGN §Package shape, M2 checkpoint). Use path aliases (`@schema/*`, `@compute/*`, …), not deep relatives — they pre-stage the eventual `@webpic/<layer>` specifiers.
- **The math layers are pure.** Typed arrays in, typed arrays out. No `THREE.*`, no DOM, no `GPUDevice`. One TS reference impl per operator lives in `coordinates/` (e.g. `curl`); `compute/backends/ts` delegates to it, and cross-backend tests compare the WGSL kernel against it — never a duplicate.
- **Canonical names everywhere.** `B_1`, `B_2`, `B_3`, `|B|`, `beta`, `v_A`, `omega_p_s0` — same keys as `pypic.compute.RECIPES`. Aliases (`B_mag`, `plasma_beta`) resolve at boundaries only. Field component labels are **1-indexed**; array indices **0-indexed** (`B_1` ↔ component=0). `grep B_1` works across pypic, magviz, webpic.
- **Workers own their domain.** Each worker owns reads, compute, or trace — main thread orchestrates only. WebGPU compute runs inline on main (`GPUDevice` can't transfer); data reads run in a worker, and `ts`/`wasm` compute joins a `comlink` pool once ops get heavy (v0.1 runs the one cheap `|B|` op on main). Every subsystem owns its cleanup, in one of two shapes: **`install*(...)`** wires subscriptions/side-effects into the world and returns a disposer (`() => void`, or a small controller whose `.dispose()` is the teardown) — the UI panels, pointer handlers, app sync bridges; **`create*(host)`** constructs a stateful manager you drive and returns an object with lifecycle methods + `dispose()`, injected with a typed `host` of worker callbacks — the render managers (`layerRegistry`, `renderLoop`, `deviceRecovery`, `qualityController`, …). Either way teardown is deterministic; no globals.
- **One math dep outside render.** `gl-matrix` for `coordinates`/`numerics` (sole math dep, ~12 KB, zero THREE). No `THREE.Vector3` outside `render/`. `Vec3 = readonly [number, number, number]`.

## TypeScript

- **TS ≥ 6.0**, `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`. Strict everything is on in `tsconfig.base.json` — keep it on: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`.
- **Tooling:** Biome (lint), Vite (build), Vitest (test). Don't add ESLint/Prettier.
- **No `any`.** Use `unknown` and narrow. Type-only escape hatches (`as X`, `!`) need a one-line WHY comment.
- **Discriminated unions for state.** Exhaustiveness via `satisfies` or a `case _: const _x: never = x` arm in switches. Never `default: throw new Error('unreachable')`.
- **`readonly` aggressively.** `readonly [number, number, number]` for `Vec3`. `as const` for literal narrowing. `ReadonlyArray<T>` on inputs you don't write to. Don't mutate function inputs.
- **`import type`** for type-only imports — `verbatimModuleSyntax` will tell you when. Use the path aliases (`@schema/*`, `@store/*`, …) rather than long relatives.

## Memory & GC discipline

- **Hot paths use typed arrays.** Per-frame, per-step, per-particle: `Float32Array`, `Int32Array`, `Uint8Array`. Never `number[]`. Preallocate, reuse, pool. No closures-per-frame, no `.map`/`.filter` chains in inner loops, no array literals inside `for` bodies.
- **`subarray` aliases, `slice` copies.** Pick deliberately. Comment intent when non-obvious.
- **Workers: transfer, don't clone.** `worker.postMessage(payload, [buf.buffer])`. Never structured-clone a large `Float32Array`. `SharedArrayBuffer` only behind COOP/COEP — and document the dependency.
- **WebGPU:** one `GPUDevice` singleton; register `device.lost.then(reboot)`; call `.destroy()` on `GPUBuffer`/`GPUTexture`/`GPUQuerySet` you discard. Texture allocations go through a wrapper that halves resolution under pressure.
- **Profile before tuning.** DevTools "Performance → Memory" trumps micro-opts. Three similar inline loops beat a premature generic helper.

## Naming

- **Functions:** descriptive English — `magneticFieldMagnitude()`, `traceFieldLine()`, `plasmaBeta()`.
- **Parameters:** short scientific — `bx`, `rho`, `dt`, `qOverM`. The doc has the full description.
- **Variables in code:** descriptive — `electronDensity` not `ne`. Math symbols belong in docstrings, not identifiers.
- **Constants:** `UPPER_SNAKE_CASE`. **Booleans:** name as questions — `isPeriodic`, `hasField`.
- **File names mirror pypic** where the file maps to a pypic module — `plasma_beta.ts` ↔ `pypic.derived.plasma_beta` — but the recipe registers under the canonical short key (`'beta'`).
- **Magnitudes use literal pipes:** `'|B|'`, `'|E|'`, `'|V_s0|'`. `'B_mag'` is an alias (might be needed for Arrow).

## Async & cancellation

- **Every long-running op takes an `AbortSignal`.** Traces, reductions, prefetch, exports. Wire it through to the worker and respect it on the worker side (check between integration steps, throw `DOMException('aborted', 'AbortError')` on hit).
- `AsyncIterable` for streaming partial results; `Promise` for one-shot.
- No unhandled rejections. If you intentionally fire-and-forget: `void promise.catch(logError)` at the seam.

## Schema, validation, boundaries

- **Validate at boundaries only.** `smol-toml` parse + Zod (`zod/v4-mini` once we adopt it) on TOML loads, remote replies, OPFS reads. Never inside hot paths.
- **Reject unknown field names loudly.** Mirrors pypic's `KeyError` rule — silent warnings get swallowed in notebooks and pipelines. Use the canonical registry (planned `@webpic/schema`) as the only mapping from labels to canonical names.
- TOML via `smol-toml` (already a dep). Don't add `@iarna/toml`.

## Comments & docs

- **Default to no comments.** WHY only — non-obvious invariants, perf workarounds, links to upstream bugs.
- No `// --- Section ---` blocks. Use module structure or named functions.
- No plan/task references in code (e.g. "for Stage 4"). The git log is the audit trail.
- Mark deprecations: `// DEPRECATED: <short reason>`.
- JSDoc only on public API (future `@webpic/embed` exports). Skip on internal helpers — the type signature is the spec.

## Testing

- **Vitest.** Pure-function tests for the math layers (`coordinates/`, `numerics/`, `derived/`), `store/intents`, `compute/backends/ts`. Node mode by default.
- **Numerical kernels** test against analytical fixtures at explicit per-precision tolerances (`ts_f64`/`ts_f32`/`webgpu_f16`, in `tests/tolerances.ts`). `expect(a).toBeCloseTo(b, n)` for scalars; the array-wise `assertAllclose(actual, expected, TOL.ts_f64)` helper for fields. Live: the `coordinates` operators (curl/div/grad) + the magnitude family. The named MHD fixtures (Orszag–Tang, Harris, GEM) and cross-backend WGSL parity land with M3 compute.
- **No flaky render/visual tests.** One smoke E2E maximum.
- **Conservation tests** are gold: `div(curl F)` and `curl(grad f)` to machine precision (live in `coordinates/conservation.test.ts`); energy conservation in synthetic traces lands with field-line tracing (M4).
- No network, no large data files in fixtures. Synthetic over real.

## Dependencies

Don't add without justification matching `docs/DESIGN.md`. *Shipped:* `three` (`three/webgpu`, pinned — see below), `zarrita` (Zarr v3), `zod` (app), `smol-toml`, `zustand`. *Adopted when their layer lands:* `gl-matrix` (`coordinates`/`numerics`), `comlink` (compute worker pool, M3+), `zod/v4-mini` (embed build), `wesl-js` (gated on rustpic shared kernels). Cache keys use **inline FNV-1a**, so `xxhash-wasm` stays out unless FNV-1a proves insufficient. webpic **owns its control primitives** (slider/select/checkbox/text behind a `Pane`/`Folder`/`Binding` facade, lifted from magviz's `ui/controls`) — **no `tweakpane`**. GPU-timing comes from `gpu/profiler.ts` (`timestamp-query` + `performance.now` fallback), not `stats-gl`. v0.2 adds `h5wasm`, `hyparquet`, `apache-arrow`, `@duckdb/duckdb-wasm` (dynamic import only). Pin majors. Three.js: **pin exactly `three@0.184.0`** — latest, carries PR-#31607 (OffscreenCanvas-on-Worker; first shipped r180/`0.180.0`, fixing the r179 regression), not a floating range.

## Dev commands

```
npm run dev         # Vite dev server
npm run dev:lan     # HTTPS + LAN-exposed (iPad testing; certs via scripts/setup-lan-certs.sh)
npm run build       # production build
npm run typecheck   # app + worker tsconfigs
npm run lint        # Biome check
npm run test        # Vitest (node + dom projects)
npm run test:gpu    # real-GPU suites in headed system Chrome (local-only)
npm run format      # Biome format --write
```

## Progress

Milestones + live status: **`TASKS.md`** (`/tasks` to summarize). Design rationale: `docs/DESIGN.md`. Sibling ground truth: `../pypic/CLAUDE.md`.

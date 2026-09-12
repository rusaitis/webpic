# Project: webpic

webpic is a modern TypeScript/WebGPU plasma-physics data visualizer + lightweight analyzer — the 3D viewer leg of the pypic / rustpic / webpic toolchain. It reads pypic-blessed formats (Zarr v3, HDF5, Parquet), streams from `pypic.server`, and shares WGSL/WESL kernels with the upcoming `rustpic` simulator. Sibling `pypic` is the schema + physics authority.

## Docs map

- **CLAUDE.md** (this file) — conventions + layer model + commands. Always loaded; keep it lean.
- **TASKS.md** — milestone checklist; check off `[ ]` as you go. `/tasks` summarizes.
- **docs/DESIGN.md** — full design rationale (layer DAG, schema codegen, remote protocol, tolerances, risks). Read on demand — *not* `@`-imported, so it never bloats session context.
- `../pypic/CLAUDE.md` — sibling ground truth for canonical names + physics equations (read when needed).

## Architecture

- **Hard layer boundaries (pypic-mirrored).** 18 layers; `scripts/layers.ts` is the authority for the list and the allowed-import DAG (DESIGN §Layered dependency DAG). Rule of thumb: `schema` depends on nothing (root + canonical-name authority + shared scalar/geometry primitives — `@schema/math`'s `clamp`, `vec3`, `UNIT_BOX_HALF_EXTENT`); the math layers (`coordinates`/`numerics`/`reductions`/`derived`/`diagnostics`) are pure leaves; `ui` → `store` → `render`, and `ui` never imports `render` or calls `scene.add(...)` — it dispatches typed store intents. Boundary violations are CI errors (`scripts/check-boundaries.ts`, ts-morph).
- **Reserved layers** (`diagnostics`, `remote`) are a 3-line `export {}` stub whose header names the DESIGN section that activates them. The DAG is wired for all 18.
- **Single package, `src/<layer>/`;** path aliases (`@schema/*`, `@compute/*`, …) pre-stage the `@webpic/<layer>` split (DESIGN §Package shape). Never deep relatives.
- **The math layers are pure.** Typed arrays in, typed arrays out. No `THREE.*`, no DOM, no `GPUDevice`. One TS reference impl per operator lives in `coordinates/` (e.g. `curl`); `compute/backends/ts` delegates to it, and cross-backend tests compare the WGSL kernel against it — never a duplicate.
- **Canonical names everywhere.** `B_1`, `B_2`, `B_3`, `|B|`, `beta`, `v_A`, `omega_p_s0` — same keys as `pypic.compute.RECIPES`. Aliases (`B_mag`, `plasma_beta`) resolve at boundaries only. Field component labels are **1-indexed**; array indices **0-indexed** (`B_1` ↔ component=0). `grep B_1` works across pypic, magviz, webpic.
- **Workers own their domain.** Each worker owns reads, compute, or trace — the main thread orchestrates only (DESIGN §Worker message protocol, §Compute dispatcher).
- **Diagnostics go through `@schema/log`** (`logWarn`/`logError`/`rejectionLogger`, one swappable sink for embedders); raw `console.warn/error` only in the dependency-free `gpu/` leaf. Every fire-and-forget promise ends in `.catch(rejectionLogger(...))` — Biome's `noFloatingPromises` is on.
- **No math deps outside render.** `coordinates`/`numerics` shipped dependency-free typed-array code — the planned `gl-matrix` adoption proved unnecessary; don't add it without a demonstrated need. No `THREE.Vector3` outside `render/`. `Vec3 = readonly [number, number, number]`.

## Lifecycle & shape

- **Two shapes, both deterministic.** **`install*(...)`** wires subscriptions/side-effects into the world and returns a disposer (`() => void`, or a small controller whose `.dispose()` is the teardown) — the UI panels, pointer handlers, app sync bridges. **`create*(host)`** constructs a stateful manager you drive and returns an object with lifecycle methods + `dispose()`, injected with a typed `host` of worker callbacks — the render managers (`layerRegistry`, `renderLoop`, `deviceRecovery`, `qualityController`, …). Either way teardown is deterministic; no globals.
- `XHost` is declared immediately above `createX` and stays module-private unless a test imports it.
- A factory body caps at 150 lines and cognitive complexity at 20. Past that the state gets a named collaborator (`createLayerRegistry` → `createLayerEpochs` + `createLayerComposite`), not another inner closure. `biome.jsonc` carries the live ceilings — they sit at today's worst value and only ever fall, so nothing new may be worse than the worst thing already here. A body that is long *by construction* (the worker world, whose body is the worker's state) takes a one-line `biome-ignore` naming that reason; a stale suppression is itself an error.
- Disposers run LIFO; the one collector is `ui/subscriptions.ts` `createSubscriptions` — never a hand-ordered unsub list.
- DOM listeners tear down via one `AbortController` + `{ signal }`, never manual `removeEventListener`.
- Every WGSL/TSL kernel has a pure-TS twin that is the tested reference (`schema/rayBox.ts` ↔ `hitBox`); never a second implementation.

## TypeScript

- **TS ≥ 6.0**, `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`. Strict flags live in `tsconfig.base.json`; never loosen them. `verbatimModuleSyntax` + Biome enforce `import type`, no `any`, exhaustive switches, no floating promises — the tools tell you.
- **Tooling:** Biome (lint), Vite (build), Vitest (test). Don't add ESLint/Prettier.
- **No `any`.** Use `unknown` and narrow. Type-only escape hatches (`as X`, `!`) need a one-line WHY comment; better still, a typed constructor that removes the cast (`vec3(x,y,z)` over `[x,y,z] as Vec3`).
- **Discriminated unions for state.** Exhaustiveness via `satisfies` or a `case _: const _x: never = x` arm in switches. Never `default: throw new Error('unreachable')`.
- **`readonly` aggressively.** `readonly [number, number, number]` for `Vec3`. `as const` for literal narrowing. `ReadonlyArray<T>` on inputs you don't write to. Don't mutate function inputs.

## Memory & GC discipline

- **Hot paths use typed arrays.** Per-frame, per-step, per-particle: `Float32Array`, `Int32Array`, `Uint8Array`. Never `number[]`. Preallocate, reuse, pool. No closures-per-frame, no `.map`/`.filter` chains in inner loops, no array literals inside `for` bodies.
- **`subarray` aliases, `slice` copies.** Pick deliberately. Comment intent when non-obvious.
- **Workers: transfer, don't clone.** `worker.postMessage(payload, [buf.buffer])`. Never structured-clone a large `Float32Array`. `SharedArrayBuffer` only behind COOP/COEP — and document the dependency.
- **WebGPU:** one `GPUDevice` singleton; register `device.lost.then(reboot)`; call `.destroy()` on `GPUBuffer`/`GPUTexture`/`GPUQuerySet` you discard. Big buffers allocate at their site and report bytes to `gpu/vramLedger.ts`. Interaction-time pressure scales the **swapchain render scale** (`renderer.setRenderScale` via `qualityController`), not texture resolution.
- **Profile before tuning.** DevTools "Performance → Memory" trumps micro-opts. Three similar inline loops beat a premature generic helper.

## Naming

- **Functions:** descriptive English — `magneticFieldMagnitude()`, `traceFieldLine()`, `plasmaBeta()`.
- **Parameters:** short scientific — `bx`, `rho`, `dt`, `qOverM`. The doc has the full description.
- **Variables in code:** descriptive — `electronDensity` not `ne`. Math symbols belong in docstrings, not identifiers.
- **Constants:** `UPPER_SNAKE_CASE`.
- **Booleans are questions** — `isPeriodic`, `hasField`, `shouldRetrace` — for fields, params and locals. Exceptions, all on the store→render wire where they mirror three.js or a shader uniform: `visible`, `shaded`, `continuous`, `active`.
- **One spelling per concept:** `options` (never `opts`), `element` (never `el`), `context` (never `ctx`; `ctx` only for a `CanvasRenderingContext2D`/`GPUCanvasContext` local), `signal`, `dispose`.
- **Log scopes** are a closed union in `@schema/log` (`LogScope`): layer names for layers (`"zarr"`, `"theme"`), `"<x> worker"` for workers, `"boot"`/`"app"` for the main thread.
- No `handleX` — name the verb: `openDataset`, not `handleOpen`.
- `_`-prefixed files (`_registry.ts`, `_protocols.ts`) are a folder's infrastructure, sorted above the concrete implementations.
- **File names mirror pypic** where the file maps to a pypic module — `plasma_beta.ts` ↔ `pypic.derived.plasma_beta` — but the recipe registers under the canonical short key (`'beta'`).
- **Magnitudes use literal pipes:** `'|B|'`, `'|E|'`, `'|V_s0|'`. `'B_mag'` is an alias (might be needed for Arrow).

## Async & cancellation

- **Every long-running op takes an `AbortSignal`.** Traces, reductions, prefetch, exports. Wire it through to the worker and respect it on the worker side (check between integration steps, throw `DOMException('aborted', 'AbortError')` on hit).
- `AsyncIterable` for streaming partial results; `Promise` for one-shot.
- No unhandled rejections. If you intentionally fire-and-forget: `void promise.catch(logError)` at the seam.

## Schema, validation, boundaries

- **Validate at boundaries only.** `smol-toml` parse + Zod on TOML loads, remote replies, OPFS reads. Never inside hot paths.
- **Reject unknown field names loudly.** Mirrors pypic's `KeyError` rule — silent warnings get swallowed in notebooks and pipelines. `src/schema/registry.ts` is the only mapping from labels to canonical names.
- TOML via `smol-toml` (already a dep). Don't add `@iarna/toml`.

## Comments & docs

- WHY only. A file may open with a prose header explaining the invariant it owns — at most 6 lines. Longer rationale goes to `docs/DESIGN.md` and is cited by section name (`§Caching`), never line number; `tests/design-citations.test.ts` fails on a § that isn't a heading.
- No comment block longer than the code it annotates. If the comment is bigger, the code needs a name, not a paragraph.
- No `/**` outside the `@embed` surface (`schema`, `containers`, `coordinates`, `numerics`, `reductions`, `derived`, `compute`, `data/readers`, `data/writers`, `embed`) — asserted at zero. Internal contracts get a `//` line above the interface. File headers are a per-layer ratchet in the same test, at today's worst file. `tests/comment-budget.test.ts` holds both (Biome has no rule for either).
- No history, no roadmap, no magviz provenance ("lifted from") in comments. Markers: `// DEPRECATED: <reason>` and `// STAGED: <what activates it>` (file header, one line) are the only sanctioned past/future references. Unwired code without a `STAGED:` header gets deleted.
- No `// --- Section ---` blocks. Use module structure or named functions.
- Error messages lead with the canonical function/subsystem name, then expected-vs-got including the offending value: `` `partialAlongAxis: axis ${axis} needs ≥2 samples, got ${n}` ``.

## Testing

- **Vitest.** Pure-function tests for the math layers (`coordinates/`, `numerics/`, `derived/`), `store/intents`, `compute/backends/ts`. Node mode by default. What is covered and why: DESIGN §Testing strategy.
- Placement: `foo.test.ts` beside `foo.ts`. Suffix picks the runner: `.test.ts` node · `.dom.test.ts` happy-dom · `.browser.test.ts` headed Chrome (`test:gpu`, local-only). `tests/` holds cross-layer meta-guards (boundaries, aliases, embed surface + built bundle, goldens, parity, WGSL layout, doc citations, comment budget) plus the shared fixtures and the render-worker harness — anything importing `vitest` lives here, never in `src/`.
- `describe("<exported symbol>")`, `it("<lowercase sentence about the guarantee>")`. Never `should`, `works`, `correctly`.
- Every `install*` has a `.dom.test.ts`; every `create*` a `.test.ts`. A source file with no test is a review comment.
- Synthetic grids/fields/datasets come from `tests/fixtures.ts` (`makeGrid`, `makeField`, `makeDataset`, `ballField`); never re-roll one locally.
- **Numerical kernels** test against analytical fixtures at explicit per-kernel × per-precision tolerances (`TOL.<kernel>.<precision>`, precisions `ts_f64`/`ts_f32`/`webgpu_f32`/`webgpu_f16`, in `tests/tolerances.ts`). Numeric assertions go through `assertAllclose` + a `TOL.<kernel>.<precision>` cell; a bare epsilon literal in a kernel suite is a bug. `toBeCloseTo(x, n)` never omits `n`. `KERNELS` covers magnitude/div/curl/grad **and trace/interp**.
- **Conservation tests** are gold: `div(curl F)` and `curl(grad f)` to machine precision (`coordinates/conservation.test.ts`); the trace analogue is pypic golden parity + the closed-loop radius invariant (`streamlines.browser`, `test:gpu`).
- Every validation boundary gets a malformed-input test (wrong type, missing key, truncated buffer). Worker `default:` never-arms are covered, not assumed. A pypic reduced dataset (singleton axis) is a first-class input.
- Superseding tasks are tested on both contracts: old signal aborts **and** old commit is discarded. `dispose()` is tested for idempotence and for dispose-during-in-flight.
- Randomness only via `seededRandom`; async settles via `flushAsync`; no `setTimeout(r, N>0)`.
- **No flaky render/visual tests.** One smoke E2E maximum. No network, no large data files in fixtures. Synthetic over real.
- Generated files: `*.generated.ts`, fixed 2-line `@generated` header, committed on purpose (webpic builds without Python), exempt from lint/coverage/import-sort.

## Dependencies

Don't add without justification matching `docs/DESIGN.md` §Build system & tooling. *Shipped:* `three` (`three/webgpu`, exact pin), `zarrita` (Zarr v3), `zod` (app), `smol-toml`, `zustand`. *Adopted when their layer lands:* `comlink` (compute worker pool), `zod/v4-mini` (embed build, only if the budget headroom tightens), `wesl-js` (gated on rustpic shared kernels), `h5wasm`, `hyparquet`, `apache-arrow`, `@duckdb/duckdb-wasm` (dynamic import only, with the HDF5/Parquet/Arrow readers). GPU timing comes from `gpu/profiler.ts`, not `stats-gl`. Pin majors — except three.js: **pin exactly `three@0.185.1`** for PR-#31607 (OffscreenCanvas-on-Worker), not a floating range; bump deliberately, with the full GPU gate.

## Dev commands

```
npm run check       # the full gate — exactly what CI runs
npm run dev         # Vite dev server
npm run dev:lan     # HTTPS + LAN-exposed (iPad testing; certs via scripts/setup-lan-certs.sh)
npm run build       # production build
npm run typecheck   # app + worker + node tsconfigs
npm run lint        # Biome check
npm run test        # Vitest (node + dom projects)
npm run test:coverage # Vitest + v8 coverage (report only, no gate)
npm run check:dead  # knip — unused files, exports, deps
npm run docs:api    # TypeDoc, treatWarningsAsErrors — a CI gate
npm run format      # Biome format --write
npm run gen:themes:check # local-only (needs ../pypic)
npm run test:parity # schema + writer parity vs live pypic — local-only (needs ../pypic)
npm run test:gpu    # real-GPU suites in headed system Chrome — local-only (needs a real GPU)
npm run perf:gate   # cold-paint / first-frame gate — local-only (needs a real GPU)
```

## Progress

Milestones + live status: **`TASKS.md`** (`/tasks` to summarize). Design rationale: `docs/DESIGN.md`. Sibling ground truth: `../pypic/CLAUDE.md`.

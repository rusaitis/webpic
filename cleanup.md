# webpic — rules that stick, enforcement, and the slop cull

## Context

After the 2026-09 code-health review landed (`1a9f723`, `073ee66`, `4d80afb`), Leo asked what the two instruction files (`~/.claude/CLAUDE.md`, `webpic/CLAUDE.md`) should add or change so the code stays clean, human-friendly, well-tested and Occam-shaped, and which practical things we're still not doing. Three read-only audits (slop patterns, test quality, rules-vs-reality) were run and their sharp claims re-verified by hand.

**Verdict:** every rule that a tool can check is obeyed essentially perfectly (0 `any`, 0 `!`, 0 `TODO`, 0 `should`-tests, 0 unseeded randomness, 0 boundary violations, 2 exact clones in 27k lines). The slop that exists is of one specific kind — **the design document has been transcribed into the code, and seams were built for systems that don't exist** — plus a cluster of stated rules nobody enforces, and CLAUDE.md itself being the worst offender on three of its own rules.

**Decisions (Leo, 2026-09-10):** codify the WHY-header house style with hard caps and cull only violators; delete the measured-negative dormant code and STAGED-mark the roadmap ones; normalize internal names but widen the boolean rule for wire fields; execute all tiers (rules → enforcement → tests → cull). No commits/pushes unless asked.

## Baseline (verified 2026-09-10)

| finding | number |
|---|---|
| comment lines / hand-written non-test lines | 4 403 / 20 706 (**21 %**; `render` 31 %, `store` 24 %) |
| `/**` blocks in non-test `src/` | 520 — **385** in `render`/`ui`/`app`/`store`, layers `@embed` does not export; 1 on the actual public facade |
| file headers > 6 lines | 16 files (max 17: `data/prefetch.ts`, `shaders/kernels/streamline.wgsl.ts`) |
| comment blocks longer than the code they annotate | 96 |
| history ("used to", "no longer") / roadmap ("deferred", "will land") comments | ~20 / ~28 |
| boolean fields not named as questions | 74 (rule allows one exception: `visible`) |
| `opts`/`options`, `el`/`element`, `ctx`/`context` | 170/134, 80/75, 169/13 |
| exports with zero external references | 125 (+74 test-only) |
| `*Host` interfaces never referenced outside their file | 13 of 14 |
| casts without a WHY | 27 of 33 |
| milestone tags (`M6.6`, `M3+`, `v0.2`…) in CLAUDE.md vs `src/` | **13 vs 0** |
| `toBeCloseTo` with the default 2-digit tolerance | 16 |
| `@schema/log` scopes | 9 strings, 3 naming schemes (`"zarr"`, `"render worker"`, `"boot"`) |
| files at 0 % coverage that aren't GPU-only | `ui/perfHud.ts` (244 L), `app/perfBridge.ts`, `workers/data.worker.ts` |
| WGSL sources validated off-GPU | 0 of 3 |
| `src/workers` seen by `check-boundaries` | **no** (`tsconfig.json` excludes it; `ALLOWED_IMPORTS.workers` is dead config) |
| app bundle budget | `package.json` 550 kB; `README.md:132`, `DESIGN.md:808,899,967` still say 1.6 MB |

Verified dead: `addVolumeLayer`/`addSliceLayer` (0 production callers), `skipEmptySpace` (nothing outside `render/volume` can set it; its own header measures 1.7× slower), `setLogSink` (0 callers, 0 tests — but it *is* the embedder seam, keep + test). Unwired without a `STAGED:` header: `data/cache.ts`, `compute/backends/webgpu/streamlines.ts`. `data/writers/zarr.ts` is public `@embed` surface, not dead.

---

## [x] Part 1 — `~/.claude/CLAUDE.md` (global, language-agnostic)

Add a `## Code hygiene` section between "Code style" and "Commits". Each line is grounded in something measured above; wording is final.

```
## Code hygiene

- Comments carry WHY. Never restate the line below; if comment and code say the same thing, delete the comment.
- No API-doc block (`/** */`, docstring, `///`) on anything outside a published surface — the signature is the spec.
- Comments describe the present. No history ("used to", "replaces the old") and no roadmap ("will land", "for now") — git log and the plan file hold those. A `STAGED:` header is the one sanctioned forward reference.
- Don't add checks the type system already excludes. Validate at boundaries (I/O, wire, user input), nowhere else.
- Abstract on the second real caller, never the first. A registry with one entry, a generic with one instantiation, a wrapper that only forwards, an interface with one implementation and no test seam — each is just the concrete thing.
- Don't export what nothing outside the file imports.
- Prefer deleting to adding. A change that removes lines at equal behavior is the better change; a measured-negative optimization is deleted, not flagged off.
- Escape hatches (casts, `unwrap`, `# type: ignore`, `unsafe`) carry a same-line reason, or you find the typed construction instead.
- Booleans are questions (`isOpen`, `hasField`); pick one spelling per concept (`options` not `opts`) and never mix.
- Tests name behavior, not implementation: the test name is a sentence about what the code guarantees.
- No emojis in code, comments, commits or docs. Unicode that carries meaning (≥, ×, ‖B‖, α) is fine.
- Report verification as the commands run and their result, naming which suite/project. If you didn't run it, say so.
- When two options differ only in taste, take the boring one and move on; when they differ in behavior or blast radius, ask.
```

Also tighten the existing "Code style" bullet "No plan/task/milestone references in code comments" to "…in code comments **or in CLAUDE.md files**".

---

## [x] Part 2 — `webpic/CLAUDE.md` rewrite

Target: same file, ~30 % shorter, every sentence either a rule or a pointer. Keep the section order; edits below.

### 2a. Cut — narrative that already lives in DESIGN (cite the § instead)

- §Architecture "Built vs reserved layers" inventory (~130 w) → one line: *"18 layers; `scripts/layers.ts` is the authority. Reserved layers are a 3-line `export {}` stub whose header names the milestone doc section that activates them."* (→ DESIGN §Layered dependency DAG)
- §Architecture "v0.1 packaging" paragraph → *"Single package, `src/<layer>/`; path aliases pre-stage the `@webpic/<layer>` split (DESIGN §Package shape)."*
- §Architecture "Workers own their domain" first half (comlink pool, GPUDevice can't transfer) → DESIGN §Worker message protocol. **Keep** the `install*`/`create*(host)` contract and promote it to its own `## Lifecycle` section — it's the file's most actionable rule and is buried mid-bullet.
- §Memory "No central texture-allocation wrapper…" → keep only *"big buffers allocate at their site and report bytes to `gpu/vramLedger.ts`."*
- §Dependencies sentences 3–9 (PR-#31607 history, xxhash, tweakpane, stats-gl) → DESIGN §Build already has them verbatim. Keep the shipped list, the three pin, the "don't add without justification" line, and the *adopted-when* list without milestone tags.
- §Testing sentence 2 (the live-fixture inventory) → DESIGN §Testing strategy.
- §TypeScript strict-flag list → *"Strict flags live in `tsconfig.base.json`; never loosen them. `verbatimModuleSyntax` + Biome enforce `import type`, no `any`, exhaustive switches, no floating promises — the tools tell you."*

### 2b. Fix — stale and contradictory

- `:58` "planned `@webpic/schema`" → `src/schema/registry.ts` (shipped).
- `:57` "`zod/v4-mini` once we adopt it" → delete; `:80` already states it conditionally.
- `:19` comlink pool sentence → cut (moves to DESIGN).
- Strip all 13 milestone tags from CLAUDE.md (`M6.6`, `M3+`, `M6.7`, `M4`, `M0/M2`, `v0.1`/`v0.2` …); the rule at `:65` now applies to this file.
- Dev-commands comment `# M0/M2 acceptance numbers` → `# cold-paint / first-frame gate (local-only)`.
- `:87` typecheck wording is already right; add `npm run check` (Part 3) as the first line of §Dev commands.

### 2c. Rewrite §Comments to codify the house style

```
## Comments & docs

- WHY only. A file may open with a prose header explaining the invariant it owns — at most 6 lines. Longer rationale goes to `docs/DESIGN.md` and is cited by section name (`§Caching`), never line number; `tests/design-citations.test.ts` fails on a § that isn't a heading.
- No comment block longer than the code it annotates. If the comment is bigger, the code needs a name, not a paragraph.
- No `/**` outside the `@embed` surface (`schema`, `containers`, `coordinates`, `numerics`, `reductions`, `derived`, `compute`, `data/readers`, `data/writers`, `embed`). Internal contracts get a `//` line above the interface. `tests/jsdoc-surface.test.ts` enforces it (Biome has no rule for this).
- No history, no roadmap, no magviz provenance ("lifted from") in comments. Markers: `// DEPRECATED: <reason>` and `// STAGED: <what activates it>` (file header, one line) are the only sanctioned past/future references. Unwired code without a `STAGED:` header gets deleted.
- Error messages lead with the canonical function/subsystem name, then expected-vs-got including the offending value: `` `partialAlongAxis: axis ${axis} needs ≥2 samples, got ${n}` ``.
```

### 2d. Naming — widen and make it real

```
- **Booleans are questions** — `isPeriodic`, `hasField`, `shouldRetrace` — for fields, params and locals. Exceptions, all on the store→render wire where they mirror three.js or a shader uniform: `visible`, `shaded`, `continuous`, `active`.
- **One spelling per concept:** `options` (never `opts`), `element` (never `el`), `context` (never `ctx`; `ctx` only for a `CanvasRenderingContext2D`/`GPUCanvasContext` local), `signal`, `dispose`.
- **Log scopes** are a closed union in `@schema/log` (`LogScope`): layer names for layers (`"zarr"`, `"theme"`), `"<x> worker"` for workers, `"boot"`/`"app"` for the main thread.
- No `handleX` — name the verb: `openDataset`, not `handleOpen`.
- `_`-prefixed files (`_registry.ts`, `_protocols.ts`) are a folder's infrastructure, sorted above the concrete implementations.
```

### 2e. New `## Lifecycle & shape` (promoted from §Architecture)

- The `install*(...) → Disposer | controller` and `create*(host: XHost)` contract, verbatim from today's `:19` second half, plus:
- *"`XHost` is declared immediately above `createX` and stays module-private unless a test imports it."*
- *"A factory body caps at ~150 lines. Past that the state gets a named collaborator (`createLayerRegistry` → `createLayerEpochs` + `createCompositeCache`), not another inner closure. Biome `noExcessiveLinesPerFunction` ratchets this."*
- *"Disposers run LIFO; the one collector is `ui/subscriptions.ts` `createSubscriptions` — never a hand-ordered unsub list."*
- *"DOM listeners tear down via one `AbortController` + `{ signal }`, never manual `removeEventListener`."*
- *"Every WGSL/TSL kernel has a pure-TS twin that is the tested reference (`schema/rayBox.ts` ↔ `hitBox`); never a second implementation."*

### 2f. New `## Tests` conventions block (implicit → explicit)

```
- Placement: `foo.test.ts` beside `foo.ts`. Suffix picks the runner: `.test.ts` node · `.dom.test.ts` happy-dom · `.browser.test.ts` headed Chrome (`test:gpu`, local-only). `tests/` holds only cross-layer meta-guards (boundaries, aliases, embed surface, goldens, parity).
- `describe("<exported symbol>")`, `it("<lowercase sentence about the guarantee>")`. Never `should`, `works`, `correctly`.
- Every `install*` has a `.dom.test.ts`; every `create*` a `.test.ts`. A source file with no test is a review comment.
- Synthetic grids/fields/datasets come from `tests/fixtures.ts` (`makeGrid`, `makeField`, `makeDataset`, `ballField`); never re-roll one locally.
- Numeric assertions go through `assertAllclose` + a `TOL.<kernel>.<precision>` cell; a bare epsilon literal in a kernel suite is a bug. `toBeCloseTo(x, n)` never omits `n`. `KERNELS` covers magnitude/div/curl/grad **and trace/interp**.
- Every §Schema boundary gets a malformed-input test (wrong type, missing key, truncated buffer). Worker `default:` never-arms are covered, not assumed. A pypic reduced dataset (singleton axis) is a first-class input.
- Superseding tasks are tested on both contracts: old signal aborts **and** old commit is discarded. `dispose()` is tested for idempotence and for dispose-during-in-flight.
- Randomness only via `seededRandom`; async settles via `flushAsync`; no `setTimeout(r, N>0)`.
- Generated files: `*.generated.ts`, fixed 2-line `@generated` header, committed on purpose (webpic builds without Python), exempt from lint/coverage/import-sort.
```

### 2g. §Dev commands

Add `npm run check` first (mirrors CI exactly), `npm run check:dead` (knip), and mark `gen:themes:check`, `test:parity`, `test:gpu`, `perf:gate` as `# local-only (needs ../pypic | real GPU)`.

---

## [x] Part 3 — Enforcement tooling (each its own small commit)

| # | change | files |
|---|---|---|
| T1 ✓ | `check-boundaries.ts` also loads `tsconfig.worker.json` (add source files from a second `Project`, or `project.addSourceFilesAtPaths("src/workers/**/*.ts")`); `tests/boundaries.test.ts` gets a case proving a `src/workers` → `@ui` import is caught | `scripts/check-boundaries.ts`, `tests/boundaries.test.ts` |
| T2 ✓ | `"check": "npm run typecheck && npm run check:boundaries && npm run gen:check && npm run lint:ci && npm run test && npm run build && npm run build:embed && npm run docs:api && npm run size"`; lefthook pre-push runs `check:boundaries` + `lint:ci` alongside typecheck/test (still ~12 s) | `package.json`, `lefthook.yml` |
| T3 ✓ | Budget docs: 550 kB in `README.md:132`, `DESIGN.md:808,899,967`; DESIGN `:807` "project references" and `:811` "tint validator (planned)" corrected | docs |
| T4 ✓ | `knip` (devDep, `knip.json` with entries `src/app/main.ts`, `src/workers/*.ts`, `src/embed/index.ts`, `scripts/*.ts`, `tests/**`; ignore `*.generated.ts`) → `check:dead`; run in CI. First run drives the export cull in Part 5 | `package.json`, `knip.json`, `ci.yml` |
| T5 ✓ | `tests/design-citations.test.ts`: grep `§[^,)\]]+` across `src/`, `scripts/`, `CLAUDE.md`; assert each resolves to a `#` heading in `docs/DESIGN.md` (normalize case/punctuation). Fixes the 9 dangling names (`§Run metadata`, `§Public library export`, `§"Layers & navigation"`, `§Time-series`, `§CI`) by either promoting the bold text to a heading or correcting the cite | new test, DESIGN headings |
| T6 ✓ | `tests/jsdoc-surface.test.ts`: assert no `/**` in `src/{render,ui,app,store,gpu,shaders,workers}/**` (non-test). **Landed as a ratchet instead** (a rule held until the code deserves it protects nothing meanwhile): `tests/comment-budget.test.ts` asserts a per-layer ceiling at today's count — render 167 · ui 110 · app 56 · store 52 · gpu 27 · shaders/workers 0 — that only falls, plus a slack guard so a cull commit must lower the number. A row reaching 0 *is* the strict rule | new test |
| T7 ✓ | `tests/wgsl.test.ts`: `wgsl_reflect` (devDep) parses `fieldOps.wgsl.ts`, `streamline.wgsl.ts`, `prelude.wgsl.ts` and the declared `@binding` layout matches what `gpu/computeKernel.ts` / `gpu/streamlineKernel.ts` bind. Parse-level only — CI proves they *compile*, `test:gpu` proves they *run* | new test |
| T8 ✓ | `@schema/log`: `export type LogScope = "boot" \| "app" \| "zarr" \| "readers" \| "theme" \| "trace" \| "calibration" \| "render worker" \| "data worker"`; `scope: LogScope`; one test for `setLogSink` (the untested embedder seam) | `src/schema/log.ts` + test |
| T9 ✓ | Biome: `complexity.noExcessiveCognitiveComplexity` (level warn → error once clean, `maxAllowedComplexity` 20) and `nursery.noExcessiveLinesPerFunction` with `maxLines` set to today's max after the Part 5 splits (ratchet, never grows); `correctness.noUnusedVariables`/`noUnusedFunctionParameters` error **(landed — clean)**; `style.useFilenamingConvention` **off** (pypic snake_case — already off, not in `recommended`). **Both ratchets landed at today's worst value** (complexity 62, lines 311) rather than waiting: 26 non-test functions exceed complexity 20 and 20 exceed 150 lines, so the ceilings block regressions now and fall with each 5d split. Corrections: both rules live in `complexity` (`nursery.noExcessiveLinesPerFunction` is a hard config error in Biome 2.4.x), tests are exempt from the lines rule (a 546-line `describe` body is not the smell), and `render/worker.ts` takes the one structural `biome-ignore` — its body *is* the worker's state. Biome flags a suppression that stops applying, so it cannot outlive the split. `biome.json` → `biome.jsonc` so each ceiling carries its target inline | `biome.json` |
| T10 ✓ | `tsconfig.base.json`: `noUnusedLocals`, `noUnusedParameters` | tsconfig |
| T11 ✓ | `tests/embed-bundle.test.ts` (node project, runs after `build:embed` in CI): read `dist-embed/*.js`, assert no `three`/`THREE.` marker, no `document.`, no `duckdb`/`h5wasm` string | new test, `ci.yml` step order |
| T12 ✓ | `.editorconfig` (2-space, lf, utf-8, width 100), `.npmrc` `engine-strict=true` | root |

Not adding: coverage gate (stays a report), `useNamingConvention`, `noBarrelFile`, cspell/markdownlint/actionlint (no signal for a 1-dev repo), CONTRIBUTING.md (README already points at CLAUDE.md), CHANGELOG (Zenodo + tags suffice).

---

## [x] Part 4 — Test-suite gaps (each its own commit)

1. **TOL ladder completeness.** `tests/tolerances.ts`: add `trace` and `interp` kernels with measured `ts_f64`/`ts_f32`/`webgpu_f32` cells; move `streamlines.browser.test.ts:125-154` literals onto `TOL.trace.*`; replace `parity.browser.test.ts:109,112` (`1e-3`, 3 digits) with `assertAllclose(…, TOL.magnitude.webgpu_f32)` — if it fails, widen the cell with a measured reason per the ladder's own rule. Move the 15 `Math.abs(...) < 1e-N` sites in `numerics/*.test.ts`, `store/camera.test.ts`, `render/pickRay.test.ts` onto named constants.
2. **Bare `toBeCloseTo`**: give all 16 an explicit `n` (priority: `webgpu.test.ts:71-73` uniform packing, `managedMarker.test.ts:134`). Replace `normalization.test.ts:89-91`'s three `not.toThrow()` with assertions on the resulting window/scale.
3. **Singleton-axis path.** `operators.test.ts`: `[8,8,1]` throws `/needs ≥2 samples/`; `compute/field.test.ts`: a reduced dataset is rejected at the dispatcher (`field.ts:40`) with the canonical message, not deep in `partialAlongAxis`. Fix `field.ts` gate accordingly.
4. **`numerics/interp.test.ts`** (new): the five guards at `interp.ts:38-42`, the −0.5 cell-center invariant at `t=0` and `t=dim−1`, out-of-domain returns `false` with `out` untouched.
5. **`store/supersedingTask.test.ts`** (new): superseded body resolving last sees `isCurrent() === false` and its commit never lands.
6. **Worker malformed messages**: post `{kind:"nonsense"}` and a `dtype`/`byteLength` mismatch to `render/worker.ts` (via `render/testing/workerHarness.ts`) and `workers/data.worker.ts`; assert the never-arms throw with the payload in the message. Gives `data.worker.ts` its first coverage.
7. **`ui/perfHud.dom.test.ts`** (new): number formatting + `Infinity`/`NaN` sample paths, modeled on `timingPanel.dom.test.ts`. `app/perfBridge.test.ts` (new): message routing.
8. **Fixtures consolidation**: promote `makeGrid(shape, spacing, origin?)`, `makeField(name, data, shape)`, `ballField(n, radius)` into `tests/fixtures.ts` (+ `tests/fixtures.browser.ts` for the GPU suites); delete the 8 local clones (`numerics/tracing.test.ts:21`, `data/stagger.test.ts:125-152`, `store/seedPick.test.ts:15`, `data/writers/zarr.test.ts:52-68`, `tests/writer-parity.test.ts:22-35`, `containers/grid.test.ts:5`, `store/simulation.test.ts:14`, `app/sceneSync.test.ts:9`, the 4 `ballField` copies in `render/*.browser.test.ts`).
9. **`theme.ts:252`**: wrap `parseToml` so a syntax error surfaces as the promised `Invalid theme in "<name>"`; test with malformed TOML + wrong-type value.
10. **Dispose-during-in-flight** for `installGpu` and `createStreamRing` (one test each).

**Landed 2026-09-12.** Gate green (`npm run check`, `test:gpu` 47/47, `test:parity` 1371/1371);
coverage 78.2 % → 81.3 % lines. Three production defects the tests found, fixed with them:

- `gpu/device.ts` — a `dispose()` landing mid-recovery let the re-acquired device re-install itself
  behind the caller's back (orphan device; next `installGpu()` threw "already installed"). Guarded
  by a `session` counter compared across the await.
- `render/layerRegistry.ts` `decodeSliceField` — no size check, so a wrong `dtype`/`shape` silently
  reinterpreted the buffer (the very thing its own comment warned about). Now throws; hoisted to
  module scope so the factory stays under the Biome line ceiling.
- `schema/theme.ts` — `parseToml` sat outside the guarded block, so malformed TOML escaped as
  smol-toml's bare `SyntaxError`; and the message read `Invalid theme in theme "x"`.

Deviations from the plan, each deliberate:

- **2** — all 16 bare `toBeCloseTo` turned out to be exact round-trips, so they are `toBe` now
  (stronger than an explicit `n`, and the uniform-packing case is byte-exact as a layout test should be).
- **1** — `trace`/`interp` rows added, but the per-fixture golden tolerances in `traces.golden.test.ts`
  (smooth/rotational) stay local: they bound numpy-vs-TS summation order per curve, not a precision
  class. `integrators.test.ts` stays off the ladder too (truncation, not precision). The rotational
  loop's `1e-4` tightened onto `TOL.trace.webgpu_f32` (1e-5) and holds on M2.
- **1** — `assertAllclose` now scans and issues one `expect` naming the worst index, so it can carry
  the 256³ parity array (per-element `expect` would have taken minutes). `maxAbsDiff` died with it.
- **8** — no `tests/fixtures.browser.ts`: the GPU suites import `tests/fixtures.ts` directly and it
  resolves fine. `gridOf` (a third spelling, in `analyticFieldCore.ts`) collapsed into `makeGrid`;
  `makeDataset`'s overrides widened to `Partial<FieldDataset>` so the two writer suites could drop
  their 40-line dataset clones. `raymarch.browser.test.ts`'s `centralBallField` left alone — it
  belongs to the empty-space-skip path Part 5a deletes.
- **7** — `app/perfBridge.dom.test.ts`, not `.test.ts`: it mounts the HUD, so it needs happy-dom
  (and the `install*` rule asks for `.dom.test.ts`).

---

## [x] Part 5 — Code cull (matches the rules; several commits by layer)

**Landed 2026-09-12** in four commits: `27acce5` (dead code), `5b68303` (naming), `c85ffb2` (comments),
`0c80278` (shape). Gate green on each; `test:gpu` 46/46, `test:parity` 1431/1431, perf gate 105 ms cold
paint / 258 ms first frame, coverage 81.3 % → 82.55 %, knip unused exports 148 → 8.

Deviations, each after inspection rather than by omission:

- **5a** — `managedOverlay.ts` does NOT collapse into its caller: 24 lines with a 122-line test, and its
  caller is `render/worker.ts`, the one body already over the Biome line ceiling. `isKnownPanel` +
  `SERVED_ELSEWHERE` stay: their only user is the theme-drift guard, which is the test seam the rule
  exempts. The registry collaborators are `createLayerEpochs` + `createLayerComposite`, not
  `createCompositeCache` — there is no cache, there is an ordered view.
- **5c** — the "27 bare casts" re-measured at **zero**: every cast in non-test source already carried a
  WHY. Four DOM/wire/user contracts keep their spelling (`data-docked`, `?debugScene`, the `"opened"`
  message kind, and the sanctioned wire booleans). `transferableBuffer` needed `schema` from `workers`,
  which the DAG had not granted; the row gained it (schema is the dependency-free root).
- **5b** — the comment ratio lands at **17.2 % overall / 23.2 % render**, not 12 %/20 %: a scan for
  comments restating the line below them found one in the whole tree. The `/**` ratchet reached 0 on
  every layer and became the strict rule; file headers got a new per-layer ratchet beside it.
- **5d** — `rangeMath`'s "triple guard" survives: two are each exported function's own contract, and the
  third is not provably dead (denormal underflow in `niceStep`). Biome ratchets fell 311 → 310 lines and
  62 → 52 complexity; 56 tests were added for the new collaborators.

### 5a. Dead & dormant
- Delete `store/layersSlice.ts:71-79` `addVolumeLayer`/`addSliceLayer` + their `state.ts` declarations (`:113-116`, one of which describes a `V` shortcut that doesn't exist) + test references (switch to `addLayerOfKind`).
- Delete the empty-space-skip path: `render/volume/minMaxGrid.ts`, `brickStep.ts`, `raymarchScene.ts` `buildSkipState`/`brickAdvance`/`SkipTexture`/`skipEmptySpace` option, their tests, the `vramLedger` key, and the DESIGN/TASKS/memory (`empty-space-skipping.md` → delete) mentions. Record in DESIGN §Volume rendering one line: *"empty-space skipping was built, measured 1.7× slower on space-filling |B|, and removed (git `<sha>`)."*
- `STAGED:` headers on `data/cache.ts` (*"activates with OPFS scrub-back caching — TASKS Unscheduled"* → phrase without the task ref: *"activates when a real reader's re-read cost justifies OPFS scrub-back"*) and `compute/backends/webgpu/streamlines.ts` (*"activates when trace dispatch moves off-main"*). Remove `traceField.ts:49-54` roadmap prose.
- `render/testing/workerHarness.ts` imports `vitest` from `src/` — move to `tests/renderWorkerHarness.ts` (coverage exclude already handles `tests/`).
- knip output (T4): delete the 125 zero-reference exports' `export` keyword (types stay module-private); collapse `ViewportTracking`/`ThemeBridge` single-member interfaces to `Disposer`; hoist the 6× `{ worker: Pick<Worker,"postMessage">; isReady }` prefix into one `RenderWorkerLink` type in `app/renderWorkerSync.ts`; merge `ControlHandle<T>`/`Widget<T>` and `SelectHandle`/`SelectWidget` (`ui/controls/types.ts:11-40`); `PANEL_REGISTRY` stays (theme-driven, one entry today) but `isKnownPanel` + `SERVED_ELSEWHERE` go if only tests use them; `managedOverlay.ts` collapses into its one caller.

### 5b. Comments (rule-driven, mechanical)
- Every non-embed-layer `/**` block → either a single `//` line (if it says something the signature doesn't) or deleted. ~385 blocks; `render/messages.ts` (136 comment lines) and `store/state.ts` (86) first.
- File headers > 6 lines (16 files): keep the invariant, move the rest to the DESIGN § the header already cites (or add the §). Worst: `data/prefetch.ts`, `shaders/kernels/streamline.wgsl.ts`, `ui/pointerPicker.ts`, `ui/controls/rangeControl.ts`, `numerics/interp.ts`.
- Delete the ~20 history and ~28 roadmap comments and the 53 magviz-provenance mentions (keep provenance in DESIGN §Magviz).
- The 96 comment-longer-than-code blocks: `compute/backend.ts:5-13` (9 lines → 2 code) etc. — trim to one WHY line each.
- `ui/theme/styles.ts`: extract the 953-line `UI_CSS` literal to `src/ui/theme/ui.css` imported `?raw` (Vite inlines it; same bundle), leaving `styles.ts` with the token logic. The 60+ `/* */` design notes inside the CSS shrink to the non-obvious ones.

### 5c. Naming (mechanical, ts-morph rename or sed + typecheck)
- Booleans: rename internal fields/locals to questions (`isPanning`, `isDocked`, `hasSettled`, `isTerminal`, `isPerturbed`, `isGrouped`, `hasStarted`, `isReading`, `debugScene`→`showDebugScene`…). Wire fields `shaded`/`continuous`/`active` stay (rule exception).
- `opts` → `options` (170 sites), `el` → `element` (80), `ctx` → `context` except canvas/GPU contexts (169 → mostly stays; audit which are canvas).
- `workers/data.worker.ts` `handle*` → domain verbs; `zarr.ts:56` `handleKey` → `keyFor`.
- 27 bare casts: add the WHY or replace (`layerSync.ts` 4× `.buffer as ArrayBuffer` → one typed `transferableBuffer(view)` helper in `@schema/math` or `containers`; `layers.ts:53`/`layersSlice.ts:56` `as Layer` → a `makeLayer(kind, id, spec)` constructor per `LAYER_KINDS`).

### 5d. Shape
- Split the 5 biggest factories where a collaborator is obvious: `createLayerRegistry` (364 L: epochs/pendingDispose → `createLayerEpochs`; composite cache → `createCompositeCache`), `installLayerSync` (317: `upsertParams` + refill → `layerUpserts.ts`), `bootstrap` (318: worker router → `app/workerRouter.ts`), `installTopBar` (330: menu builders), `createRangeControl` (328: tick/label math already in `rangeMath.ts`; move the DOM builders). Others get the Biome ratchet only.
- `cornerResize.ts:72` ≡ `dragSnap.ts:572` pointer-capture preamble → one `installPressDrag(handle, {onStart,onMove,onEnd})` in `ui/floating/`.
- `computeKernel.ts:43` ≡ `streamlineKernel.ts:65` validation-scoped upload → `gpu/uploadChecked.ts`.
- `sliceScene.ts:17-33` / `raymarchScene.ts:50-80` 7 shared option fields → `FieldSceneOptions` in `render/volume/fieldSceneOptions.ts`; the 5 conditional spreads in `layerRegistry.ts:190-210` collapse.
- `ui/controls/popover.ts:186-189` manual `removeEventListener` → `AbortController` (and the other 8 hand-removed sites).
- `rangeMath.ts` triple guard (`:245/:253/:272-279`) → guard once at the entry.

---

## Sequencing

1. Part 2 + Part 1 (rules first, so every later diff is reviewed against them) — 1 commit `docs:`.
2. Part 3 T1–T5, T8, T10, T12 — small `chore:` commits; T4's knip report feeds 5a.
3. Part 5a (dead code) → 5c (names) → 5b (comments) → 5d (shape) — by layer, `refactor:` commits, full gate each; `test:gpu` + `perf:gate` after 5a (raymarch) and 5d (layerRegistry/worker).
4. Part 4 tests — `test:` commits; #8 fixtures first (makes #3/#4 cheap).
5. Part 3 T6, T7, T9, T11 last (they gate on the cull being done).
6. Memory: update `code-health-review-2026-09.md`, delete `empty-space-skipping.md`, add `comment-policy.md` (caps + the rejected "strict cull").

## Verification

- Every commit: `npm run check` (new, = CI). Pre-push hook now runs boundaries + lint too.
- After T1: `node scripts/check-boundaries.ts` reports > 409 edges (workers included); the new boundaries test fails on a planted `src/workers` → `@ui` import.
- After T4/5a: `npm run check:dead` clean; `tests/embed.test.ts` unchanged (public surface untouched).
- After 5a raymarch removal: `npm run test:gpu` (raymarch/composite/pick suites), `npm run perf:gate` alone (cold < 500 ms / first frame < 1500 ms), README hero unchanged (`scripts/shot-readme.ts` byte-compare optional).
- After 5b: comment ratio recomputed (target ≤ 12 % overall, ≤ 20 % `render`); `tests/jsdoc-surface.test.ts` green; `tests/design-citations.test.ts` green.
- After 5c: `grep -rw opts src | grep -v test` = 0; boolean audit re-run.
- After Part 4: coverage report ≥ 80 % lines (from 78.2), `perfHud`/`data.worker`/`interp` no longer in the zero-or-low list; `tests/tolerances.test.ts` guards the new rows.
- `npm run docs:api` 0 warnings (fewer `/**` may drop TypeDoc coverage on internals — that's the point; embed surface keeps its docs).

## Deliberately not proposed

- Coverage as a gate, `useNamingConvention`, `noBarrelFile`, `useFilenamingConvention` (pypic snake_case), Stryker/fast-check (seeded fuzz exists), golden-image tests, CONTRIBUTING/CHANGELOG/PR templates, cspell/markdownlint/actionlint.
- Renaming wire fields (`shaded`, `continuous`, `active`) — rule exception instead.
- Deleting `data/cache.ts` / `webgpu/streamlines.ts` — STAGED-marked, on the roadmap.
- Re-flagging anything in memory `perf-review-non-wins`, `tot-select-chain-no-win`, or `code-health-review-2026-09` rejections.

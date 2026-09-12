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

---

## [x] Part 6 — The readability pass (2026-09-12)

Parts 1–5 closed everything a tool can check. What is left is the judgement layer: duplication no
clone detector matches because it is a *shape* rather than a string, names that parse but do not
read, factories still too large to hold in your head, and tests that cost more than they guarantee.
No features, no behavior change — every commit is a deletion, a rename, a split, or a test.

Three read-only audits (naming, simplification, test value) ran over all 18 layers; every sharp
claim below was re-verified by hand. **The through-line: the codebase keeps inventing a helper in
one file and hand-rolling it in the next.** `patchBinding` sits in `store/colormap.ts` under a
header explaining the invariant it protects — `store/layers.ts` open-codes it six times. `clamp`
lives in `@schema/math` under a header saying it is there *"so store, ui, render and app share one
definition instead of re-deriving them"* — 13 sites re-derive it.

### Baseline (verified 2026-09-12, gate green)

| finding | number |
|---|---|
| source LOC (non-test, non-generated) | 26 057 · 18 layers (`ui` 8.8k · `render` 5.2k · `data` 2.6k · `store` 2.6k · `app` 2.1k) |
| tests | 174 files · 22 328 LOC · 1420 pass + 11 env-skipped · 7.4 s wall |
| coverage | 82.55 % lines · 81.42 % statements · 70.79 % branches |
| functions over the stated 150-line cap | 18 (worst 268: `installCameraGestures`) |
| functions over the stated complexity-20 cap | 24 (worst 51: `traceSingleDirectionAdaptive`) |
| live Biome ceilings vs today's worst | `maxLines` **310 vs 268** · `maxAllowedComplexity` **52 vs 51** |
| slowest test file | `ui/pointerCamera.dom.test.ts` **6 849 ms** of 14.9 s total test time |
| lowest-coverage non-GPU source | `markerScene` 7 % · `pointerPicker` 40 % · `dragSnap` 54 % · `data.worker` 26 % |
| inline `as unknown as Worker` fakes | 29, across 9 test files |
| hand-rolled `Math.min(Math.max(…))` | 13, against `clamp` in `@schema/math` |
| file headers over the stated 6-line cap | 30 files (worst 9) |

Two things the baseline says that the rules do not: the Biome ceilings are **stale** (they fall
today with zero code change), and `check:dead` runs `knip --exclude exports,types` — so **CI never
checks unused exports at all**. That exclusion is why several deletions below survived Part 5.

### 6a. Delete — duplication the cull could not see (~700 lines)

1. **`store/layers.ts` six copies of one setter skeleton** (`setLayerVisible:94`,
   `setLayerOpacity:108`, `setLayerShading:125`, `setSliceAxis:140`, `setSlicePosition:156`,
   `setFieldlineSeeds:173`) → `patchLayer(list, id, patch)`, the list analogue of
   `store/colormap.ts:32` `patchBinding`. ~45 lines; the identity-preservation invariant lands in
   one place instead of six.
2. **`src/ui/binding/`** — `bindControl`'s 4 overloads over a 4-arm switch only rename
   `descriptor.*` into `folder.add*` args. Sole production consumer is `ui/panels/fieldPanel.ts:27`
   (`kind: "select"`); the other three descriptor types are constructed only in its own test.
   `fieldLabel:52` is a one-line forwarder with the same one caller. → `fieldPanel` calls
   `folder.addSelect` + `fieldInfo(name).longName` directly; delete the folder and the `export *`
   at `ui/index.ts:1`. ~110 src + 71 test lines. (*Abstract on the second real caller.*)
3. **The text-control path is production-dead** — `controls/text.ts` `createTextInput` ← `pane.ts:129`
   `addText` ← only `bindControl`'s dead `case "text"` and two tests. Delete `text.ts`, `addText`,
   `TextOptions`, `Folder.addText`. ~45 lines.
4. **`store/overlay.ts` five identical boolean setters** (`:45,55,59,63,67`), one caller each →
   one `setFlag(state, key: OverlayFlag, on)`. ~33 lines; `overlay.test.ts` already groups four
   under a single `describe`, so the test collapses with the code.
5. **Use `clamp` from `@schema/math`** — `render/pickRay.ts:34,35,36,82`, `store/pick.ts:72,102,106`,
   `store/overlay.ts:42`, `ui/layerSettings.ts:259,305` (same expression twice → one
   `seedCountFor`), `ui/railMenu.ts:57`, `ui/colorbar/bottomDock.ts:57`, `app/viewportTracking.ts:21`.
   `pickRay.ts:82` is the one per-ray-loop site to glance at.
6. **`render/grid/overlayRemap.ts:17` `fieldAxisToThree` is the identity function** — 4 call sites,
   one `expect(f(0)).toBe(0)` test, and a comment carrying banned history. Delete; the invariant is
   already in the file header.
7. **`store/camera.ts`** — five pose builders (`:58,73,126,168,182`) spell out all five
   `CameraPose` fields where `{ ...pose, … }` would do (and `axisViewPose:463` already spreads);
   `rollPose` is 7 lines that should be 1. `nudgePose`'s `lookMode = false` default is never taken.
   `formatPoseParam:430` is production-dead — its comment cites a copy-link affordance that does
   not exist, and it has no `STAGED:` header. ~29 lines.
8. **Small verified duplicates** — `controls/rangeMath.ts:193-203` ≡ `:233-243` (→ `uniqueSortedT`)
   · `runtime/renderer.ts:160-173` ≡ `:212-221` (readback tail) · `grid/overlayScene.ts:207-217` ≡
   `:218-228` and `:237-243` ≡ `:244-250` (a/b-swapped tick emitters) · `readers/synthetic.ts` grid
   + dataset tails (~22) · `pointerPicker.ts:198-204` ≡ `:206-211` and `:99-104` ≡ `:105-110` ·
   `bottomBand.ts:181-188` ≡ `dragSnap.ts:608-616` (→ one `coalesceFrame`) · `controls/types.ts:56`
   `SegmentedOptions<V>` ≡ `SelectOptions<V>` · `layerEpochs.ts:42` `supersedeAll` re-implements
   `begin` · `numerics/tracing.ts:580,582` re-derive defaults `resolveTraceParams:480,491` owns.
9. **Redundant guards** — `overlayScene.ts:190/192` re-tests `config.show.grid`;
   `layerRegistry.ts:370-371` re-tests `!== undefined`; `managedDecoration.ts:44`'s ternary exists
   only for closure narrowing where `warmScene` already returns early.

**Judgement, confirm before cutting:** `store/layers.ts:52` `makeLayer`'s three textually identical
switch arms (modern TS may distribute the spread over the union — verify with tsc, do not take on
faith) · `ui/panels/registry.ts` `PANEL_REGISTRY` (one entry, but a stated affordance — cut only
`isKnownPanel`) · `app/sceneSync.ts` ≡ `app/pickerSync.ts` themed-bridge skeleton (~14 lines; the
bodies differ enough that the helper may not pay) · `vite.config.ts:19` ↔ `app/shaderHmr.ts:13`
`"webpic:shader-hmr"` (both sides document the duplication as deliberate — a policy question).

### 6b. Names

**Misleading:** `pointerPicker.ts:75` `hitTest` → `markerPartAt` (returns a `MarkerPart`, not a
boolean) · `layerComposite.ts:14` `CompositeEntry` / `runtime/renderer.ts:27` `CompositeItem` →
`CompositeOrderEntry` / `CompositeDrawItem` (both imported into `layerRegistry.ts:9,20`) ·
`controls/types.ts:19,40` `SelectOption`/`SelectOptions` → `SelectChoice`/`SelectOptions` ·
`shortcuts.ts:35` `teardown` (an `AbortSignal`) → `teardownSignal` · `colormapControls.ts:45+`
`bounds: DataRange` → `dataRange` · `colorbarSettings.ts:47` `cb` (a `DOMRect`) → `colorbarRect` ·
`store/colormap.ts:15,26+` `BindingRecord`/`rec` → `ColormapBindingsById`/`bindings` ·
`render/worker.ts:60,100,234,277,331` `dims` (a canvas size) → `canvasSize` ·
`markerScene.ts:59` `HHANDLE_IDLE_OPACITY` → `HORIZONTAL_HANDLE_IDLE_OPACITY` ·
`layerRegistry.ts:201` `replace` → `installScene` (its own comment says "Install a layer's scene").

**One spelling per concept:**
- `src/app/*Sync.ts` → `*Bridge.ts` (4 files against 5 already-`Bridge`; the prose settled it —
  `pickerSync.ts:7` opens *"Bridges the store's point-picker state…"* and `storeBridge.ts:3` lists
  `layerSync` among "the bridges"). 22 refs + 4 file + 3 test renames.
- `ac` → `abortController` (80) and `subs` → `subscriptions` (118), one mechanical commit each.
- `useF64` (`derived/magnitude.ts:17`) vs `useFloat64` (`coordinates/operators.ts:79+`) →
  `isFloat64Output`. Same boolean, two spellings, sibling pure-math layers, neither a question.
- `teardown` → `dispose` for the 2 remaining identifiers (`ui/layerSettings.ts:132`).
- **`ui` icons: 4 homes → 1.** Fold the local `const ICON` maps (`topBar`, `cameraRail`,
  `sideRail`, `colorbar`) and the loose `ICON_*` consts into `ui/icons.ts`; `layerIcons.ts` keeps
  only `LAYER_KIND_ICON`. Deletes the one exact duplicate glyph (`ICON_CARET` ≡ `ICON_CARET_DOWN`).

**Booleans at the call site:** `layerUpserts.ts:59` `sendSliceParams(layer, axisChanged,
positionChanged)` → one `changed: { axis, position }` (two adjacent booleans; a swap compiles) ·
`bottomBand.ts:130` `setCollapsed(true, true)` ×3 → `setCollapsed(isCollapsed, { isAutomatic })` ·
`perfSampler.ts:57` → split into `postOnDemandSample`/`postContinuousSample` ·
`markerScene.ts:107` `paintKnobTexture(vertical)` → two named painters · `niceTicks.ts:18`
`niceNum(value, round)` → `snapToNearestNice`/`snapUpToNice` · ~30 non-question booleans on shared
signatures (`orthographic` → `isOrthographic`, `shift` → `isShiftHeld`, `fireNow` →
`shouldFireNow`, `dismissOnOutside` → `shouldDismissOnOutside`, `display` →
`shouldDisplayOnComplete`) — none on the store→render wire, so the exemption does not apply.

**Positional-parameter explosion** — 56 functions take ≥5; only five have a same-typed adjacent run
where a swap type-checks. Fix those: `numerics/tracing.ts:213` `traceSingleDirectionAdaptive`
(**14 params, 8 consecutive `number`** → pass the `ResolvedTraceParams` at `:452`; drops its
complexity 51 → under 20) · `store/marker.ts:107,128` `dragOnPlane`/`dragAlongAxis` (both open with
`cursorRay`'s exact 5-param prefix → one `CursorView` across all three) ·
`dragSnap.ts:382,410` `setAnchors`/`placeCentered` (8 params each incl. `w`, `hgt`, `h`, `v`).

**Abbreviations on exported or widely-read signatures:** `vp` → `viewport` (41) · `desc` →
`descriptor` (23; moot if 6a-2 lands) · `buf` → `points`/`seedBuffer` · `vStemGeom`/`vKnobTex` →
`verticalStem*` (~16) · `w`/`i`/`pts`/`phys` (`layerUpserts.ts:171-180`) · `cur`/`oc`/`cand`
(`dragSnap`'s trickiest loop).

**Verified, deliberately left alone:** `doc: Document` (305 — renaming shadows the global), `out`
in the math layers, `state = store.getState()`, `i`/`j`/`k` in tight loops, `src`/`dst` in the
6-line reversal loop, `destroy` (the WebGPU API), the sanctioned scientific shorthand (`bx`, `rho`,
`dt`, `qOverM`), and the `applyX` DOM-reflect idiom (24 consistent uses — sweep all or none).
Checked clean: 0 `handleX`, 0 `cfg`/`tmp`/`msg`/`evt`, no exported one-word `Options`/`Entry`/
`Handle` types.

### 6c. Shape — close the gap between the rules and the ratchets

1. **Free drop, no code change:** `maxLines` 310 → 268, `maxAllowedComplexity` 52 → 51. Land first,
   so each split below ratchets down in its own commit.
2. **Split the five worst bodies** into named collaborators, the `createLayerRegistry` pattern:
   - `cameraGestures.ts:52` (268 L, cx 27) → `createTapRecognizer` + `createTwistGate`, both pure
     state machines (and therefore node-testable). Inside: `:149-158` ≡ `:236-243` → one
     `dollyWithRect`; `onGestureEnd:275` only calls `preventDefault()` → inline at the listener.
   - `perfHud.ts:101` (260 L, cx 31) → `perfSparkline.ts` takes the two rings + ~95 lines of canvas
     drawing. `ctx2d` → `ctx` (the sanctioned spelling).
   - `markerScene.ts:166` (237 L, **7 % covered**) → `makeHandle({axis, idleOpacity, vertical,
     visible})` for the ↕/↔ mirrors (`:189-204` ≡ `:206-223`), the nine `x`/`xT` easing pairs
     (`:246-267`, eased `:353-360`, settle-checked 8× at `:388-398`) → a `createMarkerEasing` cell
     array, and the 13 named `.dispose()` calls → the `geometries`/`materials`/`textures` arrays
     `overlayScene.ts:121` already uses. ~60 lines, and the pure easing becomes testable.
   - `dragSnap.ts` (632 L) → `snapGeometry.ts` for the pure half (lines 14–321, already
     unit-tested), leaving the DOM installer — the `rangeMath`/`rangeControl` precedent. Also hoist
     `chooseEdge`'s `leftSide`/`topSide` (recomputed in all three branches from branch-invariant
     inputs) above the `if` chain.
   - `grid/overlayScene.ts:119` (164 L, cx 42) → `emitAxisLines` + `emitAxisLabels` (the 6a-8
     mirrors) and `buildAxisLabels`.
3. **`app/main.ts:102` `bootstrap`** (254 L, cx 29) — the hand-ordered 16-call disposer list at
   `:359-383` violates *"never a hand-ordered unsub list"* (`createSubscriptions` exists; `app`
   already imports `@ui`), and the perf-HUD + shader-HMR lazy-install twins (`:148,328-343,361` and
   `:348-357,364`) are the second caller of one shape → `installLazy(load, install, scope, message)`.
   Then `wireDatasetSwitch(...)`.
4. **`numerics/tracing.ts:213`** — the 6b parameter-object change lands here so the ratchet falls
   in the same commit.
5. **`gpu/computeKernel.ts` ≡ `gpu/streamlineKernel.ts`** (~16 lines) — the validation-scoped
   pipeline preamble and the `mapAsync`→`slice(0)`→`unmap()` readback (which `streamlineKernel`
   does twice) → `oneShotPipeline` + `readBack`. **Schedule where a real GPU run is available.**

**Not splitting:** `render/worker.ts` (its body *is* the worker's state — keeps its sanctioned
`biome-ignore`), `store/camera.ts`, `render/messages.ts`, `data/readers/zarr.ts`,
`data/readers/decode.ts`, `compute/calibration.ts`, `schema/theme.ts`. `ui/topBar.ts` (327 L) is
borderline but its five widgets share the `overlayClosers` mutual-exclusion map at `:65-69`.

### 6d. Tests — "only what matters", in both directions

**Delete / rewrite.**
- **`ui/pointerCamera.dom.test.ts` is 6 849 ms of 14.9 s.** `pumpUntil:34` polls rAF against
  `Date.now()` while `cameraGlide` tweens on real elapsed time — its own comment admits *"tweens
  run on real elapsed time, ~450 ms"*. That is the banned `setTimeout(r, N>0)` evaded through rAF.
  **Test-only fix:** `glide(nowMs)` (`cameraGlide.ts:138`) is driven by the rAF timestamp, so
  `vi.stubGlobal("requestAnimationFrame", …)` feeding a synthetic clock fast-forwards every tween
  — the pattern 8 files including `worker.quality.test.ts` already use. (`isWheelLive:101` and
  `:246` read `performance.now()`; stub that too, or add `now` to `CameraGlideHost`.) Also collapse
  `:143-168`, which re-tests `normalizeWheelDelta` already pinned by `store/camera.test.ts:145-153`.
  **Expected: suite 7.4 s → under ~2 s.**
- **`tests/toolchain.test.ts`** is `expect(1 + 1).toBe(2)`. Delete; 122 node test files already
  prove the node project resolves.
- **`render/worker.quality.test.ts`** (264 L, 723 ms, 5 `vi.mock`s, 84-line harness) re-asserts
  `runtime/qualityController.test.ts` — `:109` and `:208` both re-pin `[0.4, 0.7, 1]`. Keep only
  what the controller unit cannot prove (handlers reach the controller; a painted rAF frame calls
  `advanceSettling`). Delete `qualityController.test.ts:84-90`, a duplicate of `:51-70` beside it.
- **Bare epsilons in the kernel suites** — `coordinates/conservation.test.ts:50,80,81,82` does not
  even import `tests/tolerances.ts`, and it is the gold test; `operators.test.ts:63,112-114,127,
  128,159` imports `TOL` and ignores it. Route all eleven through `TOL.conservation.ts_f64` (or the
  existing `TOL.curl/divergence/gradient.ts_f64`).
- **Vacuous assertions** — `supersedingTask.test.ts:57-64` asserts what `TArgs extends readonly
  unknown[]` guarantees at compile time; `:44-55` awaits sequentially so its named race cannot
  occur. `calibration.test.ts:304-316` wraps a compile-time assignment in an `it()` (hoist to
  module scope, delete the test). Four `not.toThrow()` sites assert nothing their title claims:
  `workerRouter.dom.test.ts:77-80` ("logs an unknown kind" — assert through `setLogSink`),
  `viewportTracking.test.ts:88-97`, `statusPill.dom.test.ts:144` (→ `expect(vi.getTimerCount())
  .toBe(0)`), `shell.dom.test.ts:37`. Four more are redundant lines before a real assertion.
- **`derived/magnitude.test.ts:12-38`** — three tests of one guarantee, the third subsuming the
  others; `:65-80`'s alias loop is re-run at `compute/backends/ts/magnitude.test.ts:17-24`.
- **Fixtures: ~150 lines of re-rolled setup**, against the stated rule and with no barrier (30 test
  files already import `tests/fixtures.ts`). `makeFakeWorker()` first — 29 inline `as unknown as
  Worker` fakes across 9 files, 8 in `app/main.test.ts` alone. Then `blobField` (a byte-identical
  17-line clone in `composite.browser.test.ts:22` and `raymarch.browser.test.ts:13`, beside the
  `ballField` already in fixtures), `beDataset` ×3, `traceableDataset` ×3, `bTriple` ×2,
  `sample(shape,spacing,fn)` ×2, `sampleCellCentered` across the src/scripts seam
  (`tests/traceFixtures.ts` is its home), fake adapter limits ×2, `coordsInfo.test.ts:6-19`'s
  hand-rolled `GridInfo` → `makeGrid`, and `mountUi(install)` + `requireEl(root, sel, what)` for
  the identical 9-line prologue in six `ui/*.dom.test.ts` files. (*Not* the `vi.mock` prologue in
  the five `worker.*.test.ts` — `vi.mock` is hoisted and file-scoped, so it cannot be shared.)
- **`ui/panels/themeCoverage.dom.test.ts`** touches no DOM — the only such file. → `.test.ts`.
- **Two `setTimeout(r, N>0)`** in browser suites (`parity.browser.test.ts:124`,
  `pick.browser.test.ts:71`) — outside the CI gate, so never caught.

**Add — ranked by what can actually break.**
- `dragSnap.dom.test.ts` (installer at 54 %, the largest untested installer, owning pointer capture
  + docking): *a drag past the snap threshold docks to the nearest edge and releases pointer
  capture*; *dispose stops responding to a drag already in progress*.
- `ui/pointerPicker.ts` at 40 % — the suite is scoped `describe("installPointerPicker arrow keys")`;
  the pointer path is untested: *a drag on the marker moves it along the view plane and dispatches
  one pick intent per pointerup*.
- `workers/data.worker.ts` at 26 % — `:109` `"stream read before open"` (the realistic
  fast-dataset-switch race), `:40` `"could not open cache directory"`, and the inner cache-port
  `default:` never-arm at `:74-76` (only the outer one at `:229` is covered).
- **Superseding tasks, second contract** — `simulation.abort.test.ts` proves only that the old
  signal aborts; the commit-discard half is where the store regresses. `createRetrace`
  (`store/fieldTrace.ts:29`) has no supersession test at all.
- **`dispose()` idempotence** where a real resource is held — `render/worker.dispose.test.ts` (one
  test, neither required contract), `gpu/device.ts`, `gpu/vramLedger.ts`,
  `render/volume/volumeTexture.ts`, `render/runtime/readback.ts` (*dispose during a pending
  `mapAsync` resumes the loop and rejects the read*). Repo-wide only 4 modules test it.
- **The pure halves that fall out of 6c** — `createTapRecognizer`, `createTwistGate`,
  `createMarkerEasing`, `snapGeometry`, `patchLayer`. `createMarkerEasing` is what turns
  `markerScene`'s 7 % into a real number.
- `createCompositeAssembler` (`runtime/composite.ts:52`) — a malformed-input test per throw site.

*Lower priority than the audit suggested:* `createStoreBridge` and `installPickerSync` have no
*direct* test but measure 100 % and 91 % covered through the bridges above them.

### 6e. Rules, config, and the mechanical tail

**Two test rules that good code contradicts** (decided 2026-09-12: amend the rules, not the code):
- *"Every `install*` has a `.dom.test.ts`"* → *"every `install*` that touches the DOM"*. Eight
  `app/` bridges are DOM-free store→worker wiring with correct node tests; the rule as written asks
  for eight happy-dom files that would assert nothing new.
- `describe("<exported symbol>")` cannot express the ~110 legitimate `describe("<symbol> — <case>")`
  titles (`"ZarrReader — cancellation"`) or the named invariants (`"div(curl F) = 0"`). Allow both,
  then fix the 10 titles naming prose instead of a symbol (`"top-bar chrome"` → `installReveal`, …)
  and the one `works` title (`controls/rangeMath.test.ts:253`).

**Config:**
- `check:dead` runs `knip --no-config-hints --exclude exports,types` — CI never checks unused
  exports, which is why 6a-2/3 survived Part 5. Drop both flags. Teach knip the HMR dynamic-import
  seam (`buildRaymarchMaterial` is read off a fresh `import()` at `volume/shaderReload.ts:21-23`),
  drop `export` from `GpuUnavailableError` (nothing catches it by type), fix the two real hints
  (`**/*.generated.ts` matches nothing; `src/**/testing/**/*.ts` is gone since the harness moved).
- Cross-layer test files colliding with layer-test names: `tests/seedPick.test.ts` →
  `tests/seed-domain-parity.test.ts`; `tests/synthetic.test.ts` → `tests/analytic-parity.test.ts`.
  `tests/prefetch.test.ts` imports only `@data/*` — a layer test in the meta-guard folder; move to
  `src/data/prefetch.test.ts`, which also gives `prefetch.ts` its stated sibling.

**Mechanical tail (all four in scope):** file headers 9 → 6 (30 files, ~60 lines; then flatten
`HEADER_CEILING` to 6 so it stops being a ratchet) · ~26 milestone/version refs in comments
(`M3.1`, `M4.4`, `v0.1`, `v0.2` — in `tolerances.ts` keep the provenance but cite the *suite*) ·
name the 8 bare guard epsilons (`PARALLEL_RAY_EPSILON`, `DEGENERATE_LENGTH_EPSILON`, …) · prefix
the 8 error messages lacking a subsystem name (`"render before init"` ×2, `"loopTol must be
positive"`, `"could not open cache directory"`, …; the other ~96 throws comply).

**Not re-proposed:** another comment-ratio cull (settled at 17.2 % in Part 5 — a scan found one
restatement in the whole tree), and anything in memory `perf-review-non-wins`,
`tot-select-chain-no-win`, or the `code-health-review-2026-09` rejections.

### Part 6 sequencing

1. 6e config (`chore:`) — un-exclude knip first, so it reports honestly through everything below.
2. 6a deletions (`refactor:`): `patchLayer` → `overlay.setFlag` → `ui/binding` + text control →
   `clamp` → `fieldAxisToThree` → `store/camera` → the small duplicates.
3. 6b names (`refactor:`), four commits: misleading → `*Sync`→`*Bridge` → `ac`/`subs` →
   booleans + parameter objects.
4. 6c shape (`refactor:`), one commit per split, each lowering the Biome ceiling in the same diff.
5. 6d deletions (`test:`): fixtures first, then the rAF clock stub, then the vacuous-assertion cull.
6. 6d additions (`test:`): the split-out pure halves, then `dragSnap`, `pointerPicker`,
   `data.worker`, the supersession and dispose contracts.
7. 6e tail + CLAUDE.md (`docs:`/`refactor:`).
8. Record outcomes + deviations here; update memory `code-health-review-2026-09.md` and
   `enforcement-ratchets.md`.

### Part 6 outcome (landed 2026-09-12)

Fourteen commits, `npm run check` green on each, no behavior change.

**On line counts:** source went 26 057 → 26 013 — **net −44**. Roughly 700 lines were deleted and
roughly 660 came back as named collaborators and the contracts they need. That is the honest shape
of this part: it did not shrink the codebase, it redistributed it. The deletions are real (an
abstraction with one caller, a dead control path, eleven copies of one setter, thirteen re-derived
clamps) and so is what replaced them; a split trades a long body for two short ones plus a named
seam, which costs lines and buys a place to hang a test. Tests grew 23 036 → 23 405 for 33 net new
cases, and they run faster than before.

| measure | before | after |
|---|---|---|
| source LOC (non-test) | 26 057 | 26 013 |
| `npm test` execution time | 14.9 s | **9.0 s** (wall 7.4 → 6.4 s) |
| slowest test file | 6 849 ms | **27 ms** |
| coverage (lines / branches) | 82.55 % / 70.8 % | **84.7 % / 72.8 %** |
| tests | 1 431 | 1 464 |
| Biome ceilings (lines / complexity) | 310 / 52 | **258 / 49** |
| file headers over 6 lines | 29 | **0** (the ratchet became the rule) |
| milestone refs in comments | 27 | **0** |
| knip, with exports re-enabled | 8 + 2 hints | **0** |

Deviations, each after inspection rather than by omission:

- **6a-1** — `patchLayer` nets only ~6 lines, not 45: the helpers cost what the six copies saved.
  The win is structural (one home for the identity rule), not a line count.
- **6a-7** — `nudgePose`'s `lookMode` default *is* exercised, by ten orbit-mode tests, and
  `formatPoseParam` is `parsePoseParam`'s tested inverse and how a `?pose=` permalink is minted.
  Both stay; the stale comment about a copy-link readout went instead.
- **6a-9** — `managedDecoration`'s ternary is the typed construction, not a redundant check:
  `warmScene` skips the callback for an undefined scene, but the check is what types `spec.warm(next)`.
- **6a (deferred)** — `makeLayer`'s three identical switch arms **stay**: a bare spread type-checks
  now, but the switch is what makes a fourth `LayerKind` fail to compile. Comment corrected to say so.
- **6b** — `cursorRay` keeps its five parameters; only `dragOnPlane`/`dragAlongAxis` changed, and they
  take the *ray* rather than a `CursorView` bag — better factored, and the caller builds it once.
  `niceNum`'s flag was not split into two functions: the `round=false` branch had no caller anywhere,
  so the flag and the branch are gone.
- **6b (icons)** — the four surface-local `ICON` maps **stay**. `icons.ts`'s own header already says
  surface-specific glyphs live with their component; that split is a rule, not drift. Only the one
  exact duplicate glyph was real.
- **6c** — `traceSingleDirectionAdaptive`'s complexity came from the integration loop, not the
  parameter list: 51 → 31 after extracting `closesLoop`, not "well under 20". The rest is one
  algorithm. `bootstrap` is 255 lines, about where it started — the win is that a new bridge can no
  longer be silently left running, not brevity.
- **6d** — the suite lands at 9.0 s of test time, not "under 2 s": with `pointerCamera` fixed, the
  critical path is `boundaries.test.ts`'s ts-morph parse (2.4 s) and module transform, neither of
  which is a test-quality problem.
- **6d** — `worker.quality.test.ts` is **not** a duplicate of `qualityController.test.ts`: it proves
  the worker's two entry paths reach the controller through a real rAF loop, which the unit cannot.
  Same for the sequence assertion inside `qualityController.test.ts`, which is exact where its
  neighbour's `toHaveBeenCalledWith` is not.
- **6d** — most `data.worker` error paths named in the audit are unreachable from the message
  boundary (the outer `default:` catches first, OPFS is absent in node). Tested what is reachable:
  pre-open cursor/field messages as no-ops, a cache write that cannot land, the perf self-report.
- **6d** — `makeFakeWorker` converted `main.test.ts` (−103 lines) and `streamingBridge`; the other
  inline fakes are one-liners that an import would lengthen, so they stay.

### Part 6 verification

- Every commit: `npm run check` (= CI).
- After 6a: `npm run check:dead` clean with exports re-enabled; `tests/embed.test.ts` unchanged
  (no `@embed` surface is touched — `readers/synthetic.ts`'s helpers stay module-private).
- After 6c: `npm run test:gpu` (47) and `npm run perf:gate` **run alone** (memory
  `m2-perf-gate-instruments`: cold numbers swing 79 → 886 ms under concurrent builds). Cold paint
  < 500 ms, first frame < 1500 ms. Both Biome ceilings strictly lower than they started.
- After 6d: `npm test` wall clock **7.4 s → under ~2 s**; coverage lines ≥ 82.55 % and rising. Test
  *count* may fall; that is the point.
- After 6e: `comment-budget.test.ts` header ceiling flat at 6; `grep -rE "M[0-9]+\.[0-9]" src tests`
  returns only SVG path data.
- `npm run test:parity` unchanged throughout — no schema or writer surface is touched.

---

## [x] Part 7 — the final sweep: layout, vocabulary, and the seams (2026-09-12)

Parts 1–6 all worked *inside* files. What was left was where the files sit and what the vocabulary
calls things — a codebase whose contents read well and whose directory listing did not. Three
read-only audits swept all 18 layers plus the repo furniture; every sharp claim was re-verified by
hand before it entered the plan, and the ones that did not survive are listed at the end.

**Decisions taken up front:** folder reorganization in scope · the `@embed` surface not frozen
pre-1.0 · prose in scope, recorded here.

### Outcome (24 commits, `npm run check` green on each)

| measure | before | after |
|---|---|---|
| source LOC (non-test, non-generated) | 26 013 | 26 200 |
| CSS | one 2 759-line `ui.css` | 15 per-surface files, 2 856 lines |
| `src/ui/` loose at the layer root | 32 of 66 | **7 of 69** |
| tests | 175 files · 1 465 cases | **180 files · 1 478 cases** |
| coverage (lines / branches) | 84.7 % / 72.8 % | **85.6 % / 74.0 %** |
| Biome ceilings (lines / complexity) | 258 / 49 | **256 / 49** |
| layer-DAG edges granted but unused | 12 | **0** (3 reserved, each with its reason) |
| places a new `LayerKind` fails to compile | 2 of 4 real ones | **4 of 4** |

Source grew by ~190 lines: the deletions are real (a dead field on five wire variants, a duplicated
payload type, eight copies of one narrowing, four hand-rolled dismissal lifecycles, ten copies of
one visibility AND), and so are the named collaborators that replaced them. A split trades a long
body for two short ones plus a contract; that costs lines and buys a place to hang a test.

### What it found that was actually broken

- **`ui/perfSparkline.ts:37` was infinite recursion** — `const xAt = (j) => xAt(j)`, shipped by
  Part 6's own split commit (`cbdedca`). Opening the perf HUD in a real browser was a
  `RangeError`. The draw path had no test: its only coverage runs under happy-dom, where
  `getContext("2d")` is null and the paint bails before the mapping is reached.
- **The `el` → `element` sweep rewrote a display string.** The grid-info card had been reading
  `az 45°  element 30°  d 2.50` to users since `5b68303`. The existing assertions used `toContain`.
- **`verify-streaming-render.ts` had been broken for two days** — `073ee66` retitled the pane it
  locates and left the probe looking for the old text. Local-only, so nothing in CI noticed. It
  locates a `data-pane` hook now: titles are copy, a hook is a contract.
- **`renderer.setSize` lost its device-pixel-ratio update** the moment a rename shadowed it. Biome
  caught the self-assignment; the tests did not.
- **A new `LayerKind` would have looked wired and done nothing** — `LAYER_KIND_ORDER` was a plain
  array (no rail button, no error) and `layerSettings` had two `void` switches with no never-arm
  (no controls, no sync, no error).

### What changed

**Truth.** `DataStreamRequest.requestId` was dead on all five variants and forced an invented
constant at five post sites · `StreamFieldPayload` was a verbatim copy of `SliceFieldPayload` under
a comment saying so · `gpu/profiler.ts` had zero importers while CLAUDE.md named it the live GPU
timing path · the `@shaders` barrel re-exported eleven symbols nobody imported through it. The
systematic cause — knip lists `src/**/*.test.ts` as an entry point, so a module only its own test
imports is invisible — is now covered by `tests/live-modules.test.ts`, which honours `STAGED:`.

**Single-sourcing.** `errorMessage` (8 re-rolls) · `formatZodError` · the anchored-overlay
dismissal contract (4) · `isUiVisible` → `hidden` (10) · `installOutsideClickDismiss`'s own copy ·
`ndcToClient` · `clampIntoViewport` · `INTERACTIVE_SELECTOR` · `DOUBLE_TAP_MS` · the two compute
backends' input gather, result pack and grid guards · zarr's `openOptions` · `MAGNETIC_COMPONENTS` ·
`identityUpdater` · `PHASE_KEYS` · `requireRenderer` · `clamp` in `iStepController`.

**Layout.** `ui/` gained seven folders its filenames were already spelling (camera, layers, topbar,
perf, picking, keys, status) plus `bottomBand/`; `shell/` joined `panels/`, which is what it hosts.
`render/grid/` was the overlay folder and `render/volume/` held the slice, so they are
`render/overlay/` and `render/field/`; the layer registry's four files left the root for
`render/layer/`. `store/` grew `slices/` and `interaction/`. `app/` marks its two infrastructure
files with the `_` prefix and names its bridges bridges. `ui.css` became 15 fragments beside the
modules they style, assembled in an explicit cascade order — the cut is provably order-preserving
and each fragment parses as CSS on its own.

**Vocabulary.** "chrome" meant three things (the gnomon, the top bar's element factories, all
floating UI) · "composite" meant four (the wire's order, the object holding it, the draw list, the
renderer's accumulation) · three flags asked `isXOpen` and were set with `setXVisible` · the two
rails were both "rail". Plus the last abbreviations and ~15 non-question booleans.

**Seams.** The layer-kind compile gate (above) · the DAG tightened to what the code imports, with
each reserved edge carrying its reason · the header cap now counts the whole header instead of the
first unbroken run · the two reserved-layer stubs cite a real DESIGN § and carry `STAGED:`.

### Deviations, each after inspection

- **The `_` prefix at `render/`'s root is not applied.** Everything left there is infrastructure, so
  marking all of it marks nothing.
- **No `RAIL_TOOLS` table.** The audit counted six edits per rail button, but the buttons are four
  different shapes (toggle, action, flyout, disabled placeholder), the add-group is already a loop
  over `LAYER_KIND_ORDER`, and the flyout variant needs wiring the table cannot carry. A four-branch
  table over fourteen buttons is the registry-with-one-entry smell wearing a bigger coat.
- **No `SURFACES` table in `installUi`.** Eleven explicit calls, each with the reason its surface
  mounts where it does, is what a composition root should look like; nothing iterates them, and the
  table would buy one line per surface at the cost of eleven signature changes.
- **`store/index.ts` stays a wholesale `export *`.** Nothing deep-imports `@store`, the interaction
  math alone is forty-odd pure functions, and knip reports the unused ones. It says so now.
- **No per-folder `index.ts` barrels in `ui/`.** `controls/` has one because `@ui` re-exports it;
  nine forwarding barrels would be nine files that only forward. The rule is stated in
  `controls/index.ts` instead. `app/perfBridge.ts` keeps its deep import of the perf HUD on purpose:
  it is a dynamic import, and the barrel would pull the ui surface back into the eager graph.
- **The perf HUD's CSS costs ~1 kB on the eager path** (410.8 → 412.3 kB gzipped, budget 550 kB).
  Keeping it lazy needs a second style-injection mechanism, which is the kind of thing this sweep
  removes.
- **`cleanup.md` (this file) keeps the path citations it was written with** — it records what was
  decided at the time. It moved to `docs/` and is now in CLAUDE.md's docs map.

### Claims that did not survive verification

The `@embed` layers are not dead weight — every one of their 17 exported symbols has a real
consumer, and `@coordinates`/`@derived`/`@diagnostics` are barrel-imported exactly once each, by
`src/embed/index.ts`; they *are* the published surface. `tests/` fixtures and `TOL` are correctly
single-sourced with zero local re-rolls. Every `as X` in non-test code already carried a WHY and
there are **zero** `!` assertions in the audited layers. The generated-file subsystem needs nothing.
`STAGED:` marker placement is not inconsistent — each sits at the head of its own file's header
block, and header blocks follow the imports in most of this tree. The render↔worker protocol is the
best-built seam in the repo and was left alone.

### Part 7 verification

- Every commit: `npm run check` (= CI, and `check` now runs `test:coverage` like CI does).
- After the ui and render moves, run alone: `test:gpu` 46/46 · `perf:gate` 83 ms cold paint /
  212 ms first frame · `verify:streaming` p50 11.95 ms with steps reaching the GPU and main
  responsive · `perf:raymarch` p50 12.28 ms — all in line with the recorded baselines.
- Real-app smoke after each UI phase (headed Chrome, production preview): the F toggle both ways,
  the rail flyout and coords card opening and closing on Escape, the colorbar popover dismissing on
  an outside press, the layer-settings window opening on the volume layer with its Phong control,
  and the sparkline painting real pixels. Zero page errors throughout.
- Both new guards verified by planting the thing they are meant to catch: a split header, a bogus
  `§` citation, a fourth `LayerKind`, and a `render` → `@numerics` import.

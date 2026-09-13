# webpic — the code-health passes

Ten passes between 2026-09-09 and 2026-09-13, each read-only-audited first and re-verified by hand.
No features, no behaviour change: every commit is a deletion, a rename, a split, a test, or a gate.

**Read this before re-proposing a cleanup.** The plan bodies are in `git log`; what survives here is
what landed, what it found, and — the long section at the end — what was *rejected after inspection*.

---

## Where it went

| measure | before | now |
|---|---|---|
| coverage (lines) | 75.4 % | **85.7 %**, and now a floor (85/84/87/73) |
| tests | 1 240 | **1 494** in 170 files |
| `npm test` wall time | 14.9 s | **~6.2 s** |
| comment ratio (hand-written `src`) | 21 % | **16.1 %** |
| Biome ceilings (lines / complexity) | 311 / 62 | **210 / 26** |
| file headers over 6 lines | 30 | **0** — the ratchet became the rule |
| `/**` outside `@embed` | 385 | **0** — likewise |
| milestone refs in comments | 27 | **0** |
| knip unused exports | 148 (and CI was not checking) | **0** |
| app bundle (gzip) | 1.6 MB budget, unmeasured | **395.1 kB** against a 413 kB ratchet |
| CSS | one 2 759-line `ui.css` | **2 647** across 15 per-surface files |
| `docs/DESIGN.md` | 1 089 | **880** |
| source LOC (non-test, non-generated) | 26 057 | 26 556 |

**On that last row.** Four passes of deletion left the source the same size. That is the honest shape
of this work: roughly 1 500 lines were deleted and roughly as many came back as named collaborators,
contracts and compile gates. A split trades one long body for two short ones plus a seam — it costs
lines and buys a place to hang a test. The deletions are real, and so is what replaced them.

---

## What each pass landed

**Parts 1–2 — rules** (`~/.claude/CLAUDE.md`, `webpic/CLAUDE.md`)
- A `## Code hygiene` section, grounded in measured findings rather than taste.
- `webpic/CLAUDE.md` ~30 % shorter: narrative moved to DESIGN and cited by §; the `install*` /
  `create*(host)` contract promoted to its own section; comment, naming and test rules made explicit;
  all 13 milestone tags stripped.

**Part 3 — enforcement**
- `npm run check` as the one gate, `check:dead`, `docs:api` in CI, lefthook.
- New guards: `@embed` surface, JSDoc-free layers, header cap, `§` citation resolution.

**Part 4 — test-suite gaps** — the holes the baseline exposed; coverage 75.4 → 78.2 %.

**Part 5 — the code cull** (`27acce5`, `5b68303`, `c85ffb2`, `0c80278`)
- Deleted what measured worse or forwarded nothing (empty-space skipping was 1.7× *slower*).
- One spelling per concept; booleans became questions; comments became WHY-only.
- The five biggest factories got named collaborators. Coverage → 82.55 %; knip 148 → 8.

**Part 6 — the readability pass** (`a18724b` … `5c79e1b`, 14 commits)
- The through-line: *the codebase kept inventing a helper in one file and hand-rolling it in the next*
  — `patchBinding` open-coded six times, `clamp` re-derived thirteen.
- Un-excluded knip (CI had never checked unused exports — that gap is why several deletions survived
  Part 5), split the five worst bodies, cut the tests that cost more than they guaranteed.
- Test time 14.9 → 9.0 s; slowest file 6 849 → 27 ms; coverage → 84.7 %.

**Part 7 — layout, vocabulary, seams** (24 commits)
- `ui/` gained the seven folders its filenames were already spelling; `render/grid` → `render/overlay`,
  `render/volume` → `render/field`; `store/` grew `slices/` + `interaction/`; `app/` bridges are bridges.
- `ui.css` became 15 fragments beside the modules they style, in a provably order-preserving cut.
- Vocabulary: "chrome" had meant three things, "composite" four.
- Single-sourced 17 more helpers (`errorMessage` ×8, `ndcToClient`, `clampIntoViewport`, …).
- The DAG tightened to what the code actually imports; a new `LayerKind` went from 2-of-4 compile
  errors to 4-of-4. `tests/live-modules.test.ts` now fails on code only its own test keeps alive.

**Part 8 — what the build emits, and where silence is the hazard**
- **The app bundle stopped carrying a validator nothing calls.** `schema/validators.generated.ts`
  (1 760 generated lines, only consumer its own codegen test) reached production through one bare
  `@schema` barrel import; a deep import took it off the eager graph — main chunk 416.7 → 371.3 kB raw.
- **Compile gates now cross the worker seam.** `FieldLayerParams` keyed on `FieldLayerKind`;
  `RenderRequest<K>` / `RenderResponse<K>` exported (24 sites hand-rolled the `Extract<…>`);
  `tracesLines` made load-bearing via `isTracingLayer` at eight sites that hardcoded `"fieldlines"`.
- **The browser instruments fail loudly instead of open** — `data-window` / `data-control` hooks
  instead of user-visible copy, and `profile-raymarch` returns 1 on a page that threw.
- Single-sourced the icon SVG recipe (16 CSS rules → one), the panel close button (3 → 1), the panel
  header, the layers-family glass recipe (3 → 1), two transition lists, `createFieldSceneBase`,
  `setOverlayFlag` (5 forwarders → 1), and one spelling for `worker.postMessage`.
- Ratchets: size budgets to measured values, the coverage floor finally set, `gen:check` out of CI
  (redundant with `schema-parity`, and it mutated the tree mid-run).
- Docs: DESIGN 1 089 → 880, this file 776 → ~200.

**Part 9 — `app/layerBridge`, the last untidied file in `app/`**
- A churn-vs-complexity ranking put it top by a factor of three. `installLayerBridge` was a 195-line
  body at cognitive complexity **42**, five subscriptions deep, with four diffing passes inside one
  of them.
- **The snapshot bookkeeping was the cause, not the passes.** Three channels hand-rolled
  `if (!isReady()) { lastX = x; return; }` plus a trailing `lastX = x` — the sole reason none could
  use `createStoreBridge`, which carried a carve-out naming this file. One `subscribeDiff` (the
  snapshot advances whether or not the listener acts) absorbed all four channels and deleted the four
  module `let`s. The carve-out is gone with them.
- **The two files re-checked the same thing.** `layerBridge` filtered by kind to decide whether to
  call; `layerMessages` re-checked the same kind to narrow its wide `Layer` parameter. Narrowing the
  seven signatures to `FieldLayer` / `VolumeLayer` / `SliceLayer` / `TracingLayer` deleted five silent
  runtime guards and four `as unknown as Parameters<…>` casts in the test.
- The two literal-guarded loops (`kind !== "volume"`, `kind !== "slice"`) became one exhaustive switch
  with a `satisfies never` arm: a new `Layer` variant is now a compile error (TS1360) until it says
  which of its params are live-editable, where before it silently got no diff.
- The eight-name destructure became one `send` object, so adding a message no longer edits both files.
- Body 195 → 98 lines, complexity 42 → under 20; the file itself grew 237 → 244. That is the trade
  this table's last row already records: a split buys named seams and costs lines.

**Part 10 — the ratchets become rules, and six things that were broken**

The pass began by measuring *what pins* the two ceilings, which no earlier part had done. The answer
was small and specific — the complexity ceiling of 49 was one file (`snapGeometry`'s two functions at
49 and 48, with nothing else above 38), and the line ceiling of 256 was one function (`installTopBar`
at 255). Splitting those two files alone moved both.

- **Six bugs, each found by an audit looking for something else.** They are in the section above.
- **The ratchets fell to 26 / 210** from 49 / 256, with four bodies that are long or branchy *by
  construction* now saying so in a one-line `biome-ignore` instead of hiding under a ceiling. Both
  numbers are honest: lowering either by one still fails. The targets remain 20 / 150.
- **Splits that landed:** `snapGeometry` (mirrored band-escape blocks written once), `installTopBar`
  (five sections → four modules + an assembly), `installCameraGestures` (three input families),
  `createLayerRegistry` (lifecycle vs. live edits), `installDragSnap` (geometry vs. CSS writing),
  `createRetrace` / `createRecompute`, and `createRangeControl`'s two pure halves.
- **The folder model finished:** `store/intents/` (which CLAUDE.md already cited and which did not
  exist), `app/bridges/`, and `app/main.ts` → `app/bootstrap.ts` so one file in the tree is `main`.
- **`vi.waitFor`'s 50 ms default poll was 37 % of the suite** — the third disguise of the real-clock
  wait CLAUDE.md bans, and the expensive one. 46 calls at `interval: 1` took the summed test time
  7.26 s → 5.1 s.
- **Docs:** six DESIGN/README claims had stopped being true (coverage "not gated", two stale budget
  pairs, a "not tested" that is tested, three wrong shader paths, a CI description that implied
  `gen:check` was a gate). The `§` guard now scans `TASKS.md` and immediately caught a dangling cite.


---

## Bugs the passes found

Not drift — actually broken, and each found by a pass looking for something else.

- **`ui/perfSparkline.ts` was infinite recursion** (`const xAt = (j) => xAt(j)`), shipped by Part 6's
  own split commit. Opening the perf HUD in a real browser threw `RangeError`. Its only coverage ran
  under happy-dom, where `getContext("2d")` is null and the paint bails first. *(found in P7)*
- **An `el` → `element` sweep rewrote a display string** — the grid-info card had been reading
  `az 45° element 30°` to users for days. The assertions used `toContain`. *(P7)*
- **`renderer.setSize` silently lost its device-pixel-ratio update** when a rename shadowed it. *(P7)*
- **`verify-streaming-render.ts` had been broken for two days** — a commit retitled the pane it
  locates. Local-only, so CI never noticed. *(P7)*
- **Two more instruments failed *open*** — locating the probe toggle by `aria-label` copy behind
  `if (count() > 0)`, so a reword makes it a silent no-op and every gesture then grabs the marker
  instead of the camera while reporting a plausible pose. *(P8)*
- **A recipe bound by one compute backend and not the other failed nowhere** — `computableFields` is
  the union over `BACKENDS.supports`, so the field just degrades in silence. *(P8)*
- **The `§` citation guard did not scan `tests/`**; switching it on immediately caught a dangling
  cite (a line wrap had split `CLAUDE.md` from its `§`). *(P8)*

---
- **A rename sweep had rewritten English into identifiers in 25 places** — 21 comments and four test
  titles. `57e83f4` made the renamer string-aware after P7's `el` → `element` incident but never
  comment-aware, so `a slow idle timer` became `a slow isIdle timer` and `e.g.` became `event.g.`
  `dragSnap.ts` had been explaining its ResizeObserver that way for five commits. *(P10)*
- **Two canonical-name authorities disagreed where it mattered.** `schema/registry.ts`'s `fieldInfo`
  threw on a per-species component (`V_s0_1`) where `data/readers/decode.ts`'s `resolveFieldMeta`
  resolved it — and the zarr reader admits exactly what the second one accepts. `topbar/info.ts`
  wraps `fieldInfo` in try/catch; `panels/fieldPanel.ts` does not, so a multi-species run would have
  taken the field panel down. Latent only because every vendored theme ships `default-panels = []`.
  *(P10)*
- **A disposer that was a no-op at all six call sites** — `installAnchoredOverlay` and
  `installOutsideClickDismiss` merged an optional caller signal with an internal controller and
  returned a disposer over the pair; every production caller aborts its own signal one line before
  calling it. `tests/live-modules.test.ts` cannot see this: it is file-level, not export-level. *(P10)*
- **A dead Zod schema reached both shipped chunks** — `compute/calibration.ts` is `STAGED:` and
  uncalled, but a bare `z.object()` expression statement is not provably pure, so Rollup kept it.
  Same shape as Part 8's validator. `/* @__PURE__ */` took the app bundle 401.5 → 395.1 kB gzip. *(P10)*
- **`scripts/shot-readme.ts` still failed open** — the one instrument Part 8 missed. It logged
  `pageerror` and then exited 0, so a hero screenshot of a broken page shipped looking fine. *(P10)*

## Settled — do not re-propose

Every item below was inspected and rejected, or measured and found not to be what the audit claimed.

### Stays as it is

- `managedOverlay.ts` — 24 lines with a 122-line test; its caller is already over the line ceiling. *(P5)*
- `isKnownPanel` + `SERVED_ELSEWHERE` — only user is the theme-drift guard, the test seam the rule exempts. *(P5)*
- `rangeMath`'s triple guard — two are each function's own contract, the third guards denormal underflow. *(P5)*
- Wire fields `shaded` / `continuous` / `active` keep their names — they mirror three.js and shader uniforms. *(P5)*
- `nudgePose`'s `lookMode` default (exercised by ten tests) and `formatPoseParam` (`parsePoseParam`'s tested inverse). *(P6)*
- `managedDecoration`'s ternary — it is the typed construction, not a redundant check. *(P6)*
- `makeLayer`'s three identical switch arms — the switch is what makes a fourth `LayerKind` fail to compile. *(P6)*
- `cursorRay` keeps its five parameters; only the two drag helpers changed. *(P6)*
- The four surface-local `ICON` maps — surface-specific glyphs live with their component, by rule. *(P6)*
- `worker.quality.test.ts` is **not** a duplicate of `qualityController.test.ts` — it proves the two
  worker entry paths reach the controller through a real rAF loop. *(P6)*
- No `_` prefix at `render/`'s root — everything there is infrastructure, so marking all marks nothing. *(P7)*
- No `RAIL_TOOLS` table — fourteen buttons in four shapes; a four-branch table is the
  registry-with-one-entry smell in a bigger coat. *(P7)*
- No `SURFACES` table in `installUi` — eleven explicit calls each carrying their reason is what a
  composition root should look like. *(P7)*
- `store/index.ts` stays a wholesale `export *` — nothing deep-imports `@store`, and knip reports the unused. *(P7)*
- No per-folder `index.ts` barrels in `ui/` — nine files that only forward. *(P7)*
- The perf HUD's CSS costs ~1 kB eager; keeping it lazy needs a second style-injection mechanism. *(P7)*
- The 16 `[hidden]` CSS rules stay per-surface — grouping fights Part 7's co-location, and each exists
  for specificity over `display:flex`. *(P8)*
- The hover/focus recipe is **four variants, not one** — unifying would change appearance on five
  surfaces. Same for the truncation triple: seven fragments, ten elements tagged, ~6 lines. *(P8)*
- `createSubscriptions` gets no lazy `signal` — it would move the abort into the LIFO chain and tear
  DOM listeners down *after* store unsubscribes on six interactive surfaces. *(P8)*
- No `worldToClient` — one of the three `worldToScreen` + `ndcToClient` pairs deliberately ignores `behind`. *(P8)*
- `installRenderer`'s two option spellings stay — unifying reorders module state inside device recovery. *(P8)*
- `store/layers.ts`'s six kind-field setters stay — each narrows on `layer.kind` first, and a keyed
  generic widens away from the union, trading the gate for ~25 lines. *(P8)*
- `ui/topbar/bar.ts`'s two picker chips stay two — one helper would carry two knobs for two callers. *(P8)*
- `data/cache.ts` and `webgpu/streamlines.ts` stay — `STAGED:`-marked, on the roadmap.
- **No `LAYER_KINDS`-driven table for the per-layer edit diff** — a keyed generic widens away from the
  discriminated union, the same reason `store/layers.ts`'s six kind setters stayed. The exhaustive
  switch is the compile gate at a third of the lines. *(P9)*
- **No `app/layerDiff.ts`** — the seam has one consumer, and `layerBridge.test.ts`'s 16 tests already
  cover the four passes 1:1. The split kept the diff as module functions in the same file. *(P9)*
- **No `before === layer` identity fast-path** in `sendLayerEdits` — behaviour-identical to the
  per-field comparisons on a list that never exceeds a handful of layers. *(P9)*
- **No shared helper for `panel.ts` ↔ `settings.ts`'s reorder buttons** — they diverge on class, on
  when the index resolves, and on focus restoration; ~10 lines to save ~8. *(P10)*
- **`hud.ts`'s `makeRow` and `row()` stay two** — one builds live-mutated DOM, the other a rebuilt
  HTML string. *(P10)*
- **No `rayPointAt` helper** — `origin + t·dir` in five files, and a helper costs 4 lines to save 4.
  The win would be structural only. *(P10)*
- **No shared skeleton for the two GPU kernel runners** — ≈ −2 lines, the `patchLayer` trap again. *(P10)*
- **The `WORKGROUP_SIZE` pairs keep their source-scraping assertions** — `gpu` may not import
  `shaders`, so the scraper is the only gate available there. Unlike `TRACE_META_BYTE_LENGTH`, where
  the DAG does permit the import and the type system now holds it. *(P10)*

### Claims that did not survive verification

- **27 bare casts → actually zero.** Every cast in non-test source already carried a WHY; there are
  also zero `!` assertions. *(P5, re-checked P7)*
- **Comment ratio would not reach 12 %.** It settled at 17.2 %: a scan for comments restating the line
  below found *one* in the whole tree. *(P5)*
- **`patchLayer` nets ~6 lines, not 45** — the helpers cost what the six copies saved. The win is
  structural, not arithmetic. *(P6)*
- **`traceSingleDirectionAdaptive` went 51 → 31, not "well under 20"** — its complexity was the
  integration loop, not the parameter list. *(P6)*
- **`bootstrap` is still ~255 lines** — the win is that a new bridge can no longer be silently left
  running, not brevity. *(P6)*
- **Most `data.worker` error paths are unreachable** from the message boundary. *(P6)*
- **The `@embed` layers are not dead weight** — all 17 exported symbols have real consumers; they
  *are* the published surface. *(P7)*
- **`tests/fixtures.ts`, `TOL`, and `STAGED:` placement are all correct** — zero local re-rolls,
  re-checked twice. *(P7, P8)*
- **The render↔worker protocol is the best-built seam in the repo** and was left alone. *(P7)*
- **`setUiVisible`'s missing identity guard is not a bug** — `ui/subscriptions.ts` uses
  `subscribeWithSelector` with `Object.is`, so a redundant `set` never reaches a subscriber. The four
  sibling guards are cosmetic, which makes *deleting* them the line-removing direction. *(P8)*
- **`FieldLayerParams` naming `"slice"` / `"volume"` as literals is correct** discriminated-union
  style, not a hardcoding to replace. *(P8)*
- **Nothing in `scripts/` is orphaned** — all 24 files reach a runner. *(P8)*
- **The Biome complexity ceiling did not fall to 20.** It is pinned at 49 by `snapGeometry.ts:228`
  (and `chooseEdge` beside it at 48) — both `src/`, so scoping the rule to exclude tests frees nothing. *(P8)*
- **Nor did it fall in Part 9.** `layerBridge` was the *second* offender at 42; splitting it left
  `snapGeometry` still pinning 49, so `biome.jsonc` did not move. A probe that appeared to show a new
  max of 38 was Biome's default 20-diagnostic cap truncating the list — re-measure with
  `--max-diagnostics` before trusting a ratchet drop. *(P9)*
- **"Every cast in non-test source carries a WHY" was false by one** — `easedChannels.ts:34`, whose
  identical twin in `store/layerKinds.ts` does carry the reason. Fixed; the claim is true again. *(P10)*
- **"Zero local re-rolls of `tests/fixtures.ts`" was false twice** — `makeGrid` hand-written in three
  places (the tell is a literal `survivingAxes: null`) and `sampleCellCentered` written byte for byte
  in `scripts/gen-trace-fixtures.ts` and `numerics/tracing.test.ts`, the two sides of the pypic
  trace-golden comparison. Both single-sourced. *(P10)*
- **The complexity ceiling was never measured tree-wide.** Every earlier probe scanned `src/` only;
  the real worst value was 33, in `scripts/verify-streaming-render.ts`. Scan the whole tree, or the
  ratchet you set is the one you can see. *(P10)*

### Tooling deliberately not adopted

`useNamingConvention`, `noBarrelFile`, `useFilenamingConvention` (pypic is snake_case), Stryker /
fast-check (seeded fuzz already exists), golden-image tests, CONTRIBUTING / CHANGELOG / PR templates,
cspell / markdownlint / actionlint. Coverage-as-a-gate was on this list until Part 8, when the number
had the five points of history `TASKS.md` had set as its trigger.

Also: anything in memory `perf-review-non-wins`, `tot-select-chain-no-win`, or
`code-health-review-2026-09`.

---

## Traps worth remembering

- **`interface X extends Record<K, …>` is not a completeness gate** — it *inherits* the missing key
  rather than demanding it. The gate is the indexed access in a mapped type.
- **`Request` / `Response` are DOM globals** — exporting those names repo-wide shadows `fetch`'s types.
- **A ratchet needs a slack guard.** The header-cap ratchet's guard is what caught its own retirement:
  trimming the last file made it fail, which is exactly the signal that a ceiling has stopped meaning
  anything.
- **An exclusion is a promise with no expiry check.** `check:dead`'s `--exclude exports,types` outlived
  the cull it was written for and hid a one-caller abstraction and a dead control path for two parts.
- **A title is copy; a hook is a contract.** Three instruments broke on retitled UI before this landed.
- **`data-control="layers"` is ambiguous** — the topbar's disabled placeholder and the side-rail button
  share it. Scope by `.webpic-siderail` in any probe.- **A `biome-ignore` must be a single comment.** A wrapped second `//` line becomes the
  immediately-preceding comment, and the suppression silently reports as unused.
- **Suppressions and the ceiling drop belong in one commit.** Biome's `suppressions/unused` fires on
  a suppression added while the old ceiling still covers it.
- **A rename sweep must skip comments as well as string literals.** P7 learned the literal half of
  this; P10 found the other half, five commits after the sweep that caused it.

- **`cleanup.md` keeps the path citations it was written with** — it records what was decided *then*.

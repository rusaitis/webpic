<p align="center">
  <img src="https://raw.githubusercontent.com/rusaitis/webpic/main/docs/assets/webpic-logo.png" alt="webpic" width="440">
</p>

<p align="center"><em>Plasma simulation data, rendered in the browser</em></p>

<p align="center">
  <a href="https://github.com/rusaitis/webpic/actions/workflows/ci.yml"><img src="https://github.com/rusaitis/webpic/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://rusaitis.github.io/webpic/"><img src="https://img.shields.io/badge/demo-live-brightgreen" alt="Live demo"></a>
  <a href="https://github.com/rusaitis/webpic/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/WebGPU-required-orange" alt="WebGPU required">
  <a href="https://doi.org/10.5281/zenodo.22069392"><img src="https://zenodo.org/badge/DOI/10.5281/zenodo.22069392.svg" alt="DOI"></a>
  <img src="https://img.shields.io/badge/TypeScript-6.0-blue" alt="TypeScript 6.0">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/rusaitis/webpic/main/docs/assets/webpic-hero.png" alt="webpic rendering a synthetic magnetic flux rope: volume raymarching of |B| with traced field lines" width="900">
</p>

A browser-native 3D visualizer and lightweight analyzer for plasma simulation output from
particle-in-cell (PIC) and magnetohydrodynamic (MHD) codes. Volume raymarching, orthogonal
slices, and adaptive field-line tracing all run on **WebGPU** — no install, no server, no
Python on the client.

Looking at 3D plasma data usually means a desktop application, a remote visualization node,
or a notebook that re-renders on every parameter change. webpic puts the viewer where the
data already is: open a URL, drop in a Zarr store, and orbit it. It reads the same canonical
field schema as [**pypic**](https://github.com/rusaitis/pypic) — same `simulation.toml`, same
`B_1`/`|B|`/`beta` names, same physics conventions — so the browser view and the Python
analysis agree by construction rather than by convention.

## Try it

**[rusaitis.github.io/webpic](https://rusaitis.github.io/webpic/)** — boots on a synthetic
magnetic flux rope, no data needed. Left-drag orbits, wheel dollies, right-drag pans,
double-click focuses. `?fieldlines` adds traced field lines; `?n=128` raises the volume
resolution.

Or run it locally:

```sh
git clone https://github.com/rusaitis/webpic.git && cd webpic
npm install
npm run dev
```

## What it does

| | |
|---|---|
| **Volume rendering** | Single-pass WebGPU raymarcher with analytic ray–box intersection, early-α termination, and optional central-difference Phong shading |
| **Slices** | Orthogonal planes sampling the same 3D texture, with linear / log / symlog transfer functions |
| **Field lines** | Adaptive Dormand–Prince RK45 tracing, on GPU or CPU, agreeing with pypic's tracer to counts-exact parity |
| **Layers** | Volumes, slices, and field lines co-display as an ordered, individually-configurable layer stack |
| **Time series** | Scrub through timesteps with a prefetching ring buffer and ping-pong texture upload — no pipeline recompile per step |
| **Data** | Zarr v3 read and write (via [zarrita](https://github.com/manzt/zarrita.js)), OPFS-backed caching, Yee-grid destaggering on load |
| **Derived quantities** | Magnitudes, curl, divergence, and gradient, computed in TypeScript or WGSL against the same reference implementation |

Everything renders off the main thread: the scene lives on an `OffscreenCanvas` in a render
worker, data reads and scrub-path compute in a data worker.

## Correctness

Numerical code that renders pretty pictures is easy to get subtly wrong, so the physics is
pinned down rather than eyeballed:

- **1200+ tests** — pure-function suites over the math layers, the store intents, and the
  compute backends.
- **Analytical fixtures** at explicit per-kernel × per-precision tolerances, over named MHD
  configurations (Orszag–Tang, Harris sheet, GEM reconnection).
- **Conservation identities** — `div(curl F)` and `curl(grad f)` to machine precision.
- **Cross-language parity** — field and trace goldens generated from pypic, plus WGSL-vs-TypeScript
  kernel comparison on a real GPU (`npm run test:gpu`).
- **Enforced architecture** — the 18-layer dependency DAG is checked in CI by a ts-morph pass, so
  `ui` cannot reach into `render` and the math layers stay free of Three.js and the DOM.

## Browser support

WebGPU is required — there is no WebGL fallback. Chrome/Edge 113+, Safari 18+, and
Firefox 141+ all work; on Safari and older Firefox it may need enabling in settings.
Anything else gets an explicit message rather than a blank canvas.

## Relationship to pypic

[pypic](https://github.com/rusaitis/pypic) is the schema and physics authority; webpic is a
consumer. Canonical field names, derived-quantity recipes, and the JSON Schema for
`simulation.toml` are generated from pypic's export bundle by `npm run gen`.

**Those generated outputs are committed**, so webpic clones, builds, tests, and runs with no
Python installed. A pypic checkout is needed only to regenerate them (`npm run gen`) or to run
the opt-in cross-language parity suites (`WEBPIC_PYPIC_PARITY=1 npm test`).

## Development

```sh
npm run dev              # Vite dev server
npm run typecheck        # app + worker tsconfigs
npm run check:boundaries # layer-DAG enforcement (ts-morph)
npm run gen:check        # schema codegen drift guard
npm run lint             # Biome
npm run test             # Vitest (node + dom projects)
npm run build            # production build
npm run test:gpu         # real-GPU suites, headed Chrome (local only)
```

CI runs everything except `test:gpu`, which needs a real adapter.

Architecture and design rationale — the layer DAG, schema codegen, the compute dispatcher,
tolerance policy, and the open risks — live in
[docs/DESIGN.md](docs/DESIGN.md). The milestone checklist is [TASKS.md](TASKS.md), and
contributor conventions are in [CLAUDE.md](CLAUDE.md).

## Status

**Early-stage research software (0.1.x), under active development.** v0.1 covers volume, slice,
and field-line rendering over Zarr v3, with time-series scrub and export. Known limits:

- 256³ is the current volume ceiling; 512³ with LOD bricking is backlogged.
- Zarr v3 only — HDF5 and Parquet readers are planned for v0.2.
- The remote client for `pypic.server` (Arrow IPC over WebSocket) is designed but not built.
- Particle rendering, LIC, and oblique slices are v0.2.

The embed bundle is budget-gated in CI (539 kB of 1 MB gzipped; app 407 kB of 1.6 MB).
See [TASKS.md](TASKS.md) for the full roadmap.

## Citing

If webpic contributes to work you publish, please cite it. The concept DOI
[10.5281/zenodo.22069392](https://doi.org/10.5281/zenodo.22069392) always resolves to the latest release; each release
also gets its own version DOI. Metadata lives in [CITATION.cff](CITATION.cff), which GitHub
renders as a ready-to-paste citation via the *Cite this repository* button.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Built on [three.js](https://threejs.org/) (WebGPU renderer), [zarrita](https://github.com/manzt/zarrita.js),
[zustand](https://github.com/pmndrs/zustand), and [zod](https://zod.dev/).

Several bundled themes adapt palettes from the
[Catppuccin](https://github.com/catppuccin/catppuccin),
[Andromeda](https://github.com/EliverLara/Andromeda), and
[AnuPpuccin](https://github.com/AnubisNekhet/AnuPpuccin) colour schemes, each under its own
license. The scientific colormaps follow the perceptually-uniform families from matplotlib.

import type { ColorScale } from "@schema/colormap.ts";
import type { Vec3 } from "@schema/types.ts";
import { BoxGeometry, FrontSide, Mesh, Scene } from "three";
import {
  Break,
  cameraPosition,
  cameraWorldMatrix,
  ceil,
  Fn,
  float,
  fract,
  If,
  Loop,
  max,
  modelWorldMatrixInverse,
  positionGeometry,
  screenCoordinate,
  texture,
  texture3D,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  wgslFn,
} from "three/tsl";
import { type Node, NodeMaterial } from "three/webgpu";
import { buildMinMaxGrid, createSkipTexture } from "./minMaxGrid.ts";
import { createNormalization, type WindowLevel } from "./normalization.ts";
import { GRAD_EPS, PHONG } from "./shading.ts";
import { createTransferFunctionTexture } from "./transferFunction.ts";
import { createVolumeTexture, type ScalarField } from "./volumeTexture.ts";

// Single-pass volume raymarcher over the shared `uVolume`. The analytic ray-box clip is
// `wgslFn hitBox` — the WGSL twin of rayBox.ts.
//
// Two march paths: the default fixed-step `Loop`, and an opt-in (`skipEmptySpace`) two-level coarse-
// skip / fine-march over a min-max brick grid (minMaxGrid.ts) that jumps transparent bricks while
// keeping occupied samples on the fixed lattice (output-equivalent). OFF by default — it only pays
// off on sparse fields; on space-filling |B| the per-step skip-grid fetch is pure overhead (~1.7×
// slower on the synthetic flux rope). Enable it for genuinely sparse data (vacuum, isolated ropes).

export interface RaymarchSceneOptions {
  readonly field: ScalarField;
  /** Theme colormap name (`theme.colormaps.sequential`); unknown → inferno. */
  readonly colormap: string;
  /** Value→color window; absent → the field's full finite range (identity normalization). */
  readonly windowLevel?: WindowLevel;
  /** Value→color scale within the window; default linear. */
  readonly scale?: ColorScale;
  /** Fine samples per ray across the clipped segment (also the empty-space-skip lattice). */
  readonly steps?: number;
  /** Opt in to empty-space skipping (default false). A net win only for sparse fields — on
   *  space-filling |B| it costs ~1.7× (the skip-grid fetch buys no skips). See the file header. */
  readonly skipEmptySpace?: boolean;
  /** Empty-space-skip brick edge in voxels (only when `skipEmptySpace`); larger = coarser skips.
   *  Default 8. */
  readonly brickSize?: number;
  /** Opacity scale for the emission-absorption transfer. */
  readonly density?: number;
  /** Opt in to Phong shading (default false). A render-local lighting normal from the field
   *  gradient — a shape-perception aid, *not* quantitative (the lit surface is a TF-dependent
   *  opacity isosurface). The 6 gradient taps/step are gated on sample opacity (see the march). */
  readonly shaded?: boolean;
  /** Per-layer opacity multiplier on the composited alpha (composite fade), [0,1]; default 1. */
  readonly opacity?: number;
  /** Device supports R32F linear sampling — picks the volume texture format. */
  readonly float32Filterable?: boolean;
  /** Per-axis world half-extent of the volume box; default [0.5,0.5,0.5] (the unit cube). A non-cubic
   *  grid scales the mesh to this so the volume renders at true physical aspect — object/texture space
   *  stays canonical [-0.5,0.5]/[0,1], so the raymarch math (ray-box clip, sampling) is unchanged. */
  readonly worldHalfExtent?: Vec3;
}

export interface RaymarchScene {
  readonly scene: Scene;
  /** Update the value→color window in place (no texture re-upload). */
  setWindowLevel(center: number, width: number): void;
  /** Rebake the colormap LUT in place (idempotent on an unchanged name). */
  setColormap(name: string): void;
  /** Switch the value→color scale in place (uniform only). */
  setScale(scale: ColorScale): void;
  /** Toggle Phong shading in place (uniform only, no rebuild — the volume stays uploaded). */
  setShading(enabled: boolean): void;
  /** Update the per-layer opacity in place (uniform only, no rebuild). */
  setOpacity(opacity: number): void;
  /** Scale the marched step count in place (uniform only) — interaction-time quality. The march
   *  always allocates `steps` iterations and Breaks at ceil(steps·scale), so full quality (1) is
   *  bit-identical to a fixed march. Clamped to (0, 1]. */
  setStepScale(scale: number): void;
  /** Ping-pong a new timestep's field into the volume in place (no rebuild — time-series scrub).
   *  Returns false when the in-place swap can't apply (shape change, or an empty-space-skip volume
   *  whose acceleration grid would go stale); the caller then rebuilds the scene. */
  setField(field: ScalarField): boolean;
  /** Switch ray generation between perspective and orthographic (parallel rays) in place — a
   *  uniform flip, no rebuild. The worker pairs it with the matching camera. */
  setProjection(orthographic: boolean): void;
  dispose(): void;
}

const DEFAULT_STEPS = 256; // fine-march / perf-gate depth
const DEFAULT_BRICK_SIZE = 8; // empty-space-skip brick edge (voxels); (256/8)³ = 32³ skip grid
const EARLY_ALPHA = 0.98;
// A brick is "empty" when its max value maps below one 8-bit color step — its samples can't move the
// pixel, so the march jumps it. Window-aware (norm.toT is uniform-driven), recomputed live.
const EMPTY_T = 1 / 255;
// Phong is gated on per-sample opacity `t` (the dt-free form of sampleAlpha): a sample mapping below
// one color step can't move the pixel, so it skips the 6 gradient taps — the gate that keeps shading
// off the 8 ms budget. Reusing EMPTY_T's threshold keeps "transparent here" one definition.
const SHADE_T_FLOOR = EMPTY_T;
// Object-space nudge past a brick face so the post-skip floor() lands in the next brick. The crossing
// axis has non-zero ray dir (else its face is unreachable, not the nearest), so any ε > 0 crosses it.
const BRICK_EPS = 1e-4;

// Object space is the unit box [-0.5, 0.5]³ (BoxGeometry centered at origin); texture coords
// are `pos + 0.5`. Branch-free slab test. An axis-parallel ray has a ~0 dir component, where a
// plain 1/dir is ±Inf and `(box - orig) * Inf` becomes 0*Inf = NaN bounds; guard it to a large
// finite slope so that axis stays effectively unbounded (the other two axes clip the ray).
const hitBox = wgslFn<{ orig: Node; dir: Node }>(`
  fn hitBox( orig: vec3<f32>, dir: vec3<f32> ) -> vec2<f32> {
    let box_min = vec3<f32>( -0.5 );
    let box_max = vec3<f32>(  0.5 );
    let inv_dir = select( vec3<f32>( 1.0e30 ), 1.0 / dir, abs( dir ) > vec3<f32>( 1.0e-8 ) );
    let tmin_tmp = ( box_min - orig ) * inv_dir;
    let tmax_tmp = ( box_max - orig ) * inv_dir;
    let tmn = min( tmin_tmp, tmax_tmp );
    let tmx = max( tmin_tmp, tmax_tmp );
    let t0 = max( tmn.x, max( tmn.y, tmn.z ) );
    let t1 = min( tmx.x, min( tmx.y, tmx.z ) );
    return vec2<f32>( t0, t1 );
  }
`);

// Ray-t distance from `tex_pos` (∈[0,1]³) to the far face of its current skip-grid brick — the slab
// test against one brick, the empty-space-skip step. `grid` is the brick counts per axis. An axis
// (near-)parallel to its faces can't bound the brick, so it's forced past the others (1e30). The TS
// twin (tested) is brickStep.ts `brickAdvanceDistance`, the rayBox.ts ↔ hitBox precedent.
const brickAdvance = wgslFn<{ tex_pos: Node; dir: Node; grid: Node }>(`
  fn brickAdvance( tex_pos: vec3<f32>, dir: vec3<f32>, grid: vec3<f32> ) -> f32 {
    let cell = floor( tex_pos * grid );
    let stepf = select( vec3<f32>( 0.0 ), vec3<f32>( 1.0 ), dir > vec3<f32>( 0.0 ) );
    let face = ( cell + stepf ) / grid;
    let near_zero = abs( dir ) <= vec3<f32>( 1.0e-8 );
    let safe_dir = select( dir, vec3<f32>( 1.0 ), near_zero );
    let t_raw = ( face - tex_pos ) / safe_dir;
    let t_face = select( t_raw, vec3<f32>( 1.0e30 ), near_zero );
    return min( t_face.x, min( t_face.y, t_face.z ) );
  }
`);

/** Build a themed single-pass raymarch scene from a 3D scalar field. */
export function createRaymarchScene(opts: RaymarchSceneOptions): RaymarchScene {
  const volume = createVolumeTexture(opts.field, opts.float32Filterable);
  const tf = createTransferFunctionTexture(opts.colormap);
  const steps = opts.steps ?? DEFAULT_STEPS;

  // Empty-space-skip acceleration structure, built only when opted in — the default fixed march pays
  // no CPU reduction, no texture upload, and no per-step skip-grid fetch. `volume.min` is the brick
  // fallback so all-NaN bricks map to the colormap floor (skippable), matching the volume's NaN→min.
  const skipState = opts.skipEmptySpace
    ? (() => {
        const grid = buildMinMaxGrid(opts.field, opts.brickSize ?? DEFAULT_BRICK_SIZE, volume.min);
        const tex = createSkipTexture(grid);
        const [gw, gh, gd] = grid.dims;
        // Bound: fine steps ride the lattice (≤ steps), a ray crosses ≤ gw+gh+gd bricks. Integer-bounded
        // → guaranteed termination (a float `while` can stall below its ULP and hang the GPU).
        return { tex, gridDims: vec3(gw, gh, gd), maxIters: steps + gw + gh + gd + 2 };
      })()
    : undefined;

  // Default window spans the full finite range, reproducing the old (v−min)/(max−min) map.
  const norm = createNormalization(volume.min, volume.max, opts.windowLevel, opts.scale);
  const uDensity = uniform(opts.density ?? 1);
  const uLayerOpacity = uniform(opts.opacity ?? 1);
  const uShade = uniform(opts.shaded ? 1 : 0); // live Phong toggle; 0 ⇒ the gradient taps never run
  // Interaction-time quality: the live march count is ceil(steps · scale) — dt stretches to match,
  // so the emission-absorption integral keeps its meaning at any scale. At 1 the math reduces to
  // the fixed march exactly (ceil(steps·1) = steps); the WGSL loop bound stays the literal `steps`.
  const uStepScale = uniform(1);
  // Ray-start jitter gate, slaved to the step scale: 1 during the coarse interaction march, 0 at
  // full quality so the settled frame keeps the un-jittered lattice (parity-pinned).
  const uJitter = uniform(0);
  // Projection flip as a uniform branch, not a shader variant: two selects + one mat4·vec4 per
  // fragment is noise next to the march, while a variant would double the pipeline count and the
  // warm-compile work on every upsert/device-restore.
  const uOrtho = uniform(0);

  // Object-space voxel step for central-difference gradient taps. Under the z-up world=physical
  // convention the volume is sampled at the .zyx swizzle (see sampleRawAt), so object axis i ↔ field
  // axis i — object x's one-voxel step is 1/shape[0] (field axis 0), etc. ClampToEdge means boundary
  // taps saturate (gradient → 0 at the very face).
  const fieldShape = opts.field.shape;
  const voxelStep = vec3(
    1 / (fieldShape[0] ?? 1),
    1 / (fieldShape[1] ?? 1),
    1 / (fieldShape[2] ?? 1),
  );

  const rgba = Fn(() => {
    // Camera ray in object space; the box is axis-aligned there so the slab test is exact.
    // Perspective: rays fan out from the camera point through each fragment. Orthographic: parallel
    // rays along the camera forward (w=0 — rotation only through both matrices), originating on the
    // box front face itself (the fragment), where hitBox's entry clamps to 0.
    const perspOrigin = varying(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz);
    const orthoForward = varying(
      modelWorldMatrixInverse.mul(cameraWorldMatrix.mul(vec4(0, 0, -1, 0))).xyz,
    );
    const isOrtho = uOrtho.greaterThan(0.5);
    const rayOrigin = isOrtho.select(positionGeometry, perspOrigin).toVar();
    const rayDir = isOrtho
      .select(orthoForward.normalize(), positionGeometry.sub(perspOrigin).normalize())
      .toVar();
    // Headlight view direction (surface → camera). The Phong light coincides with it, so whatever
    // faces the camera is lit and orbiting reveals shape (no scene light to manage).
    const viewDir = rayDir.negate();

    // wgslFn returns an untyped `Node`; the WGSL signature returns vec2<f32> (entry, exit).
    const bounds = (hitBox({ orig: rayOrigin, dir: rayDir }) as Node<"vec2">).toVar();
    // Discard unless the ray has a positive segment through the box. `NOT (exit > entry)` also
    // catches grazing (exit == entry, dt would be 0) and any NaN bounds (NaN > x is false), so the
    // march only runs on a valid finite interval.
    bounds.y.greaterThan(bounds.x).not().discard();

    const tEntry = max(bounds.x, 0.0); // clamp the entry to the camera
    const tExit = bounds.y;
    const liveSteps = ceil(float(steps).mul(uStepScale)).max(1.0).toVar();
    const dt = tExit.sub(tEntry).div(liveSteps).toVar(); // fine step; the lattice is tStart + k·dt
    // Interleaved gradient noise (Jimenez 2014): a per-pixel march phase that turns the coarse
    // march's onion-shell banding into unstructured noise. uJitter is 0 at full quality, so
    // tStart ≡ tEntry there and the settled frame is bit-identical to the fixed lattice.
    const ign = fract(
      float(52.9829189).mul(
        fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715))),
      ),
    );
    const tStart = tEntry.add(dt.mul(ign).mul(uJitter)).toVar();
    const accumColor = vec3(0).toVar();
    const accumAlpha = float(0).toVar();

    // Sample the raw field at a texture-space position with the non-finite guard. Trilinear sampling
    // near volume edges can yield NaN/±Inf on some drivers; both must be neutralized before they enter
    // accumulation or the gradient (a non-finite α drives the un-premultiply divide to a magenta
    // fragment). `|raw| < 1e30` is false for either, so both swap to 0. Shared by the sample + the taps.
    const sampleRawAt = (p: Node<"vec3">): Node<"float"> => {
      // z-up, world=physical: object axis i ↔ field axis i (identity, right-handed). The texture is
      // C-order (object x↔field 2, y↔1, z↔0), so its built-in reversal is undone by sampling at the
      // .zyx swizzle of the object-space position — reversal∘reversal = identity. One swappable node
      // so a streamed step re-binds the main sample + all 6 gradient taps that share this helper.
      const raw = volume.node.sample(p.zyx).r;
      return raw.abs().lessThan(float(1e30)).select(raw, float(0));
    };

    // One front-to-back emission-absorption sample at a texture-space position — shared by both march
    // paths so the accumulation math lives once. Object [-0.5,0.5]³ → texture [0,1]³; texture axes are
    // the reverse of field axes (volumeTexture C-order: object x/y/z ↔ field axis 2/1/0).
    const accumulate = (texPos: Node<"vec3">): void => {
      const t = norm.toT(sampleRawAt(texPos));
      // Opacity stays value-proportional (t·density); the LUT alpha channel is reserved for the
      // opacity transfer function, so color comes from the LUT but opacity doesn't.
      const sampleAlpha = t.mul(uDensity).mul(dt).saturate();
      const weight = accumAlpha.oneMinus(); // front-to-back: (1 - accumulated)
      const rgb = texture(tf.texture, vec2(t, 0.5)).rgb.toVar();

      // Phong (opt-in via uShade): a render-local lighting normal from the field gradient. Gated on
      // uShade AND a contributing opacity `t` so transparent samples skip the 6 gradient taps
      // (shading.ts is the pure twin of this math).
      If(uShade.greaterThan(0.5).and(t.greaterThan(SHADE_T_FLOOR)), () => {
        const dx = vec3(voxelStep.x, 0, 0);
        const dy = vec3(0, voxelStep.y, 0);
        const dz = vec3(0, 0, voxelStep.z);
        const grad = vec3(
          sampleRawAt(texPos.add(dx)).sub(sampleRawAt(texPos.sub(dx))),
          sampleRawAt(texPos.add(dy)).sub(sampleRawAt(texPos.sub(dy))),
          sampleRawAt(texPos.add(dz)).sub(sampleRawAt(texPos.sub(dz))),
        );
        const gradLen = grad.dot(grad).sqrt();
        // Locally flat (|grad| ≈ 0) → no surface; face the viewer so it renders lit-but-flat, not NaN.
        const normal = gradLen.greaterThan(GRAD_EPS).select(grad.div(gradLen), viewDir);
        // Two-sided: an opacity isosurface has no consistent winding, so flip toward the viewer. With
        // a headlight (light = view = half-vector), n·l = n·h = |n·v| ≡ ndl.
        const faced = normal.dot(viewDir).lessThan(0).select(normal.negate(), normal);
        const ndl = faced.dot(viewDir).max(0);
        const shade = float(PHONG.ambient)
          .add(ndl.mul(PHONG.diffuse))
          .add(ndl.pow(PHONG.shininess).mul(PHONG.specular));
        rgb.assign(rgb.mul(shade));
      });

      accumColor.addAssign(rgb.mul(sampleAlpha).mul(weight));
      accumAlpha.addAssign(sampleAlpha.mul(weight));
    };

    if (skipState !== undefined) {
      // Two-level traversal: read the coarse brick max; fine-march occupied bricks, jump empty ones
      // to their far face *snapped back onto the lattice* so occupied samples land exactly where the
      // fixed march would — output-equivalent, not merely close.
      const { tex, gridDims, maxIters } = skipState;
      const tCur = tStart.toVar();
      Loop(maxIters, () => {
        If(tCur.greaterThanEqual(tExit), () => {
          Break();
        });
        const texPos = rayOrigin.add(rayDir.mul(tCur)).add(0.5);
        // norm.toT is monotonic in value, so a brick whose max maps below EMPTY_T has every sample
        // below it: skipping it can't change the pixel (window-aware, recomputed live).
        // Same .zyx swizzle as the volume sample so the brick lookup addresses the physical brick the
        // ray occupies (the skip grid is built + uploaded C-order, identical to the volume texture).
        const occupied = norm.toT(texture3D(tex.texture, texPos.zyx).r).greaterThan(EMPTY_T);
        If(occupied, () => {
          accumulate(texPos);
          tCur.addAssign(dt);
        });
        If(occupied.not(), () => {
          // Jump to the brick's far face, then snap up to the next lattice point so the fine grid
          // stays globally aligned. BRICK_EPS pushes strictly past the face (its axis has non-zero
          // dir), so the next floor() lands in the following brick, never this one again.
          const adv = brickAdvance({
            tex_pos: texPos,
            dir: rayDir,
            grid: gridDims,
          }) as Node<"float">;
          const tSkip = tCur.add(adv).add(BRICK_EPS);
          tCur.assign(tStart.add(ceil(tSkip.sub(tStart).div(dt)).mul(dt)));
        });
        If(accumAlpha.greaterThanEqual(EARLY_ALPHA), () => {
          Break();
        });
      });
    } else {
      // Fixed march (default): `pos` steps `liveSteps` times by `dt` from entry to exit. An integer
      // counter always terminates, unlike a float `for(i=entry; i<exit; i+=dt)` which can stall when
      // dt falls below the float ULP at entry's world-distance magnitude — a GPU hang → device loss.
      // The WGSL bound stays the literal `steps`; the counter Breaks at the uniform-driven live count.
      const pos = rayOrigin.add(tStart.mul(rayDir)).toVar();
      const stepIndex = float(0).toVar();
      Loop(steps, () => {
        If(stepIndex.greaterThanEqual(liveSteps), () => {
          Break(); // interaction-time coarse march reached its live count
        });
        accumulate(pos.add(0.5));
        If(accumAlpha.greaterThanEqual(EARLY_ALPHA), () => {
          Break(); // opaque enough — remaining samples can't change the pixel
        });
        pos.addAssign(rayDir.mul(dt));
        stepIndex.addAssign(1);
      });
    }

    // accumColor is premultiplied (Σ color·α·weight); un-premultiply so the default normal
    // blend (src·α + dst·(1−α)) composites it correctly over the cleared background. The
    // per-layer opacity scales the whole layer's emitted alpha — a uniform composite fade.
    return vec4(accumColor.div(max(accumAlpha, 1e-4)), accumAlpha.mul(uLayerOpacity));
    // One shared temp: colorNode/opacityNode read .rgb/.a from it, so the march runs once.
  })().toVar();

  const material = new NodeMaterial();
  material.colorNode = rgba.rgb;
  material.opacityNode = rgba.a;
  material.transparent = true;
  material.depthWrite = false;
  material.side = FrontSide;

  const geometry = new BoxGeometry(1, 1, 1);
  const mesh = new Mesh(geometry, material);
  // Object space stays the unit box [-0.5,0.5]³ (the raymarch clips + samples there); a non-uniform
  // model scale stretches it to the dataset's physical aspect in world space. Cubic → (1,1,1), so the
  // flux rope is byte-identical. (Phong normals skew slightly under non-uniform scale — shading is
  // already non-quantitative + default-off, so this is acceptable.)
  const half = opts.worldHalfExtent ?? [0.5, 0.5, 0.5];
  mesh.scale.set(2 * half[0], 2 * half[1], 2 * half[2]);

  // No scene.background — the renderer owns the clear color so layers composite over one
  // background (a per-scene Color background would force a clear and wipe earlier layers).
  const scene = new Scene();
  scene.add(mesh);

  return {
    scene,
    setWindowLevel: norm.setWindow,
    setColormap: tf.setColormap,
    setScale: norm.setScale,
    setShading(enabled) {
      uShade.value = enabled ? 1 : 0;
    },
    setOpacity(opacity) {
      uLayerOpacity.value = opacity;
    },
    setStepScale(scale) {
      const clamped = Math.min(Math.max(scale, 0.05), 1);
      uStepScale.value = clamped;
      uJitter.value = clamped < 1 ? 1 : 0; // jitter only the coarse march (see uJitter)
    },
    setField(field) {
      // The empty-space-skip grid is built once from the construction field; a streamed step would
      // leave it stale, so force a rebuild there. Default (no skip) takes the in-place ping-pong.
      if (skipState !== undefined) return false;
      return volume.setField(field);
    },
    setProjection(orthographic) {
      uOrtho.value = orthographic ? 1 : 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      volume.dispose();
      skipState?.tex.dispose();
      tf.dispose();
    },
  };
}

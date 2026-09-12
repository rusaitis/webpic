import type { ColorScale } from "@schema/colormap.ts";
import { clamp, UNIT_BOX_HALF_EXTENT } from "@schema/math.ts";
import type { Vec3 } from "@schema/types.ts";
import { BackSide, BoxGeometry, Mesh, Scene } from "three";
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
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  wgslFn,
} from "three/tsl";
import { type Node, NodeMaterial } from "three/webgpu";
import type { VolumeLayerScene } from "../layerScene.ts";
import { createNormalization, type Normalization, type WindowLevel } from "./normalization.ts";
import { GRAD_EPS, PHONG } from "./shading.ts";
import { createTransferFunctionTexture, type TransferFunctionTexture } from "./transferFunction.ts";
import { createVolumeTexture, type ScalarField, type VolumeTexture } from "./volumeTexture.ts";

// Single-pass volume raymarcher over the shared `uVolume`. The analytic ray-box clip is
// `wgslFn hitBox` — the WGSL twin of rayBox.ts.
//
// `buildRaymarchMaterial` (the TSL/WGSL graph) is split from the preserved GPU resources + uniforms
// (`buildRaymarchGraph`) so the dev shader hot-reload (`rebuildShader`) can swap the material from
// freshly imported graph code without re-uploading the 64 MiB volume texture or losing the look/pose.

export interface RaymarchSceneOptions {
  readonly field: ScalarField;
  /** Theme colormap name (`theme.colormaps.sequential`); unknown → inferno. */
  readonly colormap: string;
  /** Value→color window; absent → the field's full finite range (identity normalization). */
  readonly windowLevel?: WindowLevel;
  /** Value→color scale within the window; default linear. */
  readonly scale?: ColorScale;
  /** Samples per ray across the clipped segment. */
  readonly steps?: number;
  /** Opacity scale for the emission-absorption transfer. */
  readonly density?: number;
  /** Opt in to Phong shading (default false). A render-local lighting normal from the field
   *  gradient — a shape-perception aid, *not* quantitative (the lit surface is a TF-dependent
   *  opacity isosurface). The 6 gradient taps/step are gated on sample opacity (see the march). */
  readonly shaded?: boolean;
  /** Per-layer opacity multiplier on the composited alpha (composite fade), [0,1]; default 1. */
  readonly opacity?: number;
  /** Device supports R32F linear sampling — picks the volume texture format. */
  readonly hasFloat32Filterable?: boolean;
  /** Per-axis world half-extent of the volume box; default [0.5,0.5,0.5] (the unit cube). A non-cubic
   *  grid scales the mesh to this so the volume renders at true physical aspect — object/texture space
   *  stays canonical [-0.5,0.5]/[0,1], so the raymarch math (ray-box clip, sampling) is unchanged. */
  readonly worldHalfExtent?: Vec3;
  /** Layer id keying the volume texture into the VRAM ledger (perf HUD); omit to skip tracking. */
  readonly ledgerKey?: string;
}

// A raymarched volume is the VolumeLayerScene contract plus the dev shader hot-reload seam.
export interface RaymarchScene extends VolumeLayerScene {
  /** Dev-only shader hot-reload: rebuild the TSL/WGSL material from freshly imported builder code,
   *  swapping it onto the live mesh. Reuses the uploaded volume texture + colormap LUT + live uniforms
   *  (no 64 MiB re-upload, look/pose preserved). Inert in prod — never called there. */
  rebuildShader(build: RaymarchMaterialBuilder): void;
}

const DEFAULT_STEPS = 256; // march / perf-gate depth
const EARLY_ALPHA = 0.98;
// Phong is gated on per-sample opacity `t` (the dt-free form of sampleAlpha): a sample mapping below
// one 8-bit color step can't move the pixel, so it skips the 6 gradient taps — the gate that keeps
// shading off the 8 ms budget.
const SHADE_T_FLOOR = 1 / 255;

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

// The persistent GPU resources + uniforms a raymarch material reads — everything that survives a dev
// shader hot-reload: the uploaded volume texture, the colormap LUT, the window/scale normalization, and
// the live look uniforms. `buildRaymarchMaterial` composes a fresh TSL graph over THIS, so a reload
// rebuilds only the shader, never the upload. The uniforms' inferred proxy types carry the TSL fluent
// API the graph + the scene controller's setters both use.
function buildRaymarchGraph(
  resources: {
    readonly volume: VolumeTexture;
    readonly tf: TransferFunctionTexture;
    readonly norm: Normalization;
  },
  config: {
    readonly steps: number;
    readonly density: number;
    readonly opacity: number;
    readonly shaded: boolean;
    readonly fieldShape: readonly number[];
  },
) {
  const { volume, tf, norm } = resources;
  const uDensity = uniform(config.density);
  const uLayerOpacity = uniform(config.opacity);
  const uShade = uniform(config.shaded ? 1 : 0); // live Phong toggle; 0 ⇒ the gradient taps never run
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
  const voxelStep = vec3(
    1 / (config.fieldShape[0] ?? 1),
    1 / (config.fieldShape[1] ?? 1),
    1 / (config.fieldShape[2] ?? 1),
  );

  return {
    volume,
    tf,
    norm,
    steps: config.steps,
    voxelStep,
    uDensity,
    uLayerOpacity,
    uShade,
    uStepScale,
    uJitter,
    uOrtho,
  };
}

/** The preserved GPU resources + live uniforms `buildRaymarchMaterial` composes its TSL graph over. */
export type RaymarchGraph = ReturnType<typeof buildRaymarchGraph>;

/** Builds the raymarch `NodeMaterial` (TSL/TSL+WGSL graph) over a preserved `RaymarchGraph`. The dev
 *  shader hot-reload re-imports this fresh and applies it to the live graph (see `rebuildShader`). */
export type RaymarchMaterialBuilder = (graph: RaymarchGraph) => NodeMaterial;

/** Compose the single-pass raymarch material from a preserved graph (textures + uniforms). Pure in the
 *  graph — no GPU allocation here, so a dev reload rebuilds it without touching the uploaded volume. */
export const buildRaymarchMaterial: RaymarchMaterialBuilder = (g) => {
  const rgba = Fn(() => {
    // Camera ray in object space; the box is axis-aligned there so the slab test is exact. The box
    // renders BackSide so a fragment is still generated when the camera is inside (front faces clip on
    // the near plane and this fragment program would never run).
    // Perspective: rays fan out from the camera point through each fragment — the origin is the camera,
    // so front-vs-back fragment is the same ray, and the entry clamps to the camera (t ≥ 0).
    // Orthographic: parallel rays along the camera forward (w=0 — rotation only through both matrices),
    // originating on the fragment — now the *back* face — so the march runs the full [entry, exit].
    const perspOrigin = varying(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz);
    const orthoForward = varying(
      modelWorldMatrixInverse.mul(cameraWorldMatrix.mul(vec4(0, 0, -1, 0))).xyz,
    );
    const isOrtho = g.uOrtho.greaterThan(0.5);
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

    // Perspective clamps the entry to the camera (t ≥ 0) so an inside-the-box ray starts at the eye.
    // Ortho's origin is the back-face fragment, so it marches the full interval from the front wall in.
    const tEntry = isOrtho.select(bounds.x, max(bounds.x, 0.0));
    const tExit = bounds.y;
    const liveSteps = ceil(float(g.steps).mul(g.uStepScale)).max(1.0).toVar();
    const dt = tExit.sub(tEntry).div(liveSteps).toVar(); // fine step; the lattice is tStart + k·dt
    // Interleaved gradient noise (Jimenez 2014): a per-pixel march phase that turns the coarse
    // march's onion-shell banding into unstructured noise. uJitter is 0 at full quality, so
    // tStart ≡ tEntry there and the settled frame is bit-identical to the fixed lattice.
    const ign = fract(
      float(52.9829189).mul(
        fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715))),
      ),
    );
    const tStart = tEntry.add(dt.mul(ign).mul(g.uJitter)).toVar();
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
      const raw = g.volume.node.sample(p.zyx).r;
      return raw.abs().lessThan(float(1e30)).select(raw, float(0));
    };

    // One front-to-back emission-absorption sample at a texture-space position. Object [-0.5,0.5]³ →
    // texture [0,1]³; texture axes are the reverse of field axes (volumeTexture C-order: object
    // x/y/z ↔ field axis 2/1/0).
    const accumulate = (texPos: Node<"vec3">): void => {
      const t = g.norm.toT(sampleRawAt(texPos));
      // Opacity stays value-proportional (t·density); the LUT alpha channel is reserved for the
      // opacity transfer function, so color comes from the LUT but opacity doesn't.
      const sampleAlpha = t.mul(g.uDensity).mul(dt).saturate();
      const weight = accumAlpha.oneMinus(); // front-to-back: (1 - accumulated)
      const rgb = texture(g.tf.texture, vec2(t, 0.5)).rgb.toVar();

      // Phong (opt-in via uShade): a render-local lighting normal from the field gradient. Gated on
      // uShade AND a contributing opacity `t` so transparent samples skip the 6 gradient taps
      // (shading.ts is the pure twin of this math).
      If(g.uShade.greaterThan(0.5).and(t.greaterThan(SHADE_T_FLOOR)), () => {
        const dx = vec3(g.voxelStep.x, 0, 0);
        const dy = vec3(0, g.voxelStep.y, 0);
        const dz = vec3(0, 0, g.voxelStep.z);
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

    // `pos` steps `liveSteps` times by `dt` from entry to exit. An integer counter always terminates,
    // unlike a float `for(i=entry; i<exit; i+=dt)` which can stall when dt falls below the float ULP at
    // entry's world-distance magnitude — a GPU hang → device loss. The WGSL bound stays the literal
    // `steps`; the counter Breaks at the uniform-driven live count.
    const pos = rayOrigin.add(tStart.mul(rayDir)).toVar();
    const stepIndex = float(0).toVar();
    Loop(g.steps, () => {
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

    // accumColor is premultiplied (Σ color·α·weight); un-premultiply so the default normal
    // blend (src·α + dst·(1−α)) composites it correctly over the cleared background. The
    // per-layer opacity scales the whole layer's emitted alpha — a uniform composite fade.
    return vec4(accumColor.div(max(accumAlpha, 1e-4)), accumAlpha.mul(g.uLayerOpacity));
    // One shared temp: colorNode/opacityNode read .rgb/.a from it, so the march runs once.
  })().toVar();

  const material = new NodeMaterial();
  material.colorNode = rgba.rgb;
  material.opacityNode = rgba.a;
  material.transparent = true;
  material.depthWrite = false;
  // BackSide so the box still rasterizes a fragment when the camera is inside the volume — front faces
  // clip on the near plane and the raymarch (a fragment program) would never run. Outside, the ray is
  // camera-origin + direction, identical to FrontSide per pixel; only the spawning face differs.
  material.side = BackSide;
  return material;
};

/** Build a themed single-pass raymarch scene from a 3D scalar field. */
export function createRaymarchScene(options: RaymarchSceneOptions): RaymarchScene {
  const volume = createVolumeTexture(
    options.field,
    options.hasFloat32Filterable,
    options.ledgerKey,
  );
  const tf = createTransferFunctionTexture(options.colormap);
  const steps = options.steps ?? DEFAULT_STEPS;

  // Default window spans the full finite range, reproducing the old (v−min)/(max−min) map.
  const norm = createNormalization(volume.min, volume.max, options.windowLevel, options.scale);
  const graph = buildRaymarchGraph(
    { volume, tf, norm },
    {
      steps,
      density: options.density ?? 1,
      opacity: options.opacity ?? 1,
      shaded: options.shaded ?? false,
      fieldShape: options.field.shape,
    },
  );

  let material = buildRaymarchMaterial(graph);
  const geometry = new BoxGeometry(1, 1, 1);
  const mesh = new Mesh(geometry, material);
  // Object space stays the unit box [-0.5,0.5]³ (the raymarch clips + samples there); a non-uniform
  // model scale stretches it to the dataset's physical aspect in world space. Cubic → (1,1,1), so the
  // flux rope is byte-identical. (Phong normals skew slightly under non-uniform scale — shading is
  // already non-quantitative + default-off, so this is acceptable.)
  const half = options.worldHalfExtent ?? UNIT_BOX_HALF_EXTENT;
  mesh.scale.set(2 * half[0], 2 * half[1], 2 * half[2]);

  // No scene.background — the renderer owns the clear color so layers composite over one
  // background (a per-scene Color background would force a clear and wipe earlier layers).
  const scene = new Scene();
  scene.add(mesh);

  return {
    scene,
    setWindowLevel: graph.norm.setWindow,
    setColormap: graph.tf.setColormap,
    setScale: graph.norm.setScale,
    setShading(enabled) {
      graph.uShade.value = enabled ? 1 : 0;
    },
    setOpacity(opacity) {
      graph.uLayerOpacity.value = opacity;
    },
    setStepScale(scale) {
      const clamped = clamp(scale, 0.05, 1);
      graph.uStepScale.value = clamped;
      graph.uJitter.value = clamped < 1 ? 1 : 0; // jitter only the coarse march (see uJitter)
    },
    setField: (field) => graph.volume.setField(field),
    setProjection(orthographic) {
      graph.uOrtho.value = orthographic ? 1 : 0;
    },
    rebuildShader(build) {
      // Dev shader hot-reload: compose a fresh material over the SAME preserved graph (uploaded volume
      // texture + colormap LUT + live uniforms) and swap it onto the live mesh — the edited WGSL/TSL
      // re-renders with no 64 MiB re-upload, and the look/geometry/pose carry over. Dispose the old
      // material only (its pipeline); the textures it referenced are the graph's, not freed here.
      const next = build(graph);
      mesh.material = next;
      material.dispose();
      material = next;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      volume.dispose();
      tf.dispose();
    },
  };
}

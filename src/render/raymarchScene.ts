import { BoxGeometry, Color, FrontSide, Mesh, Scene } from "three";
import {
  Break,
  cameraPosition,
  Fn,
  float,
  If,
  Loop,
  max,
  modelWorldMatrixInverse,
  positionGeometry,
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
import { BACKGROUND_COLOR } from "./constants.ts";
import { createNormalization, type WindowLevel } from "./normalization.ts";
import { createTransferFunctionTexture } from "./transferFunction.ts";
import { createVolumeTexture, type ScalarField } from "./volumeTexture.ts";

// Single-pass volume raymarcher over the shared `uVolume`. The analytic ray-box clip is
// `wgslFn hitBox` — the WGSL twin of rayBox.ts.

export interface RaymarchSceneOptions {
  readonly field: ScalarField;
  /** Theme colormap name (`theme.colormaps.sequential`); unknown → inferno. */
  readonly colormap: string;
  /** Value→color window; absent → the field's full finite range (identity normalization). */
  readonly windowLevel?: WindowLevel;
  /** Fixed samples per ray across the clipped segment. */
  readonly steps?: number;
  /** Opacity scale for the emission-absorption transfer. */
  readonly density?: number;
  readonly background?: number;
}

export interface RaymarchScene {
  readonly scene: Scene;
  /** Update the value→color window in place (no texture re-upload). */
  setWindowLevel(center: number, width: number): void;
  dispose(): void;
}

const DEFAULT_STEPS = 256; // perf-gate depth; mipmap empty-space skipping comes later
const EARLY_ALPHA = 0.98;

// Object space is the unit box [-0.5, 0.5]³ (BoxGeometry centered at origin); texture coords
// are `pos + 0.5`. Branch-free `1/dir` slab — valid for camera rays (no zero component).
const hitBox = wgslFn<{ orig: Node; dir: Node }>(`
  fn hitBox( orig: vec3<f32>, dir: vec3<f32> ) -> vec2<f32> {
    let box_min = vec3<f32>( -0.5 );
    let box_max = vec3<f32>(  0.5 );
    let inv_dir = 1.0 / dir;
    let tmin_tmp = ( box_min - orig ) * inv_dir;
    let tmax_tmp = ( box_max - orig ) * inv_dir;
    let tmn = min( tmin_tmp, tmax_tmp );
    let tmx = max( tmin_tmp, tmax_tmp );
    let t0 = max( tmn.x, max( tmn.y, tmn.z ) );
    let t1 = min( tmx.x, min( tmx.y, tmx.z ) );
    return vec2<f32>( t0, t1 );
  }
`);

/** Build a themed single-pass raymarch scene from a 3D scalar field. */
export function createRaymarchScene(opts: RaymarchSceneOptions): RaymarchScene {
  const volume = createVolumeTexture(opts.field);
  const tf = createTransferFunctionTexture(opts.colormap);
  const steps = opts.steps ?? DEFAULT_STEPS;

  // Default window spans the full finite range, reproducing the old (v−min)/(max−min) map.
  const norm = createNormalization(volume.min, volume.max, opts.windowLevel);
  const uDensity = uniform(opts.density ?? 1);

  const rgba = Fn(() => {
    // Camera ray in object space; the box is axis-aligned there so the slab test is exact.
    const rayOrigin = varying(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz);
    const rayDir = positionGeometry.sub(rayOrigin).normalize();

    // wgslFn returns an untyped `Node`; the WGSL signature returns vec2<f32> (entry, exit).
    const bounds = (hitBox({ orig: rayOrigin, dir: rayDir }) as Node<"vec2">).toVar();
    bounds.x.greaterThan(bounds.y).discard(); // ray misses the box
    bounds.assign(vec2(max(bounds.x, 0.0), bounds.y)); // clamp entry to the camera

    const dt = bounds.y.sub(bounds.x).div(steps).toVar();
    const pos = rayOrigin.add(bounds.x.mul(rayDir)).toVar();
    const accumColor = vec3(0).toVar();
    const accumAlpha = float(0).toVar();

    Loop({ type: "float", start: bounds.x, end: bounds.y, update: dt }, () => {
      // Object [-0.5,0.5]³ → texture [0,1]³. Texture axes are the reverse of field axes
      // (volumeTexture C-order): object x/y/z ↔ field axis 2/1/0 — the same reversal sliceScene maps.
      const sample = texture3D(volume.texture, pos.add(0.5)).r;
      const t = norm.toT(sample);
      // Opacity stays value-proportional (t·density); the LUT alpha channel is reserved
      // for the opacity transfer function, so color comes from the LUT but opacity doesn't.
      const sampleAlpha = t.mul(uDensity).mul(dt).saturate();
      const weight = accumAlpha.oneMinus(); // front-to-back: (1 - accumulated)
      const rgb = texture(tf.texture, vec2(t, 0.5)).rgb;
      accumColor.addAssign(rgb.mul(sampleAlpha).mul(weight));
      accumAlpha.addAssign(sampleAlpha.mul(weight));
      If(accumAlpha.greaterThanEqual(EARLY_ALPHA), () => {
        Break(); // opaque enough — remaining samples can't change the pixel
      });
      pos.addAssign(rayDir.mul(dt));
    });

    // accumColor is premultiplied (Σ color·α·weight); un-premultiply so the default normal
    // blend (src·α + dst·(1−α)) composites it correctly over the cleared background.
    return vec4(accumColor.div(max(accumAlpha, 1e-4)), accumAlpha);
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

  const scene = new Scene();
  scene.background = new Color(opts.background ?? BACKGROUND_COLOR);
  scene.add(mesh);

  return {
    scene,
    setWindowLevel: norm.setWindow,
    dispose() {
      geometry.dispose();
      material.dispose();
      volume.dispose();
      tf.dispose();
    },
  };
}

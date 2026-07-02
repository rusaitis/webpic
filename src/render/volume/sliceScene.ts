import type { ColorScale } from "@schema/colormap.ts";
import { Mesh, PlaneGeometry, Scene } from "three";
import { texture, uniform, uv, vec2, vec3 } from "three/tsl";
import { type Node, NodeMaterial } from "three/webgpu";
import type { LayerScene } from "../layerScene.ts";
import { createNormalization, type WindowLevel } from "./normalization.ts";
import { createTransferFunctionTexture } from "./transferFunction.ts";
import { createVolumeTexture, type ScalarField } from "./volumeTexture.ts";

// One orthogonal slice sampling the shared `uVolume` 3D texture (the raymarcher and further
// slices sample the same texture).

export type SliceAxis = "x" | "y" | "z";

export interface SliceSceneOptions {
  readonly field: ScalarField;
  /** Theme colormap name (`theme.colormaps.sequential`); unknown → inferno. */
  readonly colormap: string;
  /** Field axis held fixed by the slice plane. */
  readonly axis: SliceAxis;
  /** Position along the fixed axis, in [0,1]. */
  readonly position: number;
  /** Value→color window; absent → the field's full finite range (identity normalization). */
  readonly windowLevel?: WindowLevel;
  /** Value→color scale within the window; default linear. */
  readonly scale?: ColorScale;
  /** Per-layer opacity multiplier on the composited output, [0,1]; default 1 (opaque). */
  readonly opacity?: number;
  /** Device supports R32F linear sampling — picks the volume texture format. */
  readonly float32Filterable?: boolean;
  /** Layer id keying the volume texture into the VRAM ledger (perf HUD); omit to skip tracking. */
  readonly ledgerKey?: string;
}

// A slice adds only `setPosition` to the base LayerScene — the plane position is a live uniform (the
// drag hot path). No march to scale, no normal to light, no projection flip; the held axis is baked
// into the TSL graph, so an axis change is a registry-side rebuild, not a method here.
export type SliceScene = LayerScene & {
  /** Slide the plane along the held axis in place (uniform only, no rebuild), [0, 1]. */
  setPosition(position: number): void;
};

// Plane uv (a,b) spans the two free axes; `position` fixes the third. Texture coords
// (x,y,z) = field (axis2, axis1, axis0) — the reverse of axisLabels (createVolumeTexture) —
// so the held axis lands on the reversed texture component.
function sliceCoord(
  axis: SliceAxis,
  a: Node<"float">,
  b: Node<"float">,
  position: Node<"float">,
): Node<"vec3"> {
  switch (axis) {
    case "x": // hold field axis 0 → texture z
      return vec3(a, b, position);
    case "y": // hold field axis 1 → texture y
      return vec3(a, position, b);
    case "z": // hold field axis 2 → texture x
      return vec3(position, b, a);
  }
}

/** Build a themed orthogonal-slice scene from a 3D scalar field. */
export function createSliceScene(opts: SliceSceneOptions): SliceScene {
  const volume = createVolumeTexture(opts.field, opts.float32Filterable, opts.ledgerKey);
  const tf = createTransferFunctionTexture(opts.colormap);

  // Default window spans the full finite range, reproducing the old (v−min)/(max−min) map.
  const norm = createNormalization(volume.min, volume.max, opts.windowLevel, opts.scale);
  const uPosition = uniform(opts.position);
  const uLayerOpacity = uniform(opts.opacity ?? 1);

  const coord = sliceCoord(opts.axis, uv().x, uv().y, uPosition);
  const raw = volume.node.sample(coord).r; // swappable node so a streamed step re-binds the sample
  const t = norm.toT(raw);

  const material = new NodeMaterial();
  material.colorNode = texture(tf.texture, vec2(t, 0.5)).rgb;
  // Explicit opacityNode + always-transparent: lets per-layer opacity ride a uniform (no runtime
  // `transparent` toggle / pipeline recompile). At opacity 1 over an opaque cleared background the
  // composite is identical to the old opaque quad.
  material.opacityNode = uLayerOpacity;
  material.transparent = true;

  const geometry = new PlaneGeometry(2, 2);
  const mesh = new Mesh(geometry, material);

  // No scene.background — the renderer owns the clear color so layers composite over one
  // background (a per-scene Color background would force a clear and wipe earlier layers).
  const scene = new Scene();
  scene.add(mesh);

  return {
    scene,
    setWindowLevel: norm.setWindow,
    setColormap: tf.setColormap,
    setScale: norm.setScale,
    setOpacity(opacity) {
      uLayerOpacity.value = opacity;
    },
    setPosition(position) {
      uPosition.value = position;
    },
    setField(field) {
      return volume.setField(field);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      volume.dispose();
      tf.dispose();
    },
  };
}

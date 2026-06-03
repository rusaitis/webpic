import { Color, Mesh, PlaneGeometry, Scene } from "three";
import { texture, texture3D, uniform, uv, vec2, vec3 } from "three/tsl";
import { type Node, NodeMaterial } from "three/webgpu";
import { BACKGROUND_COLOR } from "./constants.ts";
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
  readonly background?: number;
}

export interface SliceScene {
  readonly scene: Scene;
  /** Update the value→color window in place (no texture re-upload). */
  setWindowLevel(center: number, width: number): void;
  dispose(): void;
}

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
  const volume = createVolumeTexture(opts.field);
  const tf = createTransferFunctionTexture(opts.colormap);

  // Default window spans the full finite range, reproducing the old (v−min)/(max−min) map.
  const norm = createNormalization(volume.min, volume.max, opts.windowLevel);
  const uPosition = uniform(opts.position);

  const coord = sliceCoord(opts.axis, uv().x, uv().y, uPosition);
  const raw = texture3D(volume.texture, coord).r;
  const t = norm.toT(raw);

  const material = new NodeMaterial();
  material.colorNode = texture(tf.texture, vec2(t, 0.5)).rgb;

  const geometry = new PlaneGeometry(2, 2);
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

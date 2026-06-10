import { cssRgba, type Rgba01 } from "@schema/theme.ts";
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  LinearFilter,
  LineSegments,
  type Material,
  Scene,
  Sprite,
  type Texture,
} from "three";
import { cameraPosition, positionWorld, texture, uv, vec3 } from "three/tsl";
import { LineBasicNodeMaterial, type Node, SpriteNodeMaterial } from "three/webgpu";
import type { SceneOverlayConfig } from "../messages.ts";
import { niceTicks } from "./niceTicks.ts";
import { fieldAxisToThree, formatTick, physicalToObject } from "./overlayRemap.ts";

// The themeable 3D axes + equatorial grid overlay scene. Composited last with the perspective camera
// (the worker), so it blends on top of the volume. Built once per setSceneOverlay (never per frame):
// batched LineSegments for the grid + axes (one geometry per material — never one Line per gridline),
// and auto-billboarding Sprites for the labels (SpriteNodeMaterial faces the camera in the renderer,
// so no per-frame reorient). Returns a disposer that frees every geometry, material, and CanvasTexture.

export interface SceneOverlay {
  readonly scene: Scene;
  dispose(): void;
}

// Object-space label placement (the box spans [-0.5, 0.5]³). Tick labels sit just outside the grid's
// edge; axis-name labels just past the axis tip. World height fixes the on-screen label scale.
const LABEL_WORLD_HEIGHT = 0.05;
const LABEL_EDGE_OFFSET = 0.04;
const LABEL_AXIS_OFFSET = 0.07;
const LABEL_FONT_PX = 30; // supersampled (×SS) for crisp text at this world size
const LABEL_SUPERSAMPLE = 2;
const LABEL_FONT = (px: number): string => `600 ${px}px "Helvetica Neue", Arial, sans-serif`;

// Labels along an axis pile up unreadably once that axis points nearly at the camera (every tick
// projects to the same spot). Fade them with the view angle: full opacity beyond 35° off the row
// axis, gone within 15°. Per-fragment from the sprite's own view ray (not the camera forward), so
// panned / cursor-anchored views fade correctly — and no per-pose CPU update is needed. The band
// is wide because the near end of an edge-on row still sits ~13° off-axis (edge offset / distance)
// — a narrower band leaves that end ghosting; the default 3/4 view's rows are ~51° off, untouched.
const LABEL_FADE_START_COS = Math.cos((35 * Math.PI) / 180);
const LABEL_FADE_FULL_COS = Math.cos((15 * Math.PI) / 180);

function edgeOnFade(axis: number): Node<"float"> {
  const rowDir = vec3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  const edgeOn = positionWorld.sub(cameraPosition).normalize().dot(rowDir).abs();
  return edgeOn.smoothstep(LABEL_FADE_START_COS, LABEL_FADE_FULL_COS).oneMinus();
}

// THREE-axis triplet for each drawable plane: the two in-plane axes (a, b) and the held out-of-plane
// axis (h). Under z-up the horizontal/equatorial plane is xy (z held); the default-on plane lives in
// store/overlay.ts.
const PLANES = [
  { key: "xy", a: 0, b: 1, h: 2 },
  { key: "yz", a: 1, b: 2, h: 0 },
  { key: "xz", a: 0, b: 2, h: 1 },
] as const;

type ThreeAxisData = {
  readonly ticks: readonly { obj: number; value: number }[];
  readonly decimals: number;
  readonly label: string;
};

function lineMaterial(color: Rgba01, opacity: number): LineBasicNodeMaterial {
  return new LineBasicNodeMaterial({
    color: new Color(color[0], color[1], color[2]),
    transparent: true,
    opacity: color[3] * opacity,
    depthWrite: false,
  });
}

// Render `text` to an OffscreenCanvas (no `document` in the worker) and wrap it as a CanvasTexture.
// Returns null if a 2D context is unavailable — a missing label beats a dead worker.
function makeLabelTexture(
  text: string,
  color: Rgba01,
): { texture: Texture; aspect: number } | null {
  if (typeof OffscreenCanvas === "undefined") return null; // unsupported env (e.g. node tests) → no label
  const px = LABEL_FONT_PX * LABEL_SUPERSAMPLE;
  const probe = new OffscreenCanvas(4, 4).getContext("2d");
  if (probe === null) return null;
  probe.font = LABEL_FONT(px);
  const padX = 6 * LABEL_SUPERSAMPLE;
  const padY = 4 * LABEL_SUPERSAMPLE;
  const width = Math.ceil(probe.measureText(text).width) + 2 * padX;
  const height = px + 2 * padY;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.font = LABEL_FONT(px);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = cssRgba(color);
  ctx.fillText(text, width / 2, height / 2);

  const tex = new CanvasTexture(canvas);
  // Default flipY upload: it compensated the present-quad's vertical flip while that bug lived
  // (renderer.ts); with the present path upright, the GL-convention default reads correctly.
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  return { texture: tex, aspect: width / height };
}

export function createSceneOverlay(config: SceneOverlayConfig): SceneOverlay {
  const scene = new Scene(); // no background — the renderer owns the clear color
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];

  // Major-tick lattice per THREE axis (over the mapped field axis's physical bounds).
  const axisData: readonly ThreeAxisData[] = [0, 1, 2].map((threeAxis) => {
    const axis = config.axes[fieldAxisToThree(threeAxis as 0 | 1 | 2)];
    const [min, max] = axis.bounds;
    const nt = niceTicks(min, max, config.tick.targetCount);
    return {
      ticks: nt.ticks.map((value) => ({ obj: physicalToObject(value, min, max), value })),
      decimals: nt.decimals,
      label: axis.label,
    };
  });

  const heldValue =
    config.planePosition === "center" ? 0 : config.planePosition === "min" ? -0.5 : 0.5;

  // `fadeAxis` is the THREE axis the label's row runs along (its tick axis, or the named axis
  // itself) — the label fades as that direction goes edge-on to the view.
  const addLabel = (
    text: string,
    position: readonly [number, number, number],
    fadeAxis: number,
  ): void => {
    if (text.length === 0) return;
    const made = makeLabelTexture(text, config.labelColor);
    if (made === null) return;
    const sampled = texture(made.texture, uv());
    const material = new SpriteNodeMaterial();
    material.colorNode = sampled.rgb;
    material.opacityNode = sampled.a.mul(edgeOnFade(fadeAxis));
    material.transparent = true;
    material.depthWrite = false;
    material.alphaTest = 0.01;
    const sprite = new Sprite(material);
    sprite.position.set(position[0], position[1], position[2]);
    sprite.scale.set(LABEL_WORLD_HEIGHT * made.aspect, LABEL_WORLD_HEIGHT, 1);
    scene.add(sprite);
    materials.push(material);
    textures.push(made.texture);
  };

  // Grid planes — one batched LineSegments per enabled plane, shared major material.
  const gridMaterial = config.show.grid
    ? lineMaterial(config.grid.color, config.grid.majorOpacity)
    : undefined;
  if (gridMaterial !== undefined) materials.push(gridMaterial);

  if (config.show.grid && gridMaterial !== undefined) {
    for (const plane of PLANES) {
      if (!config.planes[plane.key]) continue;
      const ticksA = axisData[plane.a]?.ticks ?? [];
      const ticksB = axisData[plane.b]?.ticks ?? [];
      const lineCount = ticksA.length + ticksB.length;
      if (lineCount === 0) continue;

      const positions = new Float32Array(lineCount * 6);
      const p0: [number, number, number] = [0, 0, 0];
      const p1: [number, number, number] = [0, 0, 0];
      let o = 0;
      // Lines parallel to axis b, one per tick on axis a (and vice versa).
      for (const t of ticksA) {
        p0[plane.a] = t.obj;
        p0[plane.b] = -0.5;
        p0[plane.h] = heldValue;
        p1[plane.a] = t.obj;
        p1[plane.b] = 0.5;
        p1[plane.h] = heldValue;
        positions.set(p0, o);
        positions.set(p1, o + 3);
        o += 6;
      }
      for (const t of ticksB) {
        p0[plane.b] = t.obj;
        p0[plane.a] = -0.5;
        p0[plane.h] = heldValue;
        p1[plane.b] = t.obj;
        p1[plane.a] = 0.5;
        p1[plane.h] = heldValue;
        positions.set(p0, o);
        positions.set(p1, o + 3);
        o += 6;
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(positions, 3));
      scene.add(new LineSegments(geometry, gridMaterial));
      geometries.push(geometry);

      // Tick-value labels along each in-plane edge, in the grid plane (billboarded). Each row fades
      // by its own tick axis — the direction the row of labels runs along.
      if (config.show.labels) {
        for (const t of ticksA) {
          const pos: [number, number, number] = [0, 0, 0];
          pos[plane.a] = t.obj;
          pos[plane.b] = -0.5 - LABEL_EDGE_OFFSET;
          pos[plane.h] = heldValue;
          addLabel(formatTick(t.value, axisData[plane.a]?.decimals ?? 0), pos, plane.a);
        }
        for (const t of ticksB) {
          const pos: [number, number, number] = [0, 0, 0];
          pos[plane.b] = t.obj;
          pos[plane.a] = -0.5 - LABEL_EDGE_OFFSET;
          pos[plane.h] = heldValue;
          addLabel(formatTick(t.value, axisData[plane.b]?.decimals ?? 0), pos, plane.b);
        }
      }
    }
  }

  // Axis lines from the lower corner outward, colored by THREE axis (gnomon palette) + name labels.
  if (config.show.axes) {
    const axisColors: readonly Rgba01[] = [
      config.axisColors.x,
      config.axisColors.y,
      config.axisColors.z,
    ];
    for (let axis = 0; axis < 3; axis++) {
      const start: [number, number, number] = [-0.5, -0.5, -0.5];
      const end: [number, number, number] = [-0.5, -0.5, -0.5];
      end[axis] = 0.5;
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        "position",
        new BufferAttribute(new Float32Array([...start, ...end]), 3),
      );
      const material = lineMaterial(axisColors[axis] ?? [1, 1, 1, 1], 1);
      scene.add(new LineSegments(geometry, material));
      geometries.push(geometry);
      materials.push(material);

      if (config.show.labels) {
        const pos: [number, number, number] = [-0.5, -0.5, -0.5];
        pos[axis] = 0.5 + LABEL_AXIS_OFFSET;
        // The name label fades with its own axis — pointing at the camera it floats mid-screen
        // over the data (and over its ticks' pile point), telling the viewer nothing.
        addLabel(axisData[axis]?.label ?? "", pos, axis);
      }
    }
  }

  return {
    scene,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const tex of textures) tex.dispose();
    },
  };
}

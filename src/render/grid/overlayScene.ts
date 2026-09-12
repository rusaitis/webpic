import { clamp, UNIT_BOX_HALF_EXTENT } from "@schema/math.ts";
import { cssRgba, type Rgba01 } from "@schema/theme.ts";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LineSegments,
  type Material,
  Scene,
  Sprite,
  type Texture,
} from "three";
import { cameraPosition, positionWorld, texture, uv, vec3 } from "three/tsl";
import { LineBasicNodeMaterial, type Node, SpriteNodeMaterial } from "three/webgpu";
import { finishCanvasTexture } from "../canvasTexture.ts";
import type { SceneOverlayConfig } from "../messages.ts";
import { niceStep, ticksForStep } from "./niceTicks.ts";
import {
  formatTick,
  LABEL_FADE_FULL_COS,
  LABEL_FADE_START_COS,
  physicalToObject,
  type ThreeAxis,
} from "./overlayRemap.ts";

// The themeable 3D axes + equatorial grid overlay scene. Composited last with the perspective camera
// (the worker), so it blends on top of the volume. Built once per setSceneOverlay (never per frame):
// batched LineSegments for the grid + axes (one geometry per material — never one Line per gridline),
// and auto-billboarding Sprites for the labels (SpriteNodeMaterial faces the camera in the renderer,
// so no per-frame reorient). Returns a disposer that frees every geometry, material, and CanvasTexture.

export interface SceneOverlay {
  readonly scene: Scene;
  dispose(): void;
}

// Object-space label placement (the box spans [-0.5, 0.5]³). Grid lines overhang the labeled edge
// by a short foot; tick labels sit past the foot with a clear gap;
// axis-name labels just past the axis tip. World height fixes the on-screen label scale.
const GRID_LINE_FOOT = 0.03;
const LABEL_EDGE_OFFSET = 0.08;
const LABEL_AXIS_OFFSET = 0.07;
const LABEL_FONT_PX = 30; // supersampled (×SS) for crisp text at this world size
const LABEL_SUPERSAMPLE = 2;
const LABEL_FONT = (px: number, weight: number): string =>
  `${weight} ${px}px "Helvetica Neue", Arial, sans-serif`;

// Tick labels are quiet annotations (thin, smaller, faded); axis names stay assertive.
type LabelStyle = { readonly weight: number; readonly height: number; readonly alpha: number };
const TICK_LABEL: LabelStyle = { weight: 400, height: 0.042, alpha: 0.7 };
const NAME_LABEL: LabelStyle = { weight: 600, height: 0.05, alpha: 1 };

// Labels along an axis pile up unreadably once that axis points nearly at the camera (every tick
// projects to the same spot) — fade per-fragment from the sprite's own view ray (not the camera
// forward), so panned / cursor-anchored views fade correctly and no per-pose CPU update is needed.
// Band constants + the pure fade twin live in overlayRemap.ts (Node-tested; GPU can't drift).
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

const THREE_AXES: readonly ThreeAxis[] = [0, 1, 2];

// One major tick: its object-space coordinate and the physical value it labels.
type AxisTick = { readonly obj: number; readonly value: number };

type ThreeAxisData = {
  readonly ticks: readonly AxisTick[];
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
  style: LabelStyle,
): { texture: Texture; aspect: number } | null {
  if (typeof OffscreenCanvas === "undefined") return null; // unsupported env (e.g. node tests) → no label
  const px = LABEL_FONT_PX * LABEL_SUPERSAMPLE;
  const probe = new OffscreenCanvas(4, 4).getContext("2d");
  if (probe === null) return null;
  probe.font = LABEL_FONT(px, style.weight);
  const padX = 6 * LABEL_SUPERSAMPLE;
  const padY = 4 * LABEL_SUPERSAMPLE;
  const width = Math.ceil(probe.measureText(text).width) + 2 * padX;
  const height = px + 2 * padY;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.font = LABEL_FONT(px, style.weight);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = cssRgba([color[0], color[1], color[2], color[3] * style.alpha]);
  ctx.fillText(text, width / 2, height / 2);

  return { texture: finishCanvasTexture(canvas), aspect: width / height };
}

export function createSceneOverlay(config: SceneOverlayConfig): SceneOverlay {
  const scene = new Scene(); // no background — the renderer owns the clear color
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];

  const half = config.worldHalfExtent ?? UNIT_BOX_HALF_EXTENT;
  const halfAt = (axis: number): number => (axis === 0 ? half[0] : axis === 1 ? half[1] : half[2]);
  // The held (out-of-plane) axis position for a plane — center → 0, min/max → the box face ∓/±half.
  const heldFor = (heldAxis: number): number =>
    config.planePosition === "center"
      ? 0
      : config.planePosition === "min"
        ? -halfAt(heldAxis)
        : halfAt(heldAxis);

  // One physical step shared across all axes → uniform world grid spacing. The volume renders at true
  // physical aspect (worldHalfExtent ∝ span), so equal physical steps map to equal world distances;
  // per-axis niceTicks would instead pick a coarser step on the wider axis (dipole x vs y). Base the
  // step on the widest span so the longest axis lands ~targetCount divisions, shorter ones fewer.
  const spans = THREE_AXES.map((threeAxis) => {
    const [min, max] = config.axes[threeAxis].bounds;
    return Math.abs(max - min);
  });
  const commonStep = niceStep(Math.max(...spans), config.tick.targetCount);

  // Major-tick lattice per THREE axis (the shared step over the mapped field axis's physical bounds).
  const axisData: readonly ThreeAxisData[] = THREE_AXES.map((threeAxis) => {
    const axis = config.axes[threeAxis];
    const [min, max] = axis.bounds;
    const nt = ticksForStep(min, max, commonStep);
    return {
      ticks: nt.ticks.map((value) => ({
        obj: physicalToObject(value, min, max, halfAt(threeAxis)),
        value,
      })),
      decimals: nt.decimals,
      label: axis.label,
    };
  });

  // `fadeAxis` is the THREE axis the label's row runs along (its tick axis, or the named axis
  // itself) — the label fades as that direction goes edge-on to the view.
  const addLabel = (
    text: string,
    position: readonly [number, number, number],
    fadeAxis: number,
    style: LabelStyle,
  ): void => {
    if (text.length === 0) return;
    const made = makeLabelTexture(text, config.labelColor, style);
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
    sprite.scale.set(style.height * made.aspect, style.height, 1);
    scene.add(sprite);
    materials.push(material);
    textures.push(made.texture);
  };

  // Grid planes — one batched LineSegments per enabled plane, shared major material.
  if (config.show.grid) {
    const gridMaterial = lineMaterial(config.grid.color, config.grid.majorOpacity);
    materials.push(gridMaterial);
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
      const held = heldFor(plane.h);
      // Lines parallel to `across`, one per tick on `along`. Each overhangs its labeled edge (the
      // -half side) by the foot, pointing at its tick label. Run once per in-plane axis pair.
      const emitGridLines = (ticks: readonly AxisTick[], along: number, across: number): void => {
        for (const t of ticks) {
          p0[along] = t.obj;
          p0[across] = -halfAt(across) - GRID_LINE_FOOT;
          p0[plane.h] = held;
          p1[along] = t.obj;
          p1[across] = halfAt(across);
          p1[plane.h] = held;
          positions.set(p0, o);
          positions.set(p1, o + 3);
          o += 6;
        }
      };
      emitGridLines(ticksA, plane.a, plane.b);
      emitGridLines(ticksB, plane.b, plane.a);
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(positions, 3));
      scene.add(new LineSegments(geometry, gridMaterial));
      geometries.push(geometry);

      // Tick-value labels along each in-plane edge, in the grid plane (billboarded). Each row fades
      // by its own tick axis — the direction the row of labels runs along.
      if (config.show.labels) {
        const emitTickLabels = (
          ticks: readonly AxisTick[],
          along: number,
          across: number,
        ): void => {
          for (const t of ticks) {
            const pos: [number, number, number] = [0, 0, 0];
            pos[along] = t.obj;
            pos[across] = -halfAt(across) - LABEL_EDGE_OFFSET;
            pos[plane.h] = held;
            addLabel(formatTick(t.value, axisData[along]?.decimals ?? 0), pos, along, TICK_LABEL);
          }
        };
        emitTickLabels(ticksA, plane.a, plane.b);
        emitTickLabels(ticksB, plane.b, plane.a);
      }
    }
  }

  // Axis lines from the data origin (0,0,0) outward to the +face, colored by THREE axis (gnomon
  // palette) + name labels, so the triad meets at the data origin (interior for the
  // dipole), not the box corner. The cross clamps to the nearest face when 0 is outside the bounds.
  if (config.show.axes) {
    const axisColors: readonly Rgba01[] = [
      config.axisColors.x,
      config.axisColors.y,
      config.axisColors.z,
    ];
    const originAt = (a: ThreeAxis): number => {
      const [min, max] = config.axes[a].bounds;
      const h = halfAt(a);
      return clamp(physicalToObject(0, min, max, h), -h, h);
    };
    const cross: [number, number, number] = [originAt(0), originAt(1), originAt(2)];
    for (let axis = 0; axis < 3; axis++) {
      const start: [number, number, number] = [cross[0], cross[1], cross[2]];
      const end: [number, number, number] = [cross[0], cross[1], cross[2]];
      end[axis] = halfAt(axis);
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
        const pos: [number, number, number] = [cross[0], cross[1], cross[2]];
        pos[axis] = halfAt(axis) + LABEL_AXIS_OFFSET;
        // The name label fades with its own axis — pointing at the camera it floats mid-screen
        // over the data (and over its ticks' pile point), telling the viewer nothing.
        addLabel(axisData[axis]?.label ?? "", pos, axis, NAME_LABEL);
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

import { releaseAlloc, trackAlloc } from "@gpu/vramLedger.ts";
import type { Rgba01 } from "@schema/theme.ts";
import { Color, Scene } from "three";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineSegments2 } from "three/examples/jsm/lines/webgpu/LineSegments2.js";
import { Line2NodeMaterial } from "three/webgpu";
import { packSegments } from "./segmentPack.ts";

// One batched fat-line scene for a whole field-line set: every traced polyline becomes segments in a
// single `LineSegments2` (instanced quads) — one geometry, one material, one draw call, uploaded once
// and GPU-resident. No per-frame readback (the streamline buffers reach here as a one-time transfer,
// not a re-read each frame). `Line2NodeMaterial` is the WebGPU/TSL fat line; it reads the viewport size
// through TSL, so screen-space width needs no resolution plumbing. (The classic `LineMaterial` is raw
// GLSL — incompatible with WebGPURenderer.) v0.1 colors lines solid; color-by-scalar is deferred.

export interface FieldlinesSceneOptions {
  /** Flat world-space xyz for every vertex of every line, concatenated in line order. */
  readonly positions: Float32Array;
  /** Vertex count per line (partitions `positions`). */
  readonly counts: Uint32Array;
  /** Solid line color (alpha multiplies the layer opacity). */
  readonly color: Rgba01;
  /** Per-layer opacity multiplier, [0,1]; default 1. */
  readonly opacity?: number;
  /** Screen-space line width in pixels; default 2. */
  readonly linewidth?: number;
  /** Layer id keying the segment buffer into the VRAM ledger (perf HUD); omit to skip tracking. */
  readonly ledgerKey?: string;
}

export interface FieldlinesScene {
  readonly scene: Scene;
  /** Recolor in place (uniform only, no rebuild). */
  setColor(color: Rgba01): void;
  /** Update the per-layer opacity in place (uniform only). */
  setOpacity(opacity: number): void;
  dispose(): void;
}

const DEFAULT_LINEWIDTH = 2; // pixels

/** Build a batched field-line scene from packed world-space polylines. */
export function createFieldlinesScene(options: FieldlinesSceneOptions): FieldlinesScene {
  const segments = packSegments(options.positions, options.counts);
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(segments);

  let baseAlpha = options.color[3];
  let layerOpacity = options.opacity ?? 1;

  const material = new Line2NodeMaterial({
    color: new Color(options.color[0], options.color[1], options.color[2]),
    linewidth: options.linewidth ?? DEFAULT_LINEWIDTH,
    worldUnits: false, // screen-space px width — constant on screen, viewport read via TSL
    transparent: true,
    depthWrite: false, // lines are an overlay over the volume; don't occlude later layers by depth
  });
  material.opacity = baseAlpha * layerOpacity;

  const mesh = new LineSegments2(geometry, material);
  // Bounds from instanced segment endpoints are unreliable; the line set is small and always in view.
  mesh.frustumCulled = false;

  // No scene.background — the renderer owns the clear color so layers composite over one background.
  const scene = new Scene();
  scene.add(mesh);

  if (options.ledgerKey !== undefined) trackAlloc(options.ledgerKey, segments.byteLength);

  return {
    scene,
    setColor(color) {
      material.color.setRGB(color[0], color[1], color[2]);
      baseAlpha = color[3];
      material.opacity = baseAlpha * layerOpacity;
    },
    setOpacity(opacity) {
      layerOpacity = opacity;
      material.opacity = baseAlpha * layerOpacity;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      if (options.ledgerKey !== undefined) releaseAlloc(options.ledgerKey);
    },
  };
}

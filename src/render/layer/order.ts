import type { LayerKind } from "@schema/layers.ts";
import { UNIT_BOX_HALF_EXTENT } from "@schema/math.ts";
import type { Vec3 } from "@schema/types.ts";
import type { Camera } from "three";
import type { WindowLevel } from "../field/normalization.ts";
import type { PickLayer } from "../pickRay.ts";
import type { DrawItem } from "../runtime/renderer.ts";
import type { FieldSource, LayerEntry } from "./registry.ts";

// The ordered visibility/opacity view of the layer stack, and the two reads that walk it: the draw
// items the renderer composites, and the volume fields the opacity-weighted ray pick integrates.
// Draw order is array order. The registry owns the scenes; this owns the order.

export interface LayerOrderEntry {
  readonly id: string;
  readonly visible: boolean;
  readonly opacity: number;
}

// Which camera composites each kind: slices are screen-aligned (ortho); volumes and field lines live
// in the box under the pose camera. A complete record, so a new kind must declare its camera.
const LAYER_CAMERA: Readonly<Record<LayerKind, "ortho" | "pose">> = {
  slice: "ortho",
  volume: "pose",
  fieldlines: "pose",
};

function cameraFor(kind: LayerKind, pose: Camera, ortho: Camera): Camera {
  return LAYER_CAMERA[kind] === "ortho" ? ortho : pose;
}

export interface LayerOrder {
  // Re-order / re-tune. Returns the ids whose opacity actually moved, so the caller pushes a uniform
  // write to exactly those scenes (field data rides the heavier upsert).
  setOrder(order: readonly LayerOrderEntry[]): readonly string[];
  opacityOf(id: string): number | undefined;
  items(
    lookup: (id: string) => LayerEntry | undefined,
    volume: Camera,
    ortho: Camera,
    override?: { readonly id: string; readonly entry: LayerEntry },
    into?: DrawItem[],
  ): DrawItem[];
  pickLayers(
    lookup: (id: string) => LayerEntry | undefined,
    windowOf: (source: FieldSource) => WindowLevel,
  ): { layers: PickLayer[]; halfExtent: Vec3 };
}

export function createLayerOrder(): LayerOrder {
  let order: readonly LayerOrderEntry[] = [];

  return {
    setOrder(next) {
      const previous = new Map(order.map((entry) => [entry.id, entry.opacity]));
      const retuned: string[] = [];
      for (const entry of next) {
        if (previous.get(entry.id) !== entry.opacity) retuned.push(entry.id);
      }
      order = next;
      return retuned;
    },

    opacityOf: (id) => order.find((entry) => entry.id === id)?.opacity,

    items(lookup, volume, ortho, override, into) {
      const items = into ?? []; // the worker's paint scratch when given — no allocation per frame
      let isOverrideListed = false;
      for (const entry of order) {
        if (!entry.visible) continue;
        const isOverride = override !== undefined && entry.id === override.id;
        if (isOverride) isOverrideListed = true;
        const layer = isOverride ? override.entry : lookup(entry.id);
        if (layer === undefined) continue; // order ahead of its upsert — heals on the upsert repaint
        items.push({ scene: layer.scene.scene, camera: cameraFor(layer.kind, volume, ortho) });
      }
      if (override !== undefined && !isOverrideListed) {
        items.push({
          scene: override.entry.scene.scene,
          camera: cameraFor(override.entry.kind, volume, ortho),
        });
      }
      return items;
    },

    pickLayers(lookup, windowOf) {
      const layers: PickLayer[] = [];
      let halfExtent: Vec3 = UNIT_BOX_HALF_EXTENT; // all volume layers share the dataset's box
      for (const entry of order) {
        if (!entry.visible) continue;
        const layer = lookup(entry.id);
        if (layer === undefined || layer.kind !== "volume") continue;
        const { params } = layer.source;
        if (params.layerKind !== "volume") continue; // agrees with the entry kind by construction
        halfExtent = params.worldHalfExtent ?? halfExtent;
        layers.push({
          field: layer.source.field,
          windowLevel: windowOf(layer.source),
          scale: layer.source.scale,
          density: params.density ?? 1, // the scene factory default
          opacity: entry.opacity,
        });
      }
      return { layers, halfExtent };
    },
  };
}

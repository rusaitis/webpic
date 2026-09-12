import type { ColorScale } from "@schema/colormap.ts";
import type { Scene } from "three";
import type { ScalarField } from "./volume/volumeTexture.ts";

// The contract every renderable layer's scene satisfies, regardless of kind. The layer registry builds,
// composites, recolors, and time-swaps layers through this face, so adding a kind (the field-line and
// particle scenes to come) is "implement LayerScene + one buildScene case" — not a new type threaded
// through the registry. All look updates are in place (uniform/LUT, no rebuild); `setField` ping-pongs
// a new timestep without a 64 MiB reupload. Volume-style scenes add more via VolumeLayerScene below.
export interface LayerScene {
  readonly scene: Scene;
  // Update the value→color window in place (no texture re-upload).
  setWindowLevel(center: number, width: number): void;
  // Rebake the colormap LUT in place (idempotent on an unchanged name).
  setColormap(name: string): void;
  // Switch the value→color scale in place (uniform only).
  setScale(scale: ColorScale): void;
  // Update the per-layer opacity in place (uniform only, no rebuild).
  setOpacity(opacity: number): void;
  // Ping-pong a new timestep's field into the scene in place (no rebuild). Returns false when the
  // in-place swap can't apply (shape change, or a stale acceleration grid) and the caller rebuilds.
  setField(field: ScalarField): boolean;
  dispose(): void;
}

// The extra surface a volume-style scene adds: interaction-time march quality, the projection flip, and
// the Phong toggle. The registry narrows to these per-capability (`"setShading" in scene`) — a slice has
// no march to scale and no normal to light, so it stays a bare LayerScene; the worker pairs setProjection
// with the matching camera.
export interface VolumeLayerScene extends LayerScene {
  // Toggle Phong shading in place (uniform only, no rebuild — the volume stays uploaded).
  setShading(enabled: boolean): void;
  // Scale the marched step count in place (uniform only) — interaction-time quality. Clamped to (0, 1];
  // full quality (1) is bit-identical to a fixed march.
  setStepScale(scale: number): void;
  // Switch ray generation between perspective and orthographic (parallel rays) in place — a uniform
  // flip, no rebuild.
  setProjection(orthographic: boolean): void;
}

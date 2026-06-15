import type { CameraPose } from "@schema/camera.ts";
import type { Vec3 } from "@schema/types.ts";
import { createManagedDecoration, type ManagedDecoration } from "../managedDecoration.ts";
import type { MarkerConfig, MarkerPart } from "../messages.ts";
import type { RenderModuleContext } from "../renderModule.ts";
import { createMarkerScene, type MarkerScene } from "./markerScene.ts";

// The draggable point-picker marker's lifecycle: a managed decoration (single optional scene, retained
// config, device-restore replay) plus the marker's own extras layered on top — the live interaction
// state (position + hover/active, all replayed on rebuild via `prepare`) and the per-frame easing clock.
// The worker keeps `compositeItems` and reads the committed marker via `current()`; the prospective marker
// flows back through `host.warmComposite`. Live pose comes from the host (the marker re-runs its zoom
// scale + handle gating against it on build/restore/pose).
export interface MarkerHost extends RenderModuleContext {
  pose(): CameraPose;
  isOrthographic(): boolean;
  // Compile the full prospective composite (the worker splices this marker in via compositeItems).
  warmComposite(prospective: MarkerScene): Promise<unknown> | undefined;
}

export interface ManagedMarker extends ManagedDecoration<MarkerScene, MarkerConfig> {
  /** Live position + interaction state (high-frequency during a drag). */
  setPoint(point: Vec3 | null, hoveredPart: MarkerPart, isActive: boolean): void;
  /** Re-run the marker's zoom scale + handle gating for the live pose. */
  applyPose(): void;
  /** Advance the hover/pulse/active easing; true while still animating. Owns the dt clock. */
  tick(frameTimeMs: number): boolean;
}

export function createManagedMarker(host: MarkerHost): ManagedMarker {
  // Live interaction state, retained so build + device-restore can re-seed a fresh scene in place.
  let point: Vec3 | null = null;
  let hoveredPart: MarkerPart = "none";
  let isActive = false;
  // Wall clock of the previous easing tick, for the dt. undefined restarts the clock (fresh scene).
  let lastTickMs: number | undefined;

  // Seed a fresh scene with the live pose + retained position/state so its first committed frame shows
  // the marker in place (and its warm compiles the real composite).
  const seed = (scene: MarkerScene): void => {
    scene.updateForPose(host.pose(), host.isOrthographic());
    scene.setPoint(point);
    scene.setState(hoveredPart, isActive);
  };

  const decoration = createManagedDecoration<MarkerScene, MarkerConfig>({
    create: createMarkerScene,
    warm: (scene) => host.warmComposite(scene),
    prepare: (scene) => {
      seed(scene);
      lastTickMs = undefined; // restart the easing dt clock for the fresh scene
    },
    ctx: host,
  });

  return {
    ...decoration,

    setPoint(nextPoint, nextHoveredPart, nextIsActive) {
      // Own a copy — don't alias the message's array (it may be reused).
      point = nextPoint === null ? null : [nextPoint[0], nextPoint[1], nextPoint[2]];
      hoveredPart = nextHoveredPart;
      isActive = nextIsActive;
      const scene = decoration.current();
      if (scene !== undefined) {
        scene.setPoint(point);
        scene.setState(hoveredPart, isActive);
      }
      host.requestRender();
    },

    applyPose() {
      decoration.current()?.updateForPose(host.pose(), host.isOrthographic());
    },

    tick(frameTimeMs) {
      const scene = decoration.current();
      if (scene === undefined) {
        lastTickMs = undefined;
        return false;
      }
      // dt from the vsync-aligned rAF timestamp, not performance.now() — callback jitter would
      // unevenly chop the easing steps. First tick of a fresh scene assumes a 60 Hz frame.
      const dtSec = lastTickMs === undefined ? 1 / 60 : (frameTimeMs - lastTickMs) / 1000;
      lastTickMs = frameTimeMs;
      return scene.tick(dtSec);
    },
  };
}

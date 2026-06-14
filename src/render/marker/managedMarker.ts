import type { CameraPose } from "@schema/camera.ts";
import type { Vec3 } from "@schema/types.ts";
import { warmScene } from "../managedScene.ts";
import type { MarkerConfig, MarkerPart } from "../messages.ts";
import { createMarkerScene, type MarkerScene } from "./markerScene.ts";

// The draggable point-picker marker's lifecycle, factored out of the render worker to mirror the
// layer registry / managed overlay. It owns the committed scene, the config it was built from, and
// the live interaction state (position + hover/active) — all replayed on a device-restore rebuild —
// plus the per-frame easing clock. The worker keeps `compositeItems` and reads the committed marker
// via `current()`; the prospective marker flows back through `host.warmComposite`. Live pose comes
// from the host (the marker re-runs its zoom scale + handle gating against it on build/restore/pose).
export interface MarkerHost {
  pose(): CameraPose;
  isOrthographic(): boolean;
  requestRender(): void;
  reportFault(error: unknown): void;
  // Compile the full prospective composite (the worker splices this marker in via compositeItems).
  warmComposite(prospective: MarkerScene): Promise<unknown> | undefined;
}

export interface ManagedMarker {
  /** Build/replace the marker (or tear it down on null) — warm-then-commit, seeding the live state. */
  build(config: MarkerConfig | null): Promise<void>;
  /** Live position + interaction state (high-frequency during a drag). */
  setPoint(point: Vec3 | null, hoveredPart: MarkerPart, isActive: boolean): void;
  /** Re-run the marker's zoom scale + handle gating for the live pose. */
  applyPose(): void;
  /** Advance the hover/pulse/active easing; true while still animating. Owns the dt clock. */
  tick(frameTimeMs: number): boolean;
  /** The committed marker, for the worker's composite assembly. */
  current(): MarkerScene | undefined;
  // device-restore (the worker orchestrates renderer/layers/overlay around these).
  bumpEpoch(): void;
  disposeForRebuild(): void;
  rebuild(): void;
  // teardown
  dispose(): void;
}

export function createManagedMarker(host: MarkerHost): ManagedMarker {
  let marker: MarkerScene | undefined;
  // Retained so a device-restore rebuild reproduces the live marker (its GPU resources belonged to the
  // dead device); mirrors how a layer retains its LayerSource.
  let source: MarkerConfig | undefined;
  // Live interaction state, retained so build + device-restore can re-seed a fresh scene in place.
  let point: Vec3 | null = null;
  let hoveredPart: MarkerPart = "none";
  let isActive = false;
  // Wall clock of the previous easing tick, for the dt. undefined restarts the clock (fresh scene).
  let lastTickMs: number | undefined;
  // Superseding guard for the async warm (see managedOverlay).
  let epoch = 0;

  // Seed a fresh scene with the live pose + retained position/state so its first committed frame shows
  // the marker in place (and its warm compiles the real composite). Shared by build + rebuild.
  function seed(scene: MarkerScene): void {
    scene.updateForPose(host.pose(), host.isOrthographic());
    scene.setPoint(point);
    scene.setState(hoveredPart, isActive);
  }

  return {
    async build(config) {
      const mine = ++epoch;
      const next = config !== null ? createMarkerScene(config) : undefined;
      if (next !== undefined) seed(next);
      const committed = await warmScene(
        next,
        () => (next !== undefined ? host.warmComposite(next) : undefined),
        () => epoch === mine,
        (scene) => scene.dispose(),
        host.reportFault,
      );
      if (!committed) return;
      const previous = marker;
      marker = next;
      source = config ?? undefined;
      previous?.dispose();
      lastTickMs = undefined; // restart the easing dt clock for the fresh scene
      host.requestRender();
    },

    setPoint(nextPoint, nextHoveredPart, nextIsActive) {
      // Own a copy — don't alias the message's array (it may be reused).
      point = nextPoint === null ? null : [nextPoint[0], nextPoint[1], nextPoint[2]];
      hoveredPart = nextHoveredPart;
      isActive = nextIsActive;
      marker?.setPoint(point);
      marker?.setState(hoveredPart, isActive);
      host.requestRender();
    },

    applyPose() {
      marker?.updateForPose(host.pose(), host.isOrthographic());
    },

    tick(frameTimeMs) {
      if (marker === undefined) {
        lastTickMs = undefined;
        return false;
      }
      // dt from the vsync-aligned rAF timestamp, not performance.now() — callback jitter would
      // unevenly chop the easing steps. First tick of a fresh scene assumes a 60 Hz frame.
      const dtSec = lastTickMs === undefined ? 1 / 60 : (frameTimeMs - lastTickMs) / 1000;
      lastTickMs = frameTimeMs;
      return marker.tick(dtSec);
    },

    current() {
      return marker;
    },

    bumpEpoch() {
      epoch += 1;
    },

    disposeForRebuild() {
      marker?.dispose();
    },

    rebuild() {
      marker = source !== undefined ? createMarkerScene(source) : undefined;
      if (marker !== undefined) seed(marker);
      lastTickMs = undefined;
    },

    dispose() {
      marker?.dispose();
      marker = undefined;
      source = undefined;
    },
  };
}

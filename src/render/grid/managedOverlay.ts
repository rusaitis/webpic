import { warmScene } from "../managedScene.ts";
import type { SceneOverlayConfig } from "../messages.ts";
import { createSceneOverlay, type SceneOverlay } from "./overlayScene.ts";

// The axes + grid overlay's lifecycle, factored out of the render worker to mirror the layer
// registry: it owns the committed scene + the config it was built from, runs the warm-then-commit,
// and replays the scene on a device-restore rebuild. The worker keeps `compositeItems` (only it has
// the cameras + the other scenes) and reads the committed overlay via `current()`; the prospective
// overlay flows back through `host.warmComposite` so the warm compiles the *full* composite.
export interface OverlayHost {
  requestRender(): void;
  reportFault(error: unknown): void;
  // Compile the full prospective composite (the worker splices this overlay in via compositeItems).
  warmComposite(prospective: SceneOverlay): Promise<unknown> | undefined;
}

export interface ManagedOverlay {
  /** Build/replace the overlay (or tear it down on null) — warm-then-commit. */
  build(config: SceneOverlayConfig | null): Promise<void>;
  /** The committed overlay, for the worker's composite assembly. */
  current(): SceneOverlay | undefined;
  // device-restore (the worker orchestrates renderer/layers/marker around these).
  bumpEpoch(): void;
  disposeForRebuild(): void;
  rebuild(): void;
  // teardown
  dispose(): void;
}

export function createManagedOverlay(host: OverlayHost): ManagedOverlay {
  let overlay: SceneOverlay | undefined;
  // Retained so a device-restore rebuild reproduces the live overlay (its line buffers + CanvasTextures
  // belonged to the dead device); mirrors how a layer retains its LayerSource.
  let source: SceneOverlayConfig | undefined;
  // Superseding guard for the async warm: a newer build (or a device rebuild) bumps the epoch mid-warm,
  // so the in-flight scene is discarded instead of committing a stale/dead-device overlay.
  let epoch = 0;

  return {
    async build(config) {
      const mine = ++epoch;
      const next = config !== null ? createSceneOverlay(config) : undefined;
      const committed = await warmScene(
        next,
        () => (next !== undefined ? host.warmComposite(next) : undefined),
        () => epoch === mine,
        (scene) => scene.dispose(),
        host.reportFault,
      );
      if (!committed) return;
      // New scene live before the old one's GPU resources are freed — the overlay has no
      // readback-borrowed texture, so a same-tick dispose is safe (unlike the layer registry's
      // one-frame deferral).
      const previous = overlay;
      overlay = next;
      source = config ?? undefined;
      previous?.dispose();
      host.requestRender();
    },

    current() {
      return overlay;
    },

    bumpEpoch() {
      epoch += 1;
    },

    disposeForRebuild() {
      overlay?.dispose();
    },

    rebuild() {
      overlay = source !== undefined ? createSceneOverlay(source) : undefined;
    },

    dispose() {
      overlay?.dispose();
      overlay = undefined;
      source = undefined;
    },
  };
}

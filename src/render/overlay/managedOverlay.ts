import { createManagedDecoration, type ManagedDecoration } from "../managedDecoration.ts";
import type { SceneOverlayConfig } from "../messages.ts";
import type { RenderModuleContext } from "../renderModule.ts";
import { createOverlayScene, type OverlayScene } from "./overlayScene.ts";

// The axes + grid overlay's lifecycle: a plain managed decoration (single optional scene, retained
// config, replayed on a device-restore rebuild), so it delegates wholesale to createManagedDecoration.
// The worker keeps `compositeItems` (only it has the cameras + the other scenes) and reads the committed
// overlay via `current()`; the prospective overlay flows back through `host.warmComposite` so the warm
// compiles the *full* composite (overlay spliced in).
export interface OverlayHost extends RenderModuleContext {
  // Compile the full prospective composite (the worker splices this overlay in via drawItems).
  warmComposite(prospective: OverlayScene): Promise<unknown> | undefined;
}

export type ManagedOverlay = ManagedDecoration<OverlayScene, SceneOverlayConfig>;

export function createManagedOverlay(host: OverlayHost): ManagedOverlay {
  return createManagedDecoration<OverlayScene, SceneOverlayConfig>({
    create: createOverlayScene,
    warm: (scene) => host.warmComposite(scene),
    context: host,
  });
}

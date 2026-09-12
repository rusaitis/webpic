import { warmScene } from "./managedScene.ts";
import type { RenderModule, RenderModuleContext } from "./renderModule.ts";

// The shared lifecycle skeleton behind every "single optional scene, replayed on device-restore"
// manager — the axes/grid overlay and the point-picker marker today. It owns the committed scene, the
// config it was built from, and the superseding epoch, and runs warm-then-commit on build, the replay
// on rebuild, and the teardown. The caller supplies the scene factory, the warm (which compiles the
// *full* composite with this scene spliced in — the worker owns that), and an optional `prepare` that
// seeds a fresh scene with live state before it goes visible.
export interface DecorationSpec<TScene extends { dispose(): void }, TConfig> {
  create(config: TConfig): TScene;
  warm(scene: TScene): Promise<unknown> | undefined;
  prepare?(scene: TScene): void;
  context: RenderModuleContext;
}

export interface ManagedDecoration<TScene, TConfig> extends RenderModule {
  // Build/replace the scene (or tear it down on null) — warm-then-commit.
  build(config: TConfig | null): Promise<void>;
  // The committed scene, for the worker's composite assembly.
  current(): TScene | undefined;
}

export function createManagedDecoration<TScene extends { dispose(): void }, TConfig>(
  spec: DecorationSpec<TScene, TConfig>,
): ManagedDecoration<TScene, TConfig> {
  let scene: TScene | undefined;
  // Retained so a device-restore rebuild reproduces the live scene (its GPU resources belonged to the
  // dead device); mirrors how a layer retains its LayerSource.
  let source: TConfig | undefined;
  // Superseding guard for the async warm: a newer build (or a device rebuild) bumps the epoch mid-warm,
  // so the in-flight scene is discarded instead of committing a stale/dead-device one.
  let epoch = 0;

  return {
    async build(config) {
      const mine = ++epoch;
      const next = config !== null ? spec.create(config) : undefined;
      if (next !== undefined) spec.prepare?.(next);
      const committed = await warmScene(
        next,
        () => (next !== undefined ? spec.warm(next) : undefined),
        () => epoch === mine,
        (built) => built.dispose(),
        spec.context.reportFault,
      );
      if (!committed) return;
      // New scene live before the old one's GPU resources are freed — a decoration has no
      // readback-borrowed texture, so a same-tick dispose is safe (unlike the layer registry's deferral).
      const previous = scene;
      scene = next;
      source = config ?? undefined;
      previous?.dispose();
      spec.context.requestRender();
    },

    current() {
      return scene;
    },

    supersedeWarms() {
      epoch += 1;
    },

    disposeForRebuild() {
      scene?.dispose();
    },

    rebuild() {
      scene = source !== undefined ? spec.create(source) : undefined;
      if (scene !== undefined) spec.prepare?.(scene);
    },

    dispose() {
      scene?.dispose();
      scene = undefined;
      source = undefined;
    },
  };
}

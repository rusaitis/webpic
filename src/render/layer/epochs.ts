import type { LayerEntry } from "./registry.ts";

// Who wins when two layer builds race, and when a replaced scene's GPU memory is actually freed. Both
// answers are timing, not rendering, so they live apart from the registry's scene logic.
//
// An id's epoch bumps on every replace/remove and on a device rebuild, so an async warm that loses the
// race discards its scene. A replaced scene's dispose is deferred by one swap: the rAF loop must never
// sample a GPUTexture a replace just released, which reads back as the magenta sentinel.

export interface LayerEpochs {
  // Open a build for `id`, invalidating any warm already in flight for it. The returned epoch is the
  // token `isCurrent` checks after the await.
  begin(id: string): number;
  isCurrent(id: string, epoch: number): boolean;
  // Invalidate every id's in-flight warm (device rebuild).
  supersedeAll(ids: Iterable<string>): void;
  // Scenes built but not yet committed. A look edit landing mid-warm must reach these too, or the
  // incoming scene — built from the source as it was at upsert time — silently reverts it.
  warming(id: string): LayerEntry | undefined;
  hold(id: string, entry: LayerEntry): void;
  release(id: string, entry: LayerEntry): void;
  // Free the previously deferred scene and take `entry` in its place.
  defer(entry: LayerEntry | undefined): void;
  disposeDeferred(): void;
  // Drop the deferred entry WITHOUT disposing it — the device is gone and its textures with it.
  forgetDeferred(): void;
}

export function createLayerEpochs(): LayerEpochs {
  const epochs = new Map<string, number>();
  const building = new Map<string, LayerEntry>();
  let deferred: LayerEntry | undefined;

  const bump = (id: string): number => {
    const next = (epochs.get(id) ?? 0) + 1;
    epochs.set(id, next);
    return next;
  };

  return {
    begin: bump,
    isCurrent: (id, epoch) => epochs.get(id) === epoch,
    supersedeAll(ids) {
      for (const id of ids) bump(id);
    },
    warming: (id) => building.get(id),
    hold(id, entry) {
      building.set(id, entry);
    },
    release(id, entry) {
      if (building.get(id) === entry) building.delete(id);
    },
    defer(entry) {
      deferred?.scene.dispose();
      deferred = entry;
    },
    disposeDeferred() {
      deferred?.scene.dispose();
      deferred = undefined;
    },
    forgetDeferred() {
      deferred = undefined;
    },
  };
}

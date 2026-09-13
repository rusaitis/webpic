// The three.js resources a scene allocates — geometries, materials, textures — must each be
// disposed when the scene is torn down. Tracking them in one bag folds the bookkeeping into the
// construction line (`bag.add(new SphereGeometry(...))`), so a resource added later cannot be
// forgotten by a missing push. gpu/bufferPool.ts is the same pattern for GPUBuffer.

export interface DisposableBag {
  add<T extends { dispose(): void }>(resource: T): T;
  dispose(): void;
}

export function createDisposableBag(): DisposableBag {
  const resources: { dispose(): void }[] = [];
  return {
    add(resource) {
      resources.push(resource);
      return resource;
    },
    dispose() {
      // Creation order. three.js disposes geometries, materials and textures independently — a
      // material's dispose does not reach its map — so no ordering constraint applies. Drained as
      // it goes, so a second dispose (a rebuild racing a teardown) frees nothing twice.
      for (const resource of resources.splice(0)) resource.dispose();
    },
  };
}

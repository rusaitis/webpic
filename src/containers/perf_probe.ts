// Browser heap probe for the dev perf HUD. `performance.memory` is Chrome-only and absent from the
// lib types (main thread + workers), so read it defensively — a cheap synchronous property access,
// null where it's missing. Lives in containers, the only layer reachable by the render worker, the
// data worker, AND the app perf bridge (workers can't reach gpu, where the sibling vram probe lives).
export function readHeapBytes(): number | null {
  const memory = (performance as { memory?: { readonly usedJSHeapSize: number } }).memory;
  return memory !== undefined ? memory.usedJSHeapSize : null;
}

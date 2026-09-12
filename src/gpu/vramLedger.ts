// Tracked-allocation byte ledger backing the perf HUD's VRAM estimate. WebGPU exposes no
// device-level allocation total, so this sums only the large buffers webpic creates
// explicitly — the volume 3D texture + the swapchain render targets — and is honestly an
// *estimate* (it excludes three.js internal pipeline/uniform/depth buffers and the swapchain).
// trackAlloc overwrites a key, so a resize/realloc replaces the prior figure instead of
// double-counting. One ledger per worker scope, like the GPU device singleton, so a module
// singleton is the right shape; resetLedger drops everything on device loss before the fresh
// allocations re-register.

const allocations = new Map<string, number>();

// Record (or replace) the byte size held under `key`. Idempotent: a realloc on resize
// overwrites rather than accumulates.
export function trackAlloc(key: string, bytes: number): void {
  allocations.set(key, bytes);
}

// Drop `key` from the ledger (on dispose). Unknown keys are a no-op.
export function releaseAlloc(key: string): void {
  allocations.delete(key);
}

export interface VramSnapshot {
  readonly totalBytes: number;
  // Per-key breakdown, largest-first for display.
  readonly byKey: readonly (readonly [string, number])[];
}

export function snapshot(): VramSnapshot {
  let totalBytes = 0;
  for (const bytes of allocations.values()) totalBytes += bytes;
  const byKey = [...allocations.entries()].sort((a, b) => b[1] - a[1]);
  return { totalBytes, byKey };
}

// Drop every key — on device loss, before fresh allocations re-register, so VRAM doesn't
// double-count across a recovery.
export function resetLedger(): void {
  allocations.clear();
}

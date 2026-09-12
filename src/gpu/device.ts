// The single GPUDevice webpic runs on. `compute/backends/webgpu` and `render/`
// both import the device from here. This module owns acquisition (with a clean
// unsupported signal for the requires-WebGPU page), the singleton, and device.lost
// recovery. It cannot import other layers (gpu is a foundational leaf), so recovery
// is a mechanism: re-acquire the device and notify registered observers — render/
// and compute/ rebuild themselves on `onDeviceRestored`.

import {
  DESIRED_FEATURES,
  type GpuCapabilities,
  probeCapabilities,
  selectFeatures,
} from "./capabilities.ts";

type GpuUnsupportedReason = "no-navigator-gpu" | "no-adapter" | "no-device";

export type GpuSupport =
  | { readonly ok: true; readonly adapter: GPUAdapter; readonly device: GPUDevice }
  | { readonly ok: false; readonly reason: GpuUnsupportedReason; readonly message: string };

export interface GpuRequestOptions {
  readonly powerPreference?: GPUPowerPreference;
  readonly requiredFeatures?: readonly GPUFeatureName[]; // intersected with the adapter
  readonly requiredLimits?: Record<string, number>;
  readonly label?: string;
  readonly reacquireOnLoss?: boolean; // auto re-acquire on real device loss (default true)
}

export interface InstalledGpu {
  readonly device: GPUDevice;
  readonly adapter: GPUAdapter;
  readonly capabilities: GpuCapabilities;
  readonly dispose: () => void; // install*() => () => void teardown contract
}

type DeviceLossKind = "intentional" | "destroyed" | "unknown";

export interface DeviceLossEvent {
  readonly kind: DeviceLossKind;
  readonly message: string;
  /** No further auto-recovery will be attempted: the breaker tripped (too many rapid losses) or
   *  re-acquisition failed (no adapter). Listeners should surface a terminal "reload" state. */
  readonly isTerminal: boolean;
}

export type DeviceLostListener = (event: DeviceLossEvent) => void;
export type DeviceRestoredListener = (device: GPUDevice) => void;
export type Unsubscribe = () => void;

/**
 * Thrown by {@link installGpu} when WebGPU is unavailable. Carries the discriminant
 * so callers can branch (e.g. render the requires-WebGPU page) without string-matching.
 */
export class GpuUnavailableError extends Error {
  readonly reason: GpuUnsupportedReason;
  constructor(reason: GpuUnsupportedReason, message: string) {
    super(message);
    this.name = "GpuUnavailableError";
    this.reason = reason;
  }
}

interface GpuSingleton {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly capabilities: GpuCapabilities;
  hasSettled: boolean; // loss or dispose already processed for this device
}

let current: GpuSingleton | undefined;
// Bumped by dispose(): an in-flight recovery compares it across its await and drops a device that
// arrived for a session the caller has already torn down (otherwise it re-installs the singleton
// behind the caller's back, and the next installGpu() reports "already installed").
let session = 0;
const lostListeners = new Set<DeviceLostListener>();
const restoredListeners = new Set<DeviceRestoredListener>();

// Circuit-breaker: a device that dies repeatedly (a render the GPU can't survive) must NOT be
// re-acquired forever — hammering requestAdapter exhausts the GPU process (Safari → no-adapter).
// After MAX_LOSSES within WINDOW, stop auto-recovery and emit a terminal loss. This is a safety
// limit (mechanism), not retry policy — when/how to surface "reload" stays with the caller.
const LOSS_WINDOW_MS = 5000;
const MAX_LOSSES_IN_WINDOW = 3;
const recentLosses: number[] = [];

function recordLossAndAllowRecovery(): boolean {
  const now = performance.now();
  recentLosses.push(now);
  while (recentLosses.length > 0 && now - (recentLosses[0] ?? now) > LOSS_WINDOW_MS) {
    recentLosses.shift();
  }
  return recentLosses.length < MAX_LOSSES_IN_WINDOW;
}

function navigatorGpu(): GPU | undefined {
  // @webgpu/types declares navigator.gpu as required, but it is absent on
  // non-WebGPU browsers and on Node — probe presence before reaching for it.
  if (typeof navigator === "undefined" || !("gpu" in navigator)) return undefined;
  return navigator.gpu;
}

/**
 * Acquire an adapter + device without touching the singleton. Returns a
 * discriminated result so the caller can show a requires-WebGPU page on `!ok`
 * instead of catching an exception.
 */
export async function requestGpu(options?: GpuRequestOptions): Promise<GpuSupport> {
  const gpu = navigatorGpu();
  if (gpu === undefined) {
    return {
      ok: false,
      reason: "no-navigator-gpu",
      message: "WebGPU is unavailable: navigator.gpu is undefined.",
    };
  }
  const adapterOptions: GPURequestAdapterOptions = {};
  if (options?.powerPreference !== undefined) {
    adapterOptions.powerPreference = options.powerPreference;
  }
  const adapter = await gpu.requestAdapter(adapterOptions);
  if (adapter === null) {
    return {
      ok: false,
      reason: "no-adapter",
      message: "WebGPU is unavailable: no GPUAdapter (check drivers or hardware acceleration).",
    };
  }
  const descriptor: GPUDeviceDescriptor = {
    requiredFeatures: selectFeatures(adapter, options?.requiredFeatures ?? DESIRED_FEATURES),
  };
  if (options?.requiredLimits !== undefined) descriptor.requiredLimits = options.requiredLimits;
  if (options?.label !== undefined) descriptor.label = options.label;
  try {
    const device = await adapter.requestDevice(descriptor);
    return { ok: true, adapter, device };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "no-device", message: `WebGPU device request failed: ${detail}` };
  }
}

/**
 * Acquire, store the singleton, wire device.lost recovery, and return a disposer.
 * Throws {@link GpuUnavailableError} when WebGPU is missing — call {@link requestGpu}
 * first if you need to branch on the unsupported reason without a try/catch.
 */
export async function installGpu(options?: GpuRequestOptions): Promise<InstalledGpu> {
  if (current !== undefined) {
    throw new Error("GPU already installed; dispose the previous handle before reinstalling.");
  }
  const support = await requestGpu(options);
  if (!support.ok) {
    throw new GpuUnavailableError(support.reason, support.message);
  }
  const singleton = adopt(support.adapter, support.device, options);
  return {
    device: singleton.device,
    adapter: singleton.adapter,
    capabilities: singleton.capabilities,
    dispose,
  };
}

function requireInstalled(): GpuSingleton {
  if (current === undefined) throw new Error("GPU not installed; call installGpu() first.");
  return current;
}

export function getDevice(): GPUDevice {
  return requireInstalled().device;
}

/** Non-throwing companion to {@link getDevice}: is a device installed right now? The WebGPU
 *  compute backend's `supports()` gates on this — false in Node and in workers (no transferable
 *  device), so the dispatcher never routes to a backend that would throw on `getDevice()`. */
export function hasDevice(): boolean {
  return current !== undefined;
}

export function getCapabilities(): GpuCapabilities {
  return requireInstalled().capabilities;
}

export function onDeviceLost(listener: DeviceLostListener): Unsubscribe {
  lostListeners.add(listener);
  return () => {
    lostListeners.delete(listener);
  };
}

export function onDeviceRestored(listener: DeviceRestoredListener): Unsubscribe {
  restoredListeners.add(listener);
  return () => {
    restoredListeners.delete(listener);
  };
}

// gpu/ is a dependency-free leaf, so its own failure path writes to the console directly: a listener
// that throws inside device-loss handling must surface, not vanish as an unhandled rejection.
function reportUnhandled(error: unknown): void {
  console.error("[webpic:gpu] device-loss handling failed", error);
}

function adopt(adapter: GPUAdapter, device: GPUDevice, options?: GpuRequestOptions): GpuSingleton {
  const singleton: GpuSingleton = {
    adapter,
    device,
    capabilities: probeCapabilities(adapter, device),
    hasSettled: false,
  };
  current = singleton;
  void watchForLoss(singleton, options).catch(reportUnhandled);
  return singleton;
}

async function watchForLoss(singleton: GpuSingleton, options?: GpuRequestOptions): Promise<void> {
  const info = await singleton.device.lost; // resolves (never rejects) on loss or destroy
  if (singleton.hasSettled) return; // dispose() already handled this device synchronously
  singleton.hasSettled = true;
  const kind: DeviceLossKind = info.reason === "destroyed" ? "destroyed" : "unknown";
  if (current === singleton) current = undefined;
  // Recover only if the caller opted in AND the breaker hasn't tripped. A tripped breaker is terminal.
  const reacquire = (options?.reacquireOnLoss ?? true) && recordLossAndAllowRecovery();
  emitLost({ kind, message: info.message, isTerminal: !reacquire });
  if (reacquire) void recover(options).catch(reportUnhandled);
}

async function recover(options?: GpuRequestOptions): Promise<void> {
  const era = session;
  const support = await requestGpu(options);
  if (session !== era) {
    if (support.ok) support.device.destroy(); // disposed mid-re-acquire: release what just arrived
    return;
  }
  if (!support.ok) {
    // One attempt only; surface failure as a terminal synthetic loss so the UI banner stays
    // up. Retry policy belongs to app/, not gpu/ — never loop here.
    emitLost({
      kind: "unknown",
      message: `GPU recovery failed: ${support.message}`,
      isTerminal: true,
    });
    return;
  }
  const singleton = adopt(support.adapter, support.device, options);
  emitRestored(singleton.device);
}

function dispose(): void {
  session += 1;
  recentLosses.length = 0; // a disposed session starts the breaker fresh on re-install
  const singleton = current;
  current = undefined;
  if (singleton !== undefined) {
    if (!singleton.hasSettled) {
      singleton.hasSettled = true; // suppress the pending watchForLoss for this device
      // Intentional teardown — not a GPU failure; nothing to recover or banner.
      emitLost({
        kind: "intentional",
        message: "GPU device destroyed by dispose().",
        isTerminal: false,
      });
    }
    singleton.device.destroy();
  }
  lostListeners.clear();
  restoredListeners.clear();
}

function emitLost(event: DeviceLossEvent): void {
  for (const listener of lostListeners) listener(event);
}

function emitRestored(device: GPUDevice): void {
  for (const listener of restoredListeners) listener(device);
}

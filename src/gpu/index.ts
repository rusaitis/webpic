export {
  DESIRED_FEATURES,
  type GpuAdapterSummary,
  type GpuCapabilities,
  type GpuLimitsSummary,
  probeCapabilities,
  selectFeatures,
} from "./capabilities.ts";
export { type FieldKernelSpec, runFieldKernel } from "./computeKernel.ts";
export {
  type DeviceLossEvent,
  type DeviceLossKind,
  type DeviceLostListener,
  type DeviceRestoredListener,
  type GpuRequestOptions,
  type GpuSupport,
  GpuUnavailableError,
  type GpuUnsupportedReason,
  getCapabilities,
  getDevice,
  hasDevice,
  type InstalledGpu,
  installGpu,
  onDeviceLost,
  onDeviceRestored,
  requestGpu,
  type Unsubscribe,
} from "./device.ts";
export { createGpuProfiler, type GpuProfiler, type GpuProfilerMode } from "./profiler.ts";
export {
  releaseAlloc,
  resetLedger,
  snapshot as vramSnapshot,
  trackAlloc,
  type VramSnapshot,
} from "./vramLedger.ts";

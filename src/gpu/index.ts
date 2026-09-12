export type { GpuAdapterSummary } from "./capabilities.ts";
export {
  type DeviceLossEvent,
  getCapabilities,
  getDevice,
  type InstalledGpu,
  installGpu,
  onDeviceLost,
  onDeviceRestored,
} from "./device.ts";
export { resetLedger, type VramSnapshot, vramSnapshot } from "./vramLedger.ts";

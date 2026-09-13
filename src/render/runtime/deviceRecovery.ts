import { type DeviceLossEvent, onDeviceLost, onDeviceRestored } from "@gpu";
import type { GpuRecoveryReason } from "../messages.ts";

// GPU device-loss recovery. gpu/ re-acquires the device after a loss and fires onDeviceRestored;
// render/ must then rebuild the renderer and every scene on the new device, or a recoverable loss
// becomes a permanently frozen swapchain. This owns the loss policy (recoverable vs terminal), the
// isDeviceLost flag the loop pauses on, and the rebuild ORDER — the most consequence-laden sequence in
// render/, where a wrong order leaves a magenta or frozen swapchain. The worker owns the GPU resources
// and exposes them as capabilities, so this sequences the recovery without holding a three handle.
interface DeviceRecoveryHost {
  // Has the first renderer been built? A pre-init loss has nothing to rebuild.
  hasCanvas(): boolean;
  // Bump every scene epoch so an in-flight warm discards instead of landing a dead-device scene.
  supersedeInFlightWarms(): void;
  // Best-effort drop of the dead device's renderer + scene handles (teardown can throw; swallowed).
  teardownDeadResources(): void;
  // Install a fresh renderer on the restored device and rebuild every scene from its retained CPU
  // source, re-asserting the live quality level. (One step so the install→rebuild order is atomic.)
  rebuildOnDevice(device: GPUDevice): Promise<void>;
  // Warm the rebuilt composite before the loop un-pauses (a warm fault is reported, not fatal).
  warmComposite(): Promise<void>;
  // Repaint now the device is live again.
  requestRender(): void;
  // Halt the loop on an unrecoverable loss.
  stopLoop(): void;
  reportError(message: string): void;
  reportFault(error: unknown): void;
  // Tell the app a loss was unrecoverable so it can surface a reload state.
  postRecoveryFailed(reason: GpuRecoveryReason, message: string): void;
}

export interface DeviceRecovery {
  // Subscribe to gpu/'s loss + restore signals (call from init).
  start(): void;
  // Is the device currently lost? The display loop pauses while true.
  isDeviceLost(): boolean;
  // Unsubscribe (call from dispose).
  stop(): void;
}

export function createDeviceRecovery(host: DeviceRecoveryHost): DeviceRecovery {
  let isLost = false;
  let unsubscribe: (() => void) | undefined;

  // The order is load-bearing: supersede in-flight warms, drop the dead resources, install fresh,
  // rebuild scenes, warm the pipelines — only THEN clear the pause and repaint, so the first restored
  // frame neither stalls nor draws on a dead device. (worker.recovery covers this end to end.)
  async function rebuild(device: GPUDevice): Promise<void> {
    if (!host.hasCanvas()) return; // pre-init loss — nothing to rebuild yet
    host.supersedeInFlightWarms();
    host.teardownDeadResources();
    await host.rebuildOnDevice(device);
    await host.warmComposite();
    isLost = false;
    host.requestRender();
  }

  function onLost(event: DeviceLossEvent): void {
    isLost = true; // pause the loop between loss and restore
    if (event.isTerminal) {
      // Recovery gave up (breaker tripped or no adapter) — halt the loop so nothing hammers the dead
      // GPU, and tell the app to show a terminal "reload" state instead of spiraling.
      host.stopLoop();
      const reason: GpuRecoveryReason = event.message.includes("GPUAdapter")
        ? "no-adapter"
        : "repeated-loss";
      host.postRecoveryFailed(reason, event.message);
    } else {
      host.reportError(`WebGPU device lost (${event.kind}): ${event.message}`);
    }
  }

  return {
    start() {
      const offLost = onDeviceLost(onLost);
      const offRestored = onDeviceRestored((device) => {
        void rebuild(device).catch(host.reportFault);
      });
      unsubscribe = () => {
        offLost();
        offRestored();
      };
    },
    isDeviceLost: () => isLost,
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

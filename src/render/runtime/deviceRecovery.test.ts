import type { DeviceLossEvent } from "@gpu";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The recovery manager in isolation: @gpu is mocked to capture the loss + restore listeners, and a
// fake host records the order of every rebuild step. The order is the load-bearing contract (a wrong
// sequence = a frozen/magenta swapchain), so these assert it directly — the complement to
// worker.recovery.test.ts, which drives the same flow through the real worker + mocked renderer.
const gpu = vi.hoisted(() => ({
  lostCbs: [] as Array<(e: DeviceLossEvent) => void>,
  restoredCbs: [] as Array<(d: unknown) => void>,
  unsubscribed: [] as string[],
}));

vi.mock("@gpu", () => ({
  onDeviceLost: (cb: (e: DeviceLossEvent) => void) => {
    gpu.lostCbs.push(cb);
    return () => gpu.unsubscribed.push("lost");
  },
  onDeviceRestored: (cb: (d: unknown) => void) => {
    gpu.restoredCbs.push(cb);
    return () => gpu.unsubscribed.push("restored");
  },
}));

const { createDeviceRecovery } = await import("./deviceRecovery.ts");

function lossEvent(over: Partial<DeviceLossEvent> = {}): DeviceLossEvent {
  return { kind: "unknown", message: "reset", terminal: false, ...over };
}

function harness({ hasCanvas = true }: { hasCanvas?: boolean } = {}) {
  const order: string[] = [];
  const recovery = createDeviceRecovery({
    hasCanvas: () => hasCanvas,
    supersedeInFlightWarms: () => order.push("supersede"),
    teardownDeadResources: () => order.push("teardown"),
    rebuildOnDevice: async () => {
      order.push("rebuildOnDevice");
    },
    warmComposite: async () => {
      order.push("warm");
    },
    requestRender: () => order.push("requestRender"),
    stopLoop: () => order.push("stopLoop"),
    reportError: (message) => order.push(`reportError:${message}`),
    reportFault: () => order.push("reportFault"),
    postRecoveryFailed: (reason) => order.push(`recoveryFailed:${reason}`),
  });
  recovery.start();
  return { recovery, order };
}

describe("createDeviceRecovery", () => {
  beforeEach(() => {
    gpu.lostCbs.length = 0;
    gpu.restoredCbs.length = 0;
    gpu.unsubscribed.length = 0;
  });

  it("starts with the device live", () => {
    const { recovery } = harness();
    expect(recovery.isDeviceLost()).toBe(false);
  });

  it("a recoverable loss pauses + logs; restore rebuilds in order, then un-pauses", async () => {
    const { recovery, order } = harness();
    for (const cb of gpu.lostCbs) cb(lossEvent({ kind: "destroyed", message: "reset" }));
    expect(recovery.isDeviceLost()).toBe(true);
    expect(order).toEqual(["reportError:WebGPU device lost (destroyed): reset"]);
    order.length = 0;

    for (const cb of gpu.restoredCbs) cb({} as GPUDevice);
    await vi.waitFor(() => expect(recovery.isDeviceLost()).toBe(false));
    // The order is the contract: warm precedes the un-pause + repaint, so the first restored frame
    // neither stalls nor draws on a half-built device.
    expect(order).toEqual(["supersede", "teardown", "rebuildOnDevice", "warm", "requestRender"]);
  });

  it("a terminal loss halts the loop + reports failure, and never rebuilds", () => {
    const { recovery, order } = harness();
    for (const cb of gpu.lostCbs) cb(lossEvent({ message: "no GPUAdapter found", terminal: true }));
    expect(recovery.isDeviceLost()).toBe(true);
    expect(order).toEqual(["stopLoop", "recoveryFailed:no-adapter"]);
  });

  it("derives repeated-loss when the failure is not an adapter loss", () => {
    const { order } = harness();
    for (const cb of gpu.lostCbs)
      cb(lossEvent({ message: "device reset too often", terminal: true }));
    expect(order).toEqual(["stopLoop", "recoveryFailed:repeated-loss"]);
  });

  it("a pre-init restore (no canvas) rebuilds nothing", async () => {
    const { recovery, order } = harness({ hasCanvas: false });
    for (const cb of gpu.restoredCbs) cb({} as GPUDevice);
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(recovery.isDeviceLost()).toBe(false);
  });

  it("a failed rebuild is reported and leaves the loop paused (device stays lost)", async () => {
    const order: string[] = [];
    const recovery = createDeviceRecovery({
      hasCanvas: () => true,
      supersedeInFlightWarms: () => order.push("supersede"),
      teardownDeadResources: () => order.push("teardown"),
      rebuildOnDevice: async () => {
        throw new Error("install failed");
      },
      warmComposite: async () => {
        order.push("warm");
      },
      requestRender: () => order.push("requestRender"),
      stopLoop: () => {},
      reportError: () => {},
      reportFault: () => order.push("reportFault"),
      postRecoveryFailed: () => {},
    });
    recovery.start();
    for (const cb of gpu.lostCbs) cb(lossEvent());
    expect(recovery.isDeviceLost()).toBe(true);

    for (const cb of gpu.restoredCbs) cb({} as GPUDevice);
    await vi.waitFor(() => expect(order).toContain("reportFault"));
    expect(order).not.toContain("warm"); // the rebuild threw before the warm
    expect(order).not.toContain("requestRender"); // never un-paused
    expect(recovery.isDeviceLost()).toBe(true); // a broken rebuild must not resume painting
  });

  it("stop unsubscribes from both gpu/ signals and is idempotent", () => {
    const { recovery } = harness();
    recovery.stop();
    expect(gpu.unsubscribed).toEqual(["lost", "restored"]);
    recovery.stop(); // idempotent — the handle is cleared, no second unsubscribe
    expect(gpu.unsubscribed).toEqual(["lost", "restored"]);
  });
});

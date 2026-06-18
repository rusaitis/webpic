import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCapabilities,
  getDevice,
  installGpu,
  onDeviceLost,
  onDeviceRestored,
  requestGpu,
} from "./device.ts";

interface FakeGpu {
  readonly navigator: { gpu: GPU };
  resolveLost(info: GPUDeviceLostInfo): void;
  wasDestroyed(): boolean;
  adapterCount(): number;
}

// A navigator.gpu whose device exposes a manually-resolvable `lost` promise. Each
// requestDevice() mints a fresh device (mirroring recovery), so resolveLost always
// targets the most recently acquired device.
function makeFakeGpu(features: readonly string[] = []): FakeGpu {
  const set = new Set(features);
  let resolveLost: (info: GPUDeviceLostInfo) => void = () => {};
  let destroyed = false;
  let adapters = 0;

  const makeDevice = (): GPUDevice => {
    const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
      resolveLost = resolve;
    });
    return {
      features: { has: (name: string) => set.has(name) },
      limits: {
        maxTextureDimension2D: 16384,
        maxTextureDimension3D: 2048,
        maxBufferSize: 1,
        maxStorageBufferBindingSize: 1,
        maxComputeWorkgroupSizeX: 256,
        maxComputeInvocationsPerWorkgroup: 256,
      },
      lost,
      destroy: () => {
        destroyed = true;
      },
    } as unknown as GPUDevice;
  };

  const adapter = {
    features: { has: (name: string) => set.has(name) },
    info: { vendor: "test", architecture: "", device: "", description: "" },
    requestDevice: async () => makeDevice(),
  } as unknown as GPUAdapter;

  const gpu = {
    requestAdapter: async () => {
      adapters += 1;
      return adapter;
    },
  } as unknown as GPU;

  return {
    navigator: { gpu },
    resolveLost: (info) => resolveLost(info),
    wasDestroyed: () => destroyed,
    adapterCount: () => adapters,
  };
}

const lostInfo = (reason: GPUDeviceLostReason, message = ""): GPUDeviceLostInfo =>
  ({ reason, message }) as unknown as GPUDeviceLostInfo;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let dispose: (() => void) | undefined;

async function install(gpu: FakeGpu): Promise<InstalledHandle> {
  vi.stubGlobal("navigator", gpu.navigator);
  const handle = await installGpu();
  dispose = handle.dispose;
  return handle;
}
type InstalledHandle = Awaited<ReturnType<typeof installGpu>>;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

describe("requestGpu", () => {
  it("reports no-navigator-gpu when WebGPU is absent", async () => {
    vi.stubGlobal("navigator", {});
    const result = await requestGpu();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-navigator-gpu");
  });

  it("reports no-adapter when requestAdapter yields null", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => null } });
    const result = await requestGpu();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-adapter");
  });

  it("forwards powerPreference to requestAdapter", async () => {
    let seen: GPURequestAdapterOptions | undefined;
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: async (opts: GPURequestAdapterOptions) => {
          seen = opts;
          return null; // captured the options; a no-adapter return is fine here
        },
      },
    });
    await requestGpu({ powerPreference: "high-performance" });
    expect(seen?.powerPreference).toBe("high-performance");
  });
});

describe("installGpu", () => {
  it("installs the singleton and exposes device + capabilities", async () => {
    const handle = await install(makeFakeGpu(["timestamp-query"]));
    expect(getDevice()).toBe(handle.device);
    expect(getCapabilities().hasTimestampQuery).toBe(true);
  });

  it("rejects a second install before disposal", async () => {
    await install(makeFakeGpu());
    await expect(installGpu()).rejects.toThrow(/already installed/);
  });
});

describe("device.lost recovery", () => {
  it("recovers on real loss and notifies restored listeners", async () => {
    const gpu = makeFakeGpu();
    const handle = await install(gpu);
    const lost = vi.fn();
    const restored = vi.fn();
    onDeviceLost(lost);
    onDeviceRestored(restored);

    const firstDevice = handle.device;
    gpu.resolveLost(lostInfo("unknown", "reset"));
    await flush();

    expect(lost).toHaveBeenCalledWith({ kind: "unknown", message: "reset", terminal: false });
    expect(restored).toHaveBeenCalledTimes(1);
    expect(getDevice()).not.toBe(firstDevice);
    expect(gpu.adapterCount()).toBe(2); // install + recovery
  });

  it("trips the breaker after repeated rapid losses and stops re-acquiring", async () => {
    const gpu = makeFakeGpu();
    await install(gpu);
    const lost = vi.fn();
    onDeviceLost(lost);

    // Each loss mints a fresh device (recovery), so resolveLost targets the latest. Fire 3 rapid.
    for (let i = 0; i < 3; i++) {
      gpu.resolveLost(lostInfo("unknown", `loss ${i}`));
      await flush();
    }

    const events = lost.mock.calls.map((call) => call[0] as { terminal: boolean });
    // First two recovered (terminal:false); the third trips the breaker (terminal:true, no re-acquire).
    expect(events.filter((e) => !e.terminal)).toHaveLength(2);
    expect(events.filter((e) => e.terminal)).toHaveLength(1);
    expect(gpu.adapterCount()).toBe(3); // install + 2 recoveries; the terminal loss does not re-acquire
  });

  it("emits an intentional loss on dispose and does not recover", async () => {
    const gpu = makeFakeGpu();
    const handle = await install(gpu);
    const lost = vi.fn();
    const restored = vi.fn();
    onDeviceLost(lost);
    onDeviceRestored(restored);

    handle.dispose();
    expect(gpu.wasDestroyed()).toBe(true);
    expect(lost).toHaveBeenCalledWith({
      kind: "intentional",
      message: expect.any(String),
      terminal: false,
    });

    // The pending lost promise resolving afterward must not double-fire or recover.
    gpu.resolveLost(lostInfo("destroyed"));
    await flush();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(restored).not.toHaveBeenCalled();
  });

  it("stops notifying a listener after it unsubscribes", async () => {
    const gpu = makeFakeGpu();
    await install(gpu);
    const lost = vi.fn();
    const off = onDeviceLost(lost);
    off();
    gpu.resolveLost(lostInfo("unknown", "x"));
    await flush();
    expect(lost).not.toHaveBeenCalled();
  });
});

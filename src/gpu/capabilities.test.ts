import { describe, expect, it } from "vitest";
import { DESIRED_FEATURES, probeCapabilities, selectFeatures } from "./capabilities.ts";

// Structural stand-ins: the functions touch only `.features.has`, `.limits`, `.info`.
// The cast asserts we satisfy exactly that surface, nothing more.
function fakeAdapter(features: readonly string[]): GPUAdapter {
  const set = new Set(features);
  return {
    features: { has: (name: string) => set.has(name) },
    info: { vendor: "apple", architecture: "metal-3", device: "", description: "M2 Pro" },
  } as unknown as GPUAdapter;
}

function fakeDevice(features: readonly string[]): GPUDevice {
  const set = new Set(features);
  return {
    features: { has: (name: string) => set.has(name) },
    limits: {
      maxTextureDimension2D: 16384,
      maxTextureDimension3D: 2048,
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 134217728,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
    },
  } as unknown as GPUDevice;
}

describe("selectFeatures", () => {
  it("keeps only adapter-supported features", () => {
    expect(selectFeatures(fakeAdapter(["timestamp-query"]), DESIRED_FEATURES)).toEqual([
      "timestamp-query",
    ]);
  });

  it("defaults to DESIRED_FEATURES and returns all when supported", () => {
    const adapter = fakeAdapter(["timestamp-query", "shader-f16", "subgroups"]);
    expect(selectFeatures(adapter)).toEqual(["timestamp-query", "shader-f16", "subgroups"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(selectFeatures(fakeAdapter([]))).toEqual([]);
  });
});

describe("probeCapabilities", () => {
  it("reports enabled features from the device, not the adapter", () => {
    // Adapter advertises all three; only shader-f16 was actually requested on the device.
    const adapter = fakeAdapter(["timestamp-query", "shader-f16", "subgroups"]);
    const caps = probeCapabilities(adapter, fakeDevice(["shader-f16"]));
    expect(caps.hasShaderF16).toBe(true);
    expect(caps.hasTimestampQuery).toBe(false);
    expect(caps.hasSubgroups).toBe(false);
  });

  it("summarizes the limits the volume path gates on", () => {
    const caps = probeCapabilities(fakeAdapter([]), fakeDevice([]));
    expect(caps.limits.maxTextureDimension3D).toBe(2048);
    expect(caps.limits.maxBufferSize).toBe(268435456);
  });

  it("captures adapter identity for driver-pathology heuristics", () => {
    const caps = probeCapabilities(fakeAdapter([]), fakeDevice([]));
    expect(caps.adapter.vendor).toBe("apple");
    expect(caps.adapter.description).toBe("M2 Pro");
  });
});

// WebGPU capability probing: feature flags + the handful of device limits the
// raymarcher and compute kernels gate on. Pure and synchronous — `device.ts` and
// `profiler.ts` both consume it. No singletons, so it is trivially testable.

// Features webpic opportunistically requests at device creation. Kept as one tuple
// so the requested set and the union of probed flags stay in a single place.
export const DESIRED_FEATURES = [
  "timestamp-query",
  "shader-f16",
  "subgroups",
] as const satisfies readonly GPUFeatureName[];

export interface GpuLimitsSummary {
  readonly maxTextureDimension2D: number;
  readonly maxTextureDimension3D: number; // gates 256³/512³ volume textures
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxComputeWorkgroupSizeX: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
}

export interface GpuAdapterSummary {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

export interface GpuCapabilities {
  readonly hasTimestampQuery: boolean;
  readonly hasShaderF16: boolean;
  readonly hasSubgroups: boolean;
  readonly limits: GpuLimitsSummary;
  readonly adapter: GpuAdapterSummary;
}

/**
 * Intersection of `desired` with the adapter's supported features — the set safe
 * to hand `requestDevice({ requiredFeatures })`, since requesting a feature the
 * adapter lacks rejects the call.
 */
export function selectFeatures(
  adapter: GPUAdapter,
  desired: readonly GPUFeatureName[] = DESIRED_FEATURES,
): GPUFeatureName[] {
  return desired.filter((name) => adapter.features.has(name));
}

/**
 * Snapshot the device's enabled features + key limits into a plain readonly struct
 * (don't leak the live host bindings). Probes `device.features`, not
 * `adapter.features`: a feature is only usable once requested at device creation.
 */
export function probeCapabilities(adapter: GPUAdapter, device: GPUDevice): GpuCapabilities {
  const { features, limits } = device;
  const { info } = adapter;
  return {
    hasTimestampQuery: features.has("timestamp-query"),
    hasShaderF16: features.has("shader-f16"),
    hasSubgroups: features.has("subgroups"),
    limits: {
      maxTextureDimension2D: limits.maxTextureDimension2D,
      maxTextureDimension3D: limits.maxTextureDimension3D,
      maxBufferSize: limits.maxBufferSize,
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
      maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
    },
    adapter: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    },
  };
}

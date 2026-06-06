// WebGPU capability probing: feature flags + the handful of device limits the
// raymarcher and compute kernels gate on. Pure and synchronous — `device.ts` and
// `profiler.ts` both consume it. No singletons, so it is trivially testable.

// Features webpic opportunistically requests at device creation. Kept as one tuple
// so the requested set and the union of probed flags stay in a single place.
// `float32-filterable` lets the volume texture be R32F with linear (trilinear) sampling —
// f16 trilinear is unreliable on Metal (device loss), so full-float is the stable path.
// shader-f16/subgroups are intentionally NOT requested: nothing consumes them, and an
// enabled-but-unused feature is a needless device-creation risk surface on some drivers.
export const DESIRED_FEATURES = [
  "timestamp-query",
  "float32-filterable",
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
  readonly hasFloat32Filterable: boolean; // R32F linear (trilinear) sampling — the volume texture path
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
    hasFloat32Filterable: features.has("float32-filterable"),
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

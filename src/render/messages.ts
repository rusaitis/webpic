import type { ColorScale, WindowLevel } from "@schema/colormap.ts";
import type { Vec3 } from "@schema/types.ts";
import type { SliceAxis } from "./sliceScene.ts";

export type { WindowLevel };

// Typed protocol for the OffscreenCanvas render worker. Discriminated unions both
// ways; `requestId` correlates a response to its request and pre-stages the
// cancellation plumbing the fuller StoreToRender/RenderToStore protocol will need.
// Transferables (OffscreenCanvas, field/pixel ArrayBuffer) move by transfer, never clone.

// A computed scalar field, serialized for transfer to the worker: the typed array can't
// cross `postMessage` as a view, so it goes as a raw `buffer` + a `dtype` tag the worker
// reinterprets (a buffer read as the wrong type silently corrupts the field).
export interface SliceFieldPayload {
  readonly buffer: ArrayBuffer;
  readonly dtype: "f32" | "f64";
  readonly shape: readonly number[];
}

// Orbit camera pose on the wire (DESIGN §443 StoreToRender). Restates the store-side CameraPose
// (store/camera.ts) — the store can't import render. Vec3 itself is shared from @schema.
export interface CameraPose {
  readonly target: Vec3;
  readonly azimuth: number;
  readonly elevation: number;
  readonly distance: number;
}

export type RenderWorkerRequest =
  | {
      readonly kind: "init";
      readonly requestId: number;
      readonly canvas: OffscreenCanvas;
      // Logical (CSS) pixel size; the worker scales the drawing buffer by devicePixelRatio. An
      // OffscreenCanvas has no window.devicePixelRatio, so it must ride the wire from the main thread.
      readonly width: number;
      readonly height: number;
      readonly devicePixelRatio: number;
    }
  | { readonly kind: "renderFrame"; readonly requestId: number }
  // Viewport changed (window resize / DPR change). Logical size + DPR; the worker re-sizes the
  // swapchain, fixes the perspective aspect, and repaints.
  | {
      readonly kind: "resize";
      readonly requestId: number;
      readonly width: number;
      readonly height: number;
      readonly devicePixelRatio: number;
    }
  // Build or rebuild one layer's scene (instance-first composite). Transfers the field buffer;
  // `layerKind` is the renderable kind (the message `kind` is the discriminant). Kind-specific
  // params are optional — omitted ones fall back to the scene factory defaults.
  | {
      readonly kind: "upsertLayer";
      readonly requestId: number;
      readonly id: string;
      readonly layerKind: "slice" | "volume";
      readonly field: SliceFieldPayload;
      readonly colormap: string;
      readonly scale: ColorScale;
      readonly opacity: number;
      readonly windowLevel?: WindowLevel;
      readonly axis?: SliceAxis;
      readonly position?: number;
      readonly steps?: number;
      readonly density?: number;
    }
  | { readonly kind: "removeLayer"; readonly requestId: number; readonly id: string }
  // Cheap reorder/visibility/opacity over the full ordered list — no field transfer.
  | {
      readonly kind: "setComposite";
      readonly requestId: number;
      readonly order: readonly {
        readonly id: string;
        readonly visible: boolean;
        readonly opacity: number;
      }[];
    }
  // Live per-layer color update — colormap + window/level + scale (one layer's ColormapBinding,
  // resolved to the layer it draws). No field buffer, so dragging never re-transfers the volume;
  // the worker keys scenes by layer id, so the wire is layer-addressed (not binding-addressed).
  | {
      readonly kind: "setLayerColormap";
      readonly requestId: number;
      readonly id: string;
      readonly colormap: string;
      readonly windowLevel: WindowLevel;
      readonly scale: ColorScale;
    }
  // Camera pose update — high-frequency, delta-only (DESIGN §443); the worker re-applies + repaints.
  | {
      readonly kind: "setCameraPose";
      readonly requestId: number;
      readonly pose: CameraPose;
    }
  // Diagnostics: force sustained every-frame repaints so the GPU timer yields a live stream (the
  // exit-gate workload). Off by default — timing is sampled only while continuous, so on-demand
  // interactive frames skip the per-frame GPU sync.
  | { readonly kind: "setContinuous"; readonly requestId: number; readonly continuous: boolean };

export type RenderWorkerResponse =
  | { readonly kind: "ready"; readonly requestId: number }
  | {
      readonly kind: "frame";
      readonly requestId: number;
      readonly width: number;
      readonly height: number;
      readonly pixels: ArrayBuffer; // RGBA8, row-major
    }
  // Per-frame GPU time (DESIGN §444 RenderToStore). `clock` labels the source — timestamp-query is
  // GPU-only; wallclock includes JS/queue latency and must not masquerade as the pure-GPU number.
  | {
      readonly kind: "frameTiming";
      readonly gpuTimeMs: number;
      readonly clock: "timestamp" | "wallclock";
    }
  | { readonly kind: "error"; readonly requestId: number; readonly message: string }
  // Terminal GPU failure: the device was lost and the recovery circuit-breaker stopped re-acquiring
  // (repeated rapid losses) or no adapter is available. The render loop is halted; the app surfaces a
  // "reload" state rather than the silent spiral that would otherwise crash the GPU process.
  | {
      readonly kind: "gpuRecoveryFailed";
      readonly requestId: number;
      readonly reason: "no-adapter" | "repeated-loss";
      readonly message: string;
    };

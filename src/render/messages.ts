import type { Vec3 } from "@schema/types.ts";
import type { SliceAxis } from "./sliceScene.ts";

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

// Value→color window (DESIGN M2.3): the canonical range form, not a separate min/max.
export interface WindowLevel {
  readonly center: number;
  readonly width: number;
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
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "renderFrame"; readonly requestId: number }
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
  // Live window/level update — no field buffer, so dragging never re-transfers the volume.
  | {
      readonly kind: "setWindowLevel";
      readonly requestId: number;
      readonly windowLevel: WindowLevel;
    }
  // Camera pose update — high-frequency, delta-only (DESIGN §443); the worker re-applies + repaints.
  | {
      readonly kind: "setCameraPose";
      readonly requestId: number;
      readonly pose: CameraPose;
    };

export type RenderWorkerResponse =
  | { readonly kind: "ready"; readonly requestId: number }
  | {
      readonly kind: "frame";
      readonly requestId: number;
      readonly width: number;
      readonly height: number;
      readonly pixels: ArrayBuffer; // RGBA8, row-major
    }
  | { readonly kind: "error"; readonly requestId: number; readonly message: string };

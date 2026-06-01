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

export type RenderWorkerRequest =
  | {
      readonly kind: "init";
      readonly requestId: number;
      readonly canvas: OffscreenCanvas;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "renderFrame"; readonly requestId: number }
  | {
      readonly kind: "showSlice";
      readonly requestId: number;
      readonly field: SliceFieldPayload;
      readonly axis: SliceAxis;
      readonly position: number;
      readonly colormap: string;
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

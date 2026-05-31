// Typed protocol for the OffscreenCanvas render worker. Discriminated unions both
// ways; `requestId` correlates a response to its request and pre-stages the
// cancellation plumbing the fuller StoreToRender/RenderToStore protocol will need.
// Transferables (OffscreenCanvas, pixel ArrayBuffer) move by transfer, never clone.

export type RenderWorkerRequest =
  | {
      readonly kind: "init";
      readonly requestId: number;
      readonly canvas: OffscreenCanvas;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "renderFrame"; readonly requestId: number };

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

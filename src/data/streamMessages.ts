import type { DataHandle } from "./readers/_protocols.ts";

// Time-series streaming wire protocol (M2.10a). Lives in the `data` layer on purpose: the data
// worker (`workers`) and the render worker (`render`) both need these types, and the DAG forbids
// `workers → render` (and `render → workers`) — but both may import `data`. Two surfaces:
//   • main → data worker  (DataStreamRequest / DataStreamResponse), alongside the cache protocol
//   • data worker → render worker, over a private MessagePort (StreamStepMessage)
// All field buffers move by transfer, never clone.

// A computed scalar field on the wire — structurally identical to render's SliceFieldPayload, so the
// render worker decodes it with the same path. The typed array can't cross as a view; it goes as a
// raw `buffer` + a `dtype` tag the worker reinterprets.
export interface StreamFieldPayload {
  readonly buffer: ArrayBuffer;
  readonly dtype: "f32" | "f64";
  readonly shape: readonly number[];
}

// data worker → render worker (over the paired port): swap one layer's volume to a new timestep's
// scalar field. `id` is the render layer the field belongs to; the field buffer is transferred.
export interface StreamStepMessage {
  readonly kind: "streamStep";
  readonly id: string;
  readonly step: number;
  readonly field: StreamFieldPayload;
}

// main → data worker. `open` carries the render port (transferred) + the layer the worker streams
// into + the active field whose scalar it computes off-main. `reopen` swaps the source onto a new
// handle (dataset switch) reusing the already-paired port + layer — it re-announces the new timestep
// domain via `opened`. `setCursor` drives the ring; the worker streams the cursor step once decoded.
// `setActiveField` re-points the computed quantity.
export type DataStreamRequest =
  | {
      readonly kind: "open";
      readonly requestId: number;
      readonly handle: DataHandle;
      readonly activeField: string;
      readonly layerId: string;
      readonly port: MessagePort;
    }
  | {
      readonly kind: "reopen";
      readonly requestId: number;
      readonly handle: DataHandle;
      readonly activeField: string;
    }
  | { readonly kind: "setActiveField"; readonly requestId: number; readonly field: string }
  | { readonly kind: "setCursor"; readonly requestId: number; readonly step: number }
  | { readonly kind: "streamDispose"; readonly requestId: number };

// data worker → main. `opened` reports the timestep domain (→ store.setAvailableSteps); `stepLoaded`
// acks a decoded+streamed step (a future loading indicator); `streamError` surfaces a read failure.
export type DataStreamResponse =
  | { readonly kind: "opened"; readonly steps: readonly number[] }
  | { readonly kind: "stepLoaded"; readonly step: number }
  | { readonly kind: "streamError"; readonly message: string };

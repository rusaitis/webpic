import type { FieldArray } from "@containers/field_dataset.ts";
import { transferableBuffer } from "@schema/transfer.ts";
import type { DataHandle } from "./readers/_protocols.ts";

// Time-series streaming wire protocol. Lives in the `data` layer on purpose: the data worker and
// the render worker both need these types but can't import each other — both may import `data`.
// Two surfaces:
//   • main → data worker  (DataStreamRequest / DataStreamResponse), alongside the cache protocol
//   • data worker → render worker, over a private MessagePort (StreamStepMessage)
// All field buffers move by transfer, never clone.

// A computed scalar field on the wire, for both worker protocols (render's `upsertLayer` and the data
// worker's `streamStep`). The typed array can't cross as a view; it goes as a raw `buffer` + a `dtype`
// tag the receiver reinterprets — a buffer read as the wrong type silently corrupts the field.
export interface FieldPayload {
  readonly buffer: ArrayBuffer;
  readonly dtype: "f32" | "f64";
  readonly shape: readonly number[];
}

// The dtype tag is the rule both senders must agree on, so it is derived here rather than at each wire.
export function fieldPayload(field: FieldArray): FieldPayload {
  return {
    buffer: transferableBuffer(field.data),
    dtype: field.data instanceof Float64Array ? "f64" : "f32",
    shape: field.shape,
  };
}

// data worker → render worker (over the paired port): swap one layer's volume to a new timestep's
// scalar field. `id` is the render layer the field belongs to; the field buffer is transferred.
export interface StreamStepMessage {
  readonly kind: "streamStep";
  readonly id: string;
  readonly step: number;
  readonly field: FieldPayload;
}

// main → data worker. `open` carries the render port (transferred) + the layer the worker streams
// into + the active field whose scalar it computes off-main. `reopen` swaps the source onto a new
// handle (dataset switch) reusing the already-paired port + layer — it re-announces the new timestep
// domain via `opened`. `setCursor` drives the ring; the worker streams the cursor step once decoded.
// `setActiveField` re-points the computed quantity.
export type DataStreamRequest =
  | {
      readonly kind: "open";
      readonly handle: DataHandle;
      readonly activeField: string;
      readonly layerId: string;
      readonly port: MessagePort;
    }
  | {
      readonly kind: "reopen";
      readonly handle: DataHandle;
      readonly activeField: string;
    }
  | { readonly kind: "setActiveField"; readonly field: string }
  | { readonly kind: "setCursor"; readonly step: number }
  // Dev-mode perf HUD: while active the worker self-reports its heap + last read time (~1 Hz).
  | { readonly kind: "setPerfActive"; readonly active: boolean };

// data worker → main. `opened` reports the timestep domain (→ store.setAvailableSteps); `stepLoaded`
// acks a decoded+streamed step (a future loading indicator); `streamError` surfaces a read failure.
export type DataStreamResponse =
  | { readonly kind: "opened"; readonly steps: readonly number[] }
  | { readonly kind: "stepLoaded"; readonly step: number }
  | { readonly kind: "streamError"; readonly message: string }
  // Dev-mode perf HUD self-report: the data worker's JS heap (null off-Chrome) + the wall-clock
  // duration of its last field read (null before the first read).
  | {
      readonly kind: "perfSample";
      readonly heapBytes: number | null;
      readonly lastReadMs: number | null;
    };

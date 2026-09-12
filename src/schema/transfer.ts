// The one place webpic narrows `ArrayBufferView.buffer` for a `postMessage` transfer.
//
// TS types `.buffer` as `ArrayBufferLike`, which also admits `SharedArrayBuffer` — untransferable,
// and a structured-clone of a 64 MiB field instead of a move. webpic allocates no shared memory
// (SharedArrayBuffer needs COOP/COEP headers it does not ship), so every view it posts is backed by
// a plain ArrayBuffer. Callers assert that fact by name rather than re-deriving the cast.

/** The view's backing buffer, typed for the transfer list. The view must own an unshared buffer. */
export function transferableBuffer(view: ArrayBufferView): ArrayBuffer {
  return view.buffer as ArrayBuffer;
}

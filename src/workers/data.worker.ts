import { computeField } from "@compute";
import type { FieldArray } from "@containers/field_dataset.ts";
import { readHeapBytes } from "@containers/perf_probe.ts";
import type { DataCacheRequest, DataCacheResponse } from "@data";
import { isNotFound, resolveDir, splitPath } from "@data/opfs.ts";
import type { DataHandle, SimulationReader } from "@data/readers/_protocols.ts";
import { openSimulation } from "@data/readers/_registry.ts";
import { registerSyntheticReader } from "@data/readers/synthetic.ts";
import { createStreamRing, type StreamRing } from "@data/stream.ts";
import {
  type DataStreamRequest,
  type DataStreamResponse,
  fieldPayload,
  type StreamStepMessage,
} from "@data/streamMessages.ts";

// The data worker owns all off-main data I/O (DESIGN §Package shape): OPFS writes and time-series
// streaming. On `open` it resolves a reader and reports the timestep domain; on `setCursor` it drives
// a ring buffer (data/stream.ts) that reads + computes the scalar off the main thread and transfers
// it straight to the render worker over a paired MessagePort, so scrubbing never stalls the UI.
// OPFS writes live here because createSyncAccessHandle() is worker-only in every engine — main reads
// async and dispatches writes to us. DESIGN §Caching.

// This chunk typechecks under the WebWorker lib (tsconfig.worker.json), so `self` is the worker
// global; the annotation just pins the message types on the wire.
const context: {
  onmessage: ((event: MessageEvent<DataCacheRequest | DataStreamRequest>) => void) | null;
  postMessage(message: DataCacheResponse | DataStreamResponse): void;
} = self;

async function cacheWrite(
  request: Extract<DataCacheRequest, { kind: "cacheWrite" }>,
): Promise<void> {
  const { dirs, name } = splitPath(request.path);
  const dir = await resolveDir(dirs, { create: true });
  if (dir === undefined)
    throw new Error(`cacheWrite: could not open the cache directory for ${request.path}`);
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const handle = await fileHandle.createSyncAccessHandle();
  try {
    handle.truncate(0); // drop any stale tail when overwriting a larger value
    handle.write(new Uint8Array(request.bytes), { at: 0 });
    handle.flush();
  } finally {
    handle.close(); // release the file's exclusive lock even if write throws
  }
}

async function cacheRemove(
  request: Extract<DataCacheRequest, { kind: "cacheRemove" }>,
): Promise<void> {
  const { dirs, name } = splitPath(request.path);
  const dir = await resolveDir(dirs);
  if (dir === undefined) return; // path already gone — idempotent
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

// Serialize cache writes across tabs: the sync handle needs exclusive file access, and the web-lock
// keeps two tabs from racing the same cache (losing tab queues).
function applyCacheRequest(request: DataCacheRequest): Promise<void> {
  return navigator.locks.request("webpic-cache", { mode: "exclusive" }, async () => {
    switch (request.kind) {
      case "cacheWrite":
        return cacheWrite(request);
      case "cacheRemove":
        return cacheRemove(request);
      default: {
        const unreachable: never = request;
        throw new Error(`unknown request: ${JSON.stringify(unreachable)}`);
      }
    }
  });
}

let reader: SimulationReader | undefined;
let handle: DataHandle | undefined;
let activeField = "|B|"; // the scalar quantity computed off-main; re-pointed by setActiveField
let layerId: string | undefined; // the render layer streamed fields address
let port: MessagePort | undefined; // private channel to the render worker (transfer target)
let ring: StreamRing | undefined;
let steps: readonly number[] = [];
let cursor: number | null = null; // last requested step — re-streamed on a field switch
let isReaderRegistered = false;

// Dev perf HUD self-report — dormant unless setPerfActive(true). The worker has no frame loop, so it
// posts its heap + last read time on a ~1 Hz timer while active.
let perfTimer: ReturnType<typeof setInterval> | undefined;
let lastReadMs: number | null = null; // wall-clock of the most recent readStep

function streamError(error: unknown, step?: number): void {
  const where = step === undefined ? "" : `step ${step}: `;
  context.postMessage({
    kind: "streamError",
    message: where + (error instanceof Error ? error.message : String(error)),
  });
}

// Read one step + compute its scalar — the slow work, run here off the main thread. The read and the
// compute both honor the abort signal (the ring cancels work the cursor scrubbed past); the TS backend
// resolves synchronously, but the async dispatcher lets a GPU backend cancel mid-compute.
async function readStep(step: number, signal: AbortSignal): Promise<FieldArray> {
  if (reader === undefined || handle === undefined) throw new Error("stream read before open");
  const startMs = performance.now();
  const dataset = await reader.readTimestep(handle, step, { signal });
  const field = computeField(activeField, dataset, signal); // takes a plain string (validated upstream)
  lastReadMs = performance.now() - startMs; // perf HUD: read+compute wall-clock (completed reads only)
  return field;
}

// Transfer a decoded scalar to the render worker over the paired port — the buffer detaches here, so
// the ring re-reads this step on scrub-back. Also acks the load to main (a future loading indicator).
function streamToRender(step: number, field: FieldArray): void {
  if (port === undefined || layerId === undefined) return;
  const payload = fieldPayload(field);
  const message: StreamStepMessage = { kind: "streamStep", id: layerId, step, field: payload };
  port.postMessage(message, [payload.buffer]);
  context.postMessage({ kind: "stepLoaded", step });
}

function buildRing(): void {
  ring?.dispose();
  ring = createStreamRing<FieldArray>({
    steps,
    readStep,
    onDisplay: streamToRender,
    onError: (step, error) => streamError(error, step),
  });
}

// Resolve the reader for the current `handle`, announce its timestep domain, and (re)build the ring.
// Shared by open (first source) and reopen (dataset switch) — the latter keeps the live port + layer.
// No initial setCursor: main already rendered step 0 via upsertLayer (the synthetic step 0). The first
// stream is the user's first scrub.
async function resolveReader(h: DataHandle): Promise<void> {
  if (!isReaderRegistered) {
    registerSyntheticReader(); // synthetic-only streaming; real readers register here alongside it
    isReaderRegistered = true;
  }
  reader = await openSimulation(h);
  steps = await reader.availableTimesteps(h);
  context.postMessage({ kind: "opened", steps });
  buildRing();
}

async function openStream(request: Extract<DataStreamRequest, { kind: "open" }>): Promise<void> {
  handle = request.handle;
  activeField = request.activeField;
  layerId = request.layerId;
  port?.close();
  port = request.port;
  await resolveReader(request.handle);
}

// Swap the source onto a new handle (dataset switch) — same port + layer, fresh reader/domain. The
// cursor resets: the new domain may not contain the old step, and main re-seeded step 0 on the swap.
async function reopenStream(
  request: Extract<DataStreamRequest, { kind: "reopen" }>,
): Promise<void> {
  handle = request.handle;
  activeField = request.activeField;
  cursor = null;
  await resolveReader(request.handle);
}

function switchActiveField(request: Extract<DataStreamRequest, { kind: "setActiveField" }>): void {
  activeField = request.field;
  if (ring === undefined) return; // pre-open: the new field is picked up when the ring is built
  // The ring caches scalars computed for the previous field — rebuild to drop them, then re-stream
  // the scrubbed step under the new field (main's field-switch upsert renders step 0; this corrects).
  buildRing();
  if (cursor !== null) ring?.setCursor(cursor);
}

function moveCursor(request: Extract<DataStreamRequest, { kind: "setCursor" }>): void {
  cursor = request.step;
  ring?.setCursor(request.step);
}

// Dev perf HUD: start/stop the ~1 Hz self-report (heap + last read time). Idempotent — clears any
// prior timer first, so a repeated enable doesn't stack intervals.
function setPerfActive(active: boolean): void {
  if (perfTimer !== undefined) {
    clearInterval(perfTimer);
    perfTimer = undefined;
  }
  if (!active) return;
  const post = (): void =>
    context.postMessage({ kind: "perfSample", heapBytes: readHeapBytes(), lastReadMs });
  post(); // first sample immediately, then on the interval
  perfTimer = setInterval(post, 1000);
}

context.onmessage = (event) => {
  const request = event.data;
  switch (request.kind) {
    case "cacheWrite":
    case "cacheRemove":
      applyCacheRequest(request)
        .then(() => context.postMessage({ kind: "ok", requestId: request.requestId }))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          context.postMessage({ kind: "error", requestId: request.requestId, message });
        });
      return;
    case "open":
      void openStream(request).catch((error: unknown) => streamError(error));
      return;
    case "reopen":
      void reopenStream(request).catch((error: unknown) => streamError(error));
      return;
    case "setActiveField":
      switchActiveField(request);
      return;
    case "setCursor":
      moveCursor(request);
      return;
    case "setPerfActive":
      setPerfActive(request.active);
      return;
    default: {
      const unreachable: never = request;
      streamError(new Error(`unknown request: ${JSON.stringify(unreachable)}`));
    }
  }
};

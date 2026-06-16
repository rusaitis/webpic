import { computeField } from "@compute";
import type { FieldArray } from "@containers/field_dataset.ts";
import type { DataCacheRequest, DataCacheResponse } from "@data";
import type { DataHandle, SimulationReader } from "@data/readers/_protocols.ts";
import { openSimulation } from "@data/readers/_registry.ts";
import { registerSyntheticReader } from "@data/readers/synthetic.ts";
import { createStreamRing, type StreamRing } from "@data/stream.ts";
import type {
  DataStreamRequest,
  DataStreamResponse,
  StreamFieldPayload,
  StreamStepMessage,
} from "@data/streamMessages.ts";

// The data worker owns all off-main data I/O (DESIGN §Package shape): OPFS writes (below) and time-series
// streaming. On `open` it resolves a reader and reports the timestep domain; on `setCursor` it drives
// a ring buffer (data/stream.ts) that reads + computes the scalar OFF the main thread and transfers it
// straight to the render worker over a paired MessagePort (no main hop), so scrubbing never stalls the
// UI. The reader/compute imports run only in this worker chunk.
//
// OPFS writes: createSyncAccessHandle() is the synchronous fast path and is worker-only in every
// engine (and the only write path at all on Safari <26). The main thread reads async and dispatches
// writes here. See docs/DESIGN.md §Caching.

// Worker-scope view of `self` (the DOM lib types it as Window); narrow to the
// dedicated-worker surface, same pattern as render/worker.ts.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<DataCacheRequest | DataStreamRequest>) => void) | null;
  postMessage(message: DataCacheResponse | DataStreamResponse): void;
};

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function splitPath(path: string): { dirs: readonly string[]; name: string } {
  const segments = path.split("/");
  const name = segments.pop();
  if (name === undefined || name === "") throw new Error(`invalid cache path: ${path}`);
  return { dirs: segments, name };
}

async function resolveDir(
  dirs: readonly string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> {
  let dir = await navigator.storage.getDirectory();
  for (const segment of dirs) {
    try {
      dir = await dir.getDirectoryHandle(segment, { create });
    } catch (error) {
      if (!create && isNotFound(error)) return undefined;
      throw error;
    }
  }
  return dir;
}

async function cacheWrite(
  request: Extract<DataCacheRequest, { kind: "cacheWrite" }>,
): Promise<void> {
  const { dirs, name } = splitPath(request.path);
  const dir = await resolveDir(dirs, true);
  if (dir === undefined) throw new Error(`could not open cache directory for ${request.path}`);
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
  const dir = await resolveDir(dirs, false);
  if (dir === undefined) return; // path already gone — idempotent
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

// Serialize cache writes across tabs: the sync handle needs exclusive file access, and the web-lock
// keeps two tabs from racing the same cache (losing tab queues).
function handleCache(request: DataCacheRequest): Promise<void> {
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
let readerRegistered = false;

function streamError(error: unknown, step?: number): void {
  const where = step === undefined ? "" : `step ${step}: `;
  ctx.postMessage({
    kind: "streamError",
    message: where + (error instanceof Error ? error.message : String(error)),
  });
}

// Read one step + compute its scalar — the slow work, run here off the main thread. The read and the
// compute both honor the abort signal (the ring cancels work the cursor scrubbed past); the TS backend
// resolves synchronously, but the async dispatcher lets a GPU backend cancel mid-compute.
async function readStep(step: number, signal: AbortSignal): Promise<FieldArray> {
  if (reader === undefined || handle === undefined) throw new Error("stream read before open");
  const dataset = await reader.readTimestep(handle, step, { signal });
  return computeField(activeField, dataset, signal); // computeField takes a plain string (validated upstream)
}

// Transfer a decoded scalar to the render worker over the paired port — the buffer detaches here, so
// the ring re-reads this step on scrub-back. Also acks the load to main (a future loading indicator).
function streamToRender(step: number, field: FieldArray): void {
  if (port === undefined || layerId === undefined) return;
  const dtype: StreamFieldPayload["dtype"] = field.data instanceof Float64Array ? "f64" : "f32";
  const buffer = field.data.buffer as ArrayBuffer; // computeField output is offset-0 — safe to transfer
  const payload: StreamFieldPayload = { buffer, dtype, shape: field.shape };
  const message: StreamStepMessage = { kind: "streamStep", id: layerId, step, field: payload };
  port.postMessage(message, [buffer]);
  ctx.postMessage({ kind: "stepLoaded", step });
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
  if (!readerRegistered) {
    registerSyntheticReader(); // synthetic-only for v0.1 streaming; real readers register here later
    readerRegistered = true;
  }
  reader = await openSimulation(h);
  steps = await reader.availableTimesteps(h);
  ctx.postMessage({ kind: "opened", steps });
  buildRing();
}

async function handleOpen(request: Extract<DataStreamRequest, { kind: "open" }>): Promise<void> {
  handle = request.handle;
  activeField = request.activeField;
  layerId = request.layerId;
  port?.close();
  port = request.port;
  await resolveReader(request.handle);
}

// Swap the source onto a new handle (dataset switch) — same port + layer, fresh reader/domain. The
// cursor resets: the new domain may not contain the old step, and main re-seeded step 0 on the swap.
async function handleReopen(
  request: Extract<DataStreamRequest, { kind: "reopen" }>,
): Promise<void> {
  handle = request.handle;
  activeField = request.activeField;
  cursor = null;
  await resolveReader(request.handle);
}

function handleSetActiveField(req: Extract<DataStreamRequest, { kind: "setActiveField" }>): void {
  activeField = req.field;
  if (ring === undefined) return; // pre-open: the new field is picked up when the ring is built
  // The ring caches scalars computed for the previous field — rebuild to drop them, then re-stream
  // the scrubbed step under the new field (main's field-switch upsert renders step 0; this corrects).
  buildRing();
  if (cursor !== null) ring?.setCursor(cursor);
}

function handleSetCursor(req: Extract<DataStreamRequest, { kind: "setCursor" }>): void {
  cursor = req.step;
  ring?.setCursor(req.step);
}

function disposeStream(): void {
  ring?.dispose();
  ring = undefined;
  port?.close();
  port = undefined;
  reader = undefined;
  handle = undefined;
  cursor = null;
}

ctx.onmessage = (event) => {
  const request = event.data;
  switch (request.kind) {
    case "cacheWrite":
    case "cacheRemove":
      handleCache(request)
        .then(() => ctx.postMessage({ kind: "ok", requestId: request.requestId }))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          ctx.postMessage({ kind: "error", requestId: request.requestId, message });
        });
      return;
    case "open":
      void handleOpen(request).catch((error: unknown) => streamError(error));
      return;
    case "reopen":
      void handleReopen(request).catch((error: unknown) => streamError(error));
      return;
    case "setActiveField":
      handleSetActiveField(request);
      return;
    case "setCursor":
      handleSetCursor(request);
      return;
    case "streamDispose":
      disposeStream();
      return;
    default: {
      const unreachable: never = request;
      streamError(new Error(`unknown request: ${JSON.stringify(unreachable)}`));
    }
  }
};

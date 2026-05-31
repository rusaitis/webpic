import type { DataCacheRequest, DataCacheResponse } from "@data";

// Owns OPFS writes: createSyncAccessHandle() is the synchronous fast path and is
// worker-only in every engine (and the only write path at all on Safari <26). The
// main thread reads async and dispatches writes here. Type-only @data import keeps
// the data-layer runtime out of this worker chunk. See docs/DESIGN.md §Caching.

// Worker-scope view of `self` (the DOM lib types it as Window); narrow to the
// dedicated-worker surface, same pattern as render/worker.ts.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<DataCacheRequest>) => void) | null;
  postMessage(message: DataCacheResponse): void;
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

function handle(request: DataCacheRequest): Promise<void> {
  // Serialize writes across tabs: the sync handle needs exclusive file access, and
  // the web-lock keeps two tabs from racing the same cache (losing tab queues).
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

ctx.onmessage = (event) => {
  const request = event.data;
  handle(request)
    .then(() => ctx.postMessage({ kind: "ok", requestId: request.requestId }))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.postMessage({ kind: "error", requestId: request.requestId, message });
    });
};

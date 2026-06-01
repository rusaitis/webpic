import { SCHEMA_VERSION } from "@schema/version.ts";

// OPFS-backed key→bytes cache. Reads run async on the main thread; writes are
// dispatched to data.worker.ts, which holds the createSyncAccessHandle() fast path
// (worker-only in every engine) under an exclusive web-lock for multi-tab safety.
// See docs/DESIGN.md §Caching. LRU eviction + an IndexedDB fallback are planned for
// the first consumer that needs them (the Zarr field cache).

export interface CacheKeyParts {
  /** Cache namespace, e.g. "fields" | "calibration". Filesystem-safe: [a-z0-9_-]. */
  readonly namespace: string;
  /** Identity tuple, stringified — e.g. (reader, sourceUrl, step, field, chunk). */
  readonly parts: readonly string[];
}

/** Raw byte store behind the cache. The OPFS impl is the default; Memory is for tests + non-OPFS fallback. */
export interface CacheStore {
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  list(): Promise<ReadonlyArray<{ readonly path: string; readonly size: number }>>;
  dispose(): void;
}

// Write protocol to data.worker.ts. Declared here (not in @workers) because `data`
// must not import `workers`; the worker imports these types from @data instead.
export type DataCacheRequest =
  | {
      readonly kind: "cacheWrite";
      readonly requestId: number;
      readonly path: string;
      readonly bytes: ArrayBuffer;
    }
  | { readonly kind: "cacheRemove"; readonly requestId: number; readonly path: string };

export type DataCacheResponse =
  | { readonly kind: "ok"; readonly requestId: number }
  | { readonly kind: "error"; readonly requestId: number; readonly message: string };

export interface Cache {
  get(key: CacheKeyParts): Promise<Uint8Array | undefined>;
  put(key: CacheKeyParts, bytes: Uint8Array): Promise<void>;
  /** In-memory manifest lookup — no I/O. */
  has(key: CacheKeyParts): boolean;
  delete(key: CacheKeyParts): Promise<void>;
  dispose(): void;
}

export interface CacheOptions {
  /** Override the backend (inject MemoryCacheStore in tests). */
  readonly store?: CacheStore;
  /** Override worker creation; defaults to spawning data.worker.ts. */
  readonly spawnWorker?: () => Worker;
  /** Soft byte budget; tracked now, enforced once LRU lands. */
  readonly budgetBytes?: number;
}

export const DEFAULT_BUDGET_BYTES = 1 << 30; // 1 GiB

const NAMESPACE_PATTERN = /^[a-z0-9_-]+$/;

// FNV-1a, two decorrelated 32-bit lanes → 16 hex chars (~64-bit key space). Keeps
// chunk-coordinate collisions astronomically rare without pulling in xxhash-wasm.
function hashParts(parts: readonly string[]): string {
  const input = parts.join("\u0000"); // NUL guards against ["ab"] vs ["a","b"] aliasing
  let h1 = 0x811c9dc5;
  let h2 = 0x97c29b3a;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x01000193) ^ (h2 >>> 7);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

function buildPath(key: CacheKeyParts): string {
  if (!NAMESPACE_PATTERN.test(key.namespace)) {
    throw new Error(`cache namespace "${key.namespace}" must match ${NAMESPACE_PATTERN.source}`);
  }
  // SCHEMA_VERSION ("1.0") is one directory segment; the dot is intentional, never split.
  return `${SCHEMA_VERSION}/${key.namespace}/${hashParts(key.parts)}`;
}

export class MemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, Uint8Array>();

  read(path: string): Promise<Uint8Array | undefined> {
    // Copy out so a caller mutating the result can't corrupt the cached blob,
    // matching the fresh-buffer semantics of the OPFS read path.
    return Promise.resolve(this.#entries.get(path)?.slice());
  }

  write(path: string, bytes: Uint8Array): Promise<void> {
    this.#entries.set(path, bytes.slice());
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.#entries.delete(path);
    return Promise.resolve();
  }

  list(): Promise<ReadonlyArray<{ readonly path: string; readonly size: number }>> {
    const out: { readonly path: string; readonly size: number }[] = [];
    for (const [path, bytes] of this.#entries) out.push({ path, size: bytes.byteLength });
    return Promise.resolve(out);
  }

  dispose(): void {
    this.#entries.clear();
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function resolveDir(
  segments: readonly string[],
): Promise<FileSystemDirectoryHandle | undefined> {
  let dir = await navigator.storage.getDirectory();
  for (const segment of segments) {
    try {
      dir = await dir.getDirectoryHandle(segment);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }
  return dir;
}

async function collectFiles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: { path: string; size: number }[],
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    const childPath = prefix === "" ? name : `${prefix}/${name}`;
    if (handle.kind === "file") {
      const file = await handle.getFile();
      out.push({ path: childPath, size: file.size });
    } else {
      await collectFiles(handle, childPath, out);
    }
  }
}

// Literal `new Worker(new URL(...))` so Vite emits the worker as its own chunk; the
// URL string is not an import edge, so this data→workers reference stays DAG-clean.
const defaultSpawnWorker = (): Worker =>
  new Worker(new URL("../workers/data.worker.ts", import.meta.url), { type: "module" });

export class OpfsCacheStore implements CacheStore {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  #nextRequestId = 1;

  constructor(spawnWorker: () => Worker = defaultSpawnWorker) {
    this.#worker = spawnWorker();
    this.#worker.onmessage = (event: MessageEvent<DataCacheResponse>) => {
      const response = event.data;
      const entry = this.#pending.get(response.requestId);
      if (entry === undefined) return;
      this.#pending.delete(response.requestId);
      if (response.kind === "ok") entry.resolve();
      else entry.reject(new Error(response.message));
    };
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    const segments = path.split("/");
    const name = segments.pop();
    if (name === undefined || name === "") return undefined;
    const dir = await resolveDir(segments);
    if (dir === undefined) return undefined;
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await dir.getFileHandle(name);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  write(path: string, bytes: Uint8Array): Promise<void> {
    // Copy to an exact-length, freshly owned buffer: `bytes` may be a view into a
    // pooled ArrayBuffer, and transferring the backing buffer would detach unrelated
    // data and ship extra bytes.
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const requestId = this.#nextRequestId++;
    return this.#dispatch({ kind: "cacheWrite", requestId, path, bytes: buffer }, [buffer]);
  }

  remove(path: string): Promise<void> {
    const requestId = this.#nextRequestId++;
    return this.#dispatch({ kind: "cacheRemove", requestId, path });
  }

  async list(): Promise<ReadonlyArray<{ readonly path: string; readonly size: number }>> {
    // Walk only the current schema-version subtree so manifest/totalBytes match the
    // paths buildPath() emits. Stale-version dirs must not inflate the budget — the
    // planned LRU can only evict current-version keys, so counting them would wedge the
    // cache below capacity. The prefix keeps returned paths aligned with buildPath().
    const versionDir = await resolveDir([SCHEMA_VERSION]);
    if (versionDir === undefined) return [];
    const out: { path: string; size: number }[] = [];
    await collectFiles(versionDir, SCHEMA_VERSION, out);
    return out;
  }

  dispose(): void {
    this.#worker.terminate();
    for (const entry of this.#pending.values()) entry.reject(new Error("cache disposed"));
    this.#pending.clear();
  }

  #dispatch(request: DataCacheRequest, transfer?: Transferable[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#pending.set(request.requestId, { resolve, reject });
      if (transfer === undefined) this.#worker.postMessage(request);
      else this.#worker.postMessage(request, transfer);
    });
  }
}

function selectStore(options: CacheOptions): CacheStore {
  if (options.store !== undefined) return options.store;
  if (typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function") {
    return new OpfsCacheStore(options.spawnWorker ?? defaultSpawnWorker);
  }
  // No OPFS (Node tests, sandboxed contexts): non-persistent degradation. IndexedDB
  // is the future persistent fallback (deferred — see docs/DESIGN.md §Caching).
  return new MemoryCacheStore();
}

export async function installCache(options: CacheOptions = {}): Promise<Cache> {
  const store = selectStore(options);
  const budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET_BYTES;

  // Manifest (path → size), rebuilt from the store so has()/totalBytes survive reloads.
  const manifest = new Map<string, number>();
  let totalBytes = 0;
  for (const entry of await store.list()) {
    manifest.set(entry.path, entry.size);
    totalBytes += entry.size;
  }

  return {
    get(key) {
      return store.read(buildPath(key));
    },
    async put(key, bytes) {
      const path = buildPath(key);
      await store.write(path, bytes);
      const previous = manifest.get(path);
      if (previous !== undefined) totalBytes -= previous;
      manifest.set(path, bytes.byteLength);
      totalBytes += bytes.byteLength;
      if (totalBytes > budgetBytes) {
        // Eviction is deferred: the field cache is the first consumer to approach the budget
        // (calibration scores never trip it); this branch is where LRU will hook in.
      }
    },
    has(key) {
      return manifest.has(buildPath(key));
    },
    async delete(key) {
      const path = buildPath(key);
      await store.remove(path);
      const previous = manifest.get(path);
      if (previous !== undefined) {
        totalBytes -= previous;
        manifest.delete(path);
      }
    },
    dispose() {
      store.dispose();
      manifest.clear();
    },
  };
}

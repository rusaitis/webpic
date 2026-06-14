import { describe, expect, it } from "vitest";
import {
  type CacheKeyParts,
  type DataCacheRequest,
  type DataCacheResponse,
  installCache,
  MemoryCacheStore,
  OpfsCacheStore,
} from "./cache.ts";

function key(namespace: string, ...parts: string[]): CacheKeyParts {
  return { namespace, parts };
}

interface Post {
  readonly message: DataCacheRequest;
  readonly transfer: Transferable[] | undefined;
}

// Fake worker mirroring app/main.test.ts: records posts (+ transfer list) and
// auto-acks each request so OpfsCacheStore's pending promise resolves.
function fakeWorker(): { worker: Worker; posts: Post[]; terminated: () => number } {
  const posts: Post[] = [];
  let terminated = 0;
  const worker = {
    onmessage: null as ((event: MessageEvent<DataCacheResponse>) => void) | null,
    postMessage(message: DataCacheRequest, transfer?: Transferable[]) {
      posts.push({ message, transfer });
      queueMicrotask(() => {
        const ack = {
          data: { kind: "ok", requestId: message.requestId },
        } as MessageEvent<DataCacheResponse>;
        this.onmessage?.(ack);
      });
    },
    terminate() {
      terminated += 1;
    },
  };
  // Structural test double: a plain object with the Worker surface we exercise, not a real Worker.
  return { worker: worker as unknown as Worker, posts, terminated: () => terminated };
}

describe("cache facade (MemoryCacheStore)", () => {
  it("round-trips put/get and reflects has()/delete", async () => {
    const cache = await installCache({ store: new MemoryCacheStore() });
    const k = key("calibration", "apple", "m2");
    expect(cache.has(k)).toBe(false);

    await cache.put(k, new Uint8Array([9, 8, 7]));
    expect(cache.has(k)).toBe(true);
    expect(await cache.get(k)).toEqual(new Uint8Array([9, 8, 7]));

    await cache.delete(k);
    expect(cache.has(k)).toBe(false);
    expect(await cache.get(k)).toBeUndefined();
    cache.dispose();
  });

  it("prefixes stored paths with the schema version and namespace", async () => {
    const store = new MemoryCacheStore();
    const cache = await installCache({ store });
    await cache.put(key("fields", "zarr", "step0", "|B|"), new Uint8Array([1]));

    const entries = await store.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry === undefined) throw new Error("no entry stored");
    expect(entry.path.startsWith("1.0/fields/")).toBe(true);
  });

  it("rebuilds the manifest from the store so has() survives a reinstall", async () => {
    const store = new MemoryCacheStore();
    const k = key("fields", "zarr", "step3");
    const first = await installCache({ store });
    await first.put(k, new Uint8Array([1, 2]));

    // Re-open over the same (undisposed) store, as a page reload would.
    const second = await installCache({ store });
    expect(second.has(k)).toBe(true);
  });

  it("tracks the byte budget without evicting (LRU deferred)", async () => {
    const cache = await installCache({ store: new MemoryCacheStore(), budgetBytes: 4 });
    await cache.put(key("fields", "a"), new Uint8Array([1, 2, 3]));
    await cache.put(key("fields", "b"), new Uint8Array([4, 5, 6])); // 6 bytes > 4
    expect(cache.has(key("fields", "a"))).toBe(true);
    expect(cache.has(key("fields", "b"))).toBe(true);
  });

  it("rejects an invalid namespace loudly", async () => {
    const cache = await installCache({ store: new MemoryCacheStore() });
    await expect(
      cache.put({ namespace: "Bad Name", parts: [] }, new Uint8Array([1])),
    ).rejects.toThrow();
    expect(() => cache.has({ namespace: "UPPER", parts: [] })).toThrow();
  });

  it("falls back to an in-memory store when OPFS is absent", async () => {
    // No store injected; Node has no navigator.storage.getDirectory, so no worker spawns.
    const cache = await installCache();
    const k = key("calibration", "x");
    await cache.put(k, new Uint8Array([42]));
    expect(await cache.get(k)).toEqual(new Uint8Array([42]));
    cache.dispose();
  });
});

describe("OpfsCacheStore write routing", () => {
  it("posts cacheWrite to the worker with a transferred, exact-length buffer", async () => {
    const fake = fakeWorker();
    const store = new OpfsCacheStore(() => fake.worker);

    // A view into a larger pooled buffer — only the 3 logical bytes should ship.
    const pool = new Uint8Array([0, 0, 1, 2, 3, 0]);
    await store.write("1.0/fields/abc", pool.subarray(2, 5));

    expect(fake.posts).toHaveLength(1);
    const post = fake.posts[0];
    if (post === undefined) throw new Error("nothing posted");
    if (post.message.kind !== "cacheWrite") throw new Error("expected cacheWrite");
    expect(post.message.path).toBe("1.0/fields/abc");
    expect(new Uint8Array(post.message.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    // Transferred (not cloned): the same buffer reference appears in the transfer list.
    expect(post.transfer).toEqual([post.message.bytes]);

    store.dispose();
    expect(fake.terminated()).toBe(1);
  });

  it("posts cacheRemove without a transfer list", async () => {
    const fake = fakeWorker();
    const store = new OpfsCacheStore(() => fake.worker);
    await store.remove("1.0/fields/abc");

    const post = fake.posts[0];
    if (post === undefined) throw new Error("nothing posted");
    expect(post.message.kind).toBe("cacheRemove");
    expect(post.transfer).toBeUndefined();
    store.dispose();
  });

  it("rejects the pending write when the worker reports an error", async () => {
    const posts: DataCacheRequest[] = [];
    const worker = {
      onmessage: null as ((event: MessageEvent<DataCacheResponse>) => void) | null,
      postMessage(message: DataCacheRequest) {
        posts.push(message);
        queueMicrotask(() => {
          const fail = {
            data: { kind: "error", requestId: message.requestId, message: "disk full" },
          } as MessageEvent<DataCacheResponse>;
          this.onmessage?.(fail);
        });
      },
      terminate() {},
    };
    // Structural test double (fake Worker) standing in for the real OPFS cache worker.
    const store = new OpfsCacheStore(() => worker as unknown as Worker);
    await expect(store.write("1.0/fields/x", new Uint8Array([1]))).rejects.toThrow("disk full");
    store.dispose();
  });
});

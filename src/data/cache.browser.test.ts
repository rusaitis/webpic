// Real-OPFS round-trip: installCache() picks OpfsCacheStore, writes go through
// data.worker.ts via createSyncAccessHandle() under a web-lock, reads come back on
// the main thread. Skipped wherever OPFS/Worker are absent (the Node PR gate skips
// it green); runs on a browser runner. cache.ts is imported dynamically so its OPFS
// probing never touches Node.

import { describe, expect, it } from "vitest";

const hasOpfs =
  typeof navigator !== "undefined" &&
  typeof navigator.storage?.getDirectory === "function" &&
  typeof Worker !== "undefined";

describe("OPFS cache round-trip", () => {
  it.skipIf(!hasOpfs)("writes via the worker and reads back on the main thread", async () => {
    const { installCache } = await import("./cache.ts");
    const cache = await installCache();
    const k = { namespace: "fields", parts: ["zarr", "step0", "|B|"] };
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    try {
      await cache.put(k, payload);
      expect(cache.has(k)).toBe(true);
      expect(await cache.get(k)).toEqual(payload);

      await cache.delete(k);
      expect(cache.has(k)).toBe(false);
      expect(await cache.get(k)).toBeUndefined();
    } finally {
      cache.dispose();
    }
  });
});

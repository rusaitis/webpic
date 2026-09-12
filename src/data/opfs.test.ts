import { afterEach, describe, expect, it, vi } from "vitest";
import { isNotFound, resolveDir, splitPath } from "./opfs.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

// A directory tree that answers getDirectoryHandle the way OPFS does: NotFoundError unless `create`.
function fakeRoot(existing: ReadonlySet<string>): FileSystemDirectoryHandle {
  const make = (path: string): FileSystemDirectoryHandle =>
    ({
      name: path,
      getDirectoryHandle: (segment: string, options?: { create?: boolean }) => {
        const next = path === "" ? segment : `${path}/${segment}`;
        if (existing.has(next) || options?.create === true) return Promise.resolve(make(next));
        return Promise.reject(new DOMException("no such dir", "NotFoundError"));
      },
    }) as unknown as FileSystemDirectoryHandle; // a stand-in for the handful of members we call
  return make("");
}

const stubStorage = (existing: ReadonlySet<string>): void => {
  vi.stubGlobal("navigator", {
    storage: { getDirectory: () => Promise.resolve(fakeRoot(existing)) },
  });
};

describe("splitPath", () => {
  it("splits a joined cache path into its directories and leaf name", () => {
    expect(splitPath("1.0/zarr/abc123")).toEqual({ dirs: ["1.0", "zarr"], name: "abc123" });
    expect(splitPath("solo")).toEqual({ dirs: [], name: "solo" });
  });

  it("rejects a path with no leaf name, naming itself and the offending value", () => {
    expect(() => splitPath("")).toThrow(/splitPath: invalid cache path.*got ""/);
    expect(() => splitPath("dir/")).toThrow(/splitPath: invalid cache path.*got "dir\/"/);
  });
});

describe("isNotFound", () => {
  it("recognises only OPFS's NotFoundError", () => {
    expect(isNotFound(new DOMException("x", "NotFoundError"))).toBe(true);
    expect(isNotFound(new DOMException("x", "QuotaExceededError"))).toBe(false);
    expect(isNotFound(new Error("NotFoundError"))).toBe(false);
    expect(isNotFound("NotFoundError")).toBe(false);
  });
});

describe("resolveDir", () => {
  it("walks existing segments from the storage root", async () => {
    stubStorage(new Set(["1.0", "1.0/zarr"]));
    await expect(resolveDir(["1.0", "zarr"])).resolves.toHaveProperty("name", "1.0/zarr");
  });

  it("reports a missing directory as undefined on the read path", async () => {
    stubStorage(new Set(["1.0"]));
    await expect(resolveDir(["1.0", "absent"])).resolves.toBeUndefined();
  });

  it("creates the missing segments on the write path", async () => {
    stubStorage(new Set());
    await expect(resolveDir(["1.0", "zarr"], { create: true })).resolves.toHaveProperty(
      "name",
      "1.0/zarr",
    );
  });

  it("propagates a failure that is not a missing directory", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: () =>
          Promise.resolve({
            getDirectoryHandle: () =>
              Promise.reject(new DOMException("over quota", "QuotaExceededError")),
          } as unknown as FileSystemDirectoryHandle),
      },
    });
    await expect(resolveDir(["1.0"])).rejects.toThrow(/over quota/);
  });
});

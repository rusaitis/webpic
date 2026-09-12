import { SCHEMA_VERSION } from "@schema/version.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readThemePref, writeThemePref } from "./prefs.ts";

// A minimal in-memory OPFS fake: one directory level ("settings") holding text files. Enough
// surface for resolveDir + getFileHandle + getFile/createWritable as prefs.ts uses them.

function makeOpfsFake(options: { withWritable?: boolean } = {}) {
  const files = new Map<string, string>();
  const withWritable = options.withWritable ?? true;

  const fileHandle = (name: string) => ({
    getFile: async () => ({ text: async () => files.get(name) ?? "" }),
    ...(withWritable
      ? {
          createWritable: async () => {
            let buffer = "";
            return {
              write: async (text: string) => {
                buffer = text;
              },
              close: async () => {
                files.set(name, buffer);
              },
            };
          },
        }
      : {}),
  });

  const settingsDir = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && options?.create !== true) {
        throw new DOMException("not found", "NotFoundError");
      }
      return fileHandle(name);
    },
  };

  const dirs = new Map<string, unknown>();
  const root = {
    getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
      if (!dirs.has(name)) {
        if (options?.create !== true) throw new DOMException("not found", "NotFoundError");
        dirs.set(name, settingsDir);
      }
      return dirs.get(name);
    },
  };

  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  return { files };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme pref (OPFS)", () => {
  it("reads null where OPFS is unavailable and writes silently no-op", async () => {
    vi.stubGlobal("navigator", {});
    await expect(readThemePref()).resolves.toBeNull();
    await expect(writeThemePref("dark")).resolves.toBeUndefined();
  });

  it("reads null when nothing was persisted", async () => {
    makeOpfsFake();
    await expect(readThemePref()).resolves.toBeNull();
  });

  it("round-trips the theme name with a schemaVersion tag", async () => {
    const { files } = makeOpfsFake();
    await writeThemePref("lcars");
    expect(JSON.parse(files.get("theme.json") ?? "")).toEqual({
      schemaVersion: SCHEMA_VERSION,
      name: "lcars",
    });
    await expect(readThemePref()).resolves.toBe("lcars");
  });

  it("reads null on a foreign schemaVersion or malformed payload", async () => {
    const { files } = makeOpfsFake();
    files.set("theme.json", JSON.stringify({ schemaVersion: "9.9", name: "lcars" }));
    await expect(readThemePref()).resolves.toBeNull();
    files.set("theme.json", "not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readThemePref()).resolves.toBeNull();
    warn.mockRestore();
  });

  it("skips the write where createWritable is missing (Safari <26 main thread)", async () => {
    const { files } = makeOpfsFake({ withWritable: false });
    await expect(writeThemePref("dark")).resolves.toBeUndefined();
    expect(files.size).toBe(0);
  });
});

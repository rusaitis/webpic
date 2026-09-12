// OPFS path-walk primitives shared by the cache (data/cache.ts) and the data worker
// (workers/data.worker.ts). A leaf module that imports nothing, so the worker can pull these without
// dragging the cache's module graph (zarrita etc.) into its chunk. Single-sources the '/'-joined
// segment convention that cache.ts's buildPath() emits.

export function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/** Split a '/'-joined cache path into its parent directory segments + leaf file name. */
export function splitPath(path: string): { dirs: readonly string[]; name: string } {
  const segments = path.split("/");
  const name = segments.pop();
  if (name === undefined || name === "")
    throw new Error(`splitPath: invalid cache path, expected "dir/.../name", got "${path}"`);
  return { dirs: segments, name };
}

/**
 * Walk OPFS directory segments from the storage root. `create` makes missing dirs (the write path);
 * without it a missing dir resolves to `undefined` (the read/remove path) rather than throwing.
 */
export async function resolveDir(
  segments: readonly string[],
  { create = false }: { create?: boolean } = {},
): Promise<FileSystemDirectoryHandle | undefined> {
  let dir = await navigator.storage.getDirectory();
  for (const segment of segments) {
    try {
      dir = await dir.getDirectoryHandle(segment, { create });
    } catch (error) {
      if (!create && isNotFound(error)) return undefined;
      throw error;
    }
  }
  return dir;
}

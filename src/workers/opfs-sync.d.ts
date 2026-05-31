// FileSystemSyncAccessHandle + createSyncAccessHandle live in lib.webworker.d.ts,
// which this project's tsconfig (lib: ES2022/DOM/DOM.Iterable) deliberately omits —
// adding "WebWorker" globally would clash with the DOM lib's Window-typed `self`.
// Declare the minimal worker-only surface the cache writer uses; the second
// interface merges with the DOM lib's FileSystemFileHandle. Signatures mirror
// lib.webworker.d.ts exactly.

interface FileSystemSyncAccessHandle {
  read(buffer: AllowSharedBufferSource, options?: { at?: number }): number;
  write(buffer: AllowSharedBufferSource, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

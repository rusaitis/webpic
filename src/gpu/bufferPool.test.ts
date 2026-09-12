import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBufferPool } from "./bufferPool.ts";

function fakeDevice() {
  const created: Array<{ size: number; usage: number; destroyed: boolean }> = [];
  const writes: Array<{ buffer: unknown; data: ArrayBufferView | ArrayBuffer }> = [];
  const device = {
    createBuffer: vi.fn((descriptor: { size: number; usage: number }) => {
      const record = { ...descriptor, destroyed: false };
      created.push(record);
      return { ...record, destroy: () => (record.destroyed = true) };
    }),
    queue: { writeBuffer: vi.fn((buffer, _offset, data) => writes.push({ buffer, data })) },
  } as unknown as GPUDevice;
  return { device, created, writes };
}

// The WebGPU usage flags are a browser global; only the bits the pool sets matter here.
const USAGE = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, STORAGE: 0x0080 };

describe("createBufferPool", () => {
  beforeEach(() => {
    vi.stubGlobal("GPUBufferUsage", USAGE);
  });

  it("uploads a storage input in one step, sized to the view", () => {
    const { device, created, writes } = fakeDevice();
    const pool = createBufferPool(device);
    const data = new Float32Array([1, 2, 3]);
    pool.storageInput(data);
    expect(created[0]?.size).toBe(12);
    expect(writes[0]?.data).toBe(data);
  });

  it("floors a zero-length input at one f32 so the buffer size stays legal", () => {
    const { device, created } = fakeDevice();
    createBufferPool(device).storageInput(new Float32Array(0));
    expect(created[0]?.size).toBe(4);
  });

  it("gives a readback MAP_READ without STORAGE — the two are mutually exclusive", () => {
    const { device, created } = fakeDevice();
    const pool = createBufferPool(device);
    pool.storageOutput(64);
    pool.readback(64);
    const [output, staging] = created;
    expect((output?.usage ?? 0) & USAGE.STORAGE).toBeTruthy();
    expect((staging?.usage ?? 0) & USAGE.MAP_READ).toBeTruthy();
    expect((staging?.usage ?? 0) & USAGE.STORAGE).toBe(0);
  });

  it("destroys every buffer it handed out, whatever the shape", () => {
    const { device, created } = fakeDevice();
    const pool = createBufferPool(device);
    pool.storageInput(new Float32Array(2));
    pool.storageOutput(8);
    pool.readback(8);
    pool.destroyAll();
    expect(created.map((b) => b.destroyed)).toEqual([true, true, true]);
  });
});

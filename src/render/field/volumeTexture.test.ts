import { resetLedger, vramSnapshot } from "@gpu/vramLedger.ts";
import { type Data3DTexture, DataUtils, FloatType, HalfFloatType, LinearFilter } from "three";
import { describe, expect, it, vi } from "vitest";
import { createVolumeTexture, type ScalarField, type VolumeTexture } from "./volumeTexture.ts";

// volumeTexture builds Data3DTextures + a three/tsl sampling node — both load in Node (no WebGPU
// device), so the pack + ping-pong swap logic is unit-testable without a GPU. The GPU re-bind itself
// (NodeSampledTexture.update reading node.value each frame) is exercised by verify-streaming-render.

const field = (data: readonly number[], shape: readonly number[] = [2, 2, 2]): ScalarField => ({
  data: new Float32Array(data),
  shape,
});

// The active texture the node currently samples, and its CPU image. The double-cast is the test's
// price for three's loose `image.data` typing (BufferSource); the runtime is the array we packed.
const active = (vol: VolumeTexture): Data3DTexture => vol.node.value as Data3DTexture;
const activeArray = (vol: VolumeTexture): Float32Array =>
  active(vol).image.data as unknown as Float32Array;

describe("createVolumeTexture", () => {
  it("uploads R32F + linear when float32-filterable is available (the stable Metal path)", () => {
    const volume = createVolumeTexture(field([0, 1, 2, 3, 4, 5, 6, 7]), true);
    expect(active(volume).type).toBe(FloatType);
    expect(active(volume).image.data).toBeInstanceOf(Float32Array);
    expect(active(volume).minFilter).toBe(LinearFilter);
    volume.dispose();
  });

  it("falls back to R16F (half-float) when float32-filterable is absent", () => {
    const volume = createVolumeTexture(field([0, 1, 2, 3, 4, 5, 6, 7]), false);
    expect(active(volume).type).toBe(HalfFloatType);
    expect(active(volume).image.data).toBeInstanceOf(Uint16Array);
    volume.dispose();
  });

  it("reports the finite data range regardless of format", () => {
    const volume = createVolumeTexture(field([0, 1, 2, 3, 4, 5, 6, 7]), true);
    expect(volume.min).toBe(0);
    expect(volume.max).toBe(7);
    volume.dispose();
  });

  it("widens a constant field so the normalization divide stays finite", () => {
    const volume = createVolumeTexture(field([3, 3, 3, 3, 3, 3, 3, 3]), true);
    expect(volume.min).toBe(3);
    expect(volume.max).toBe(4);
    volume.dispose();
  });

  it("fills non-finite samples with the field's finite min (R32F path)", () => {
    const volume = createVolumeTexture(field([Number.NaN, 2, 3, 4, 5, 6, 7, 8]), true);
    expect(Array.from(activeArray(volume))).toEqual([2, 2, 3, 4, 5, 6, 7, 8]); // NaN → finite min
    volume.dispose();
  });

  it("packs the half-float fallback as Uint16 (R16F path)", () => {
    const volume = createVolumeTexture(field([1, 2, 3, 4, 5, 6, 7, 8]), false);
    const data = active(volume).image.data as unknown as Uint16Array;
    expect(DataUtils.fromHalfFloat(data[5] ?? 0)).toBeCloseTo(6, 5);
    volume.dispose();
  });

  it("setField ping-pongs to the inactive texture and rebinds the node (matching shape)", () => {
    const volume = createVolumeTexture(field([1, 1, 1, 1, 1, 1, 1, 1]), true);
    const front = volume.node.value;
    expect(volume.setField(field([2, 3, 4, 5, 6, 7, 8, 9]))).toBe(true);
    expect(volume.node.value).not.toBe(front); // node now samples the other buffer
    expect(Array.from(activeArray(volume))).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    volume.dispose();
  });

  it("setField fills non-finite samples with the new field's finite min (matching construction)", () => {
    const volume = createVolumeTexture(field([1, 1, 1, 1, 1, 1, 1, 1]), true);
    expect(volume.setField(field([Number.NaN, 2, 3, 4, 5, 6, 7, 8]))).toBe(true);
    expect(Array.from(activeArray(volume))).toEqual([2, 2, 3, 4, 5, 6, 7, 8]); // NaN → finite min
    // All-non-finite fills with 0 — the same fallback createVolumeTexture's finiteRange uses.
    expect(volume.setField(field(Array(8).fill(Number.NaN)))).toBe(true);
    expect(Array.from(activeArray(volume))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    volume.dispose();
  });

  it("reuses exactly two textures across repeated swaps (true ping-pong)", () => {
    const volume = createVolumeTexture(field([1, 1, 1, 1, 1, 1, 1, 1]), true);
    const slot0 = volume.node.value;
    volume.setField(field([2, 2, 2, 2, 2, 2, 2, 2]));
    const slot1 = volume.node.value; // lazily allocated on the first swap
    expect(slot1).not.toBe(slot0);
    volume.setField(field([3, 3, 3, 3, 3, 3, 3, 3]));
    expect(volume.node.value).toBe(slot0); // back to slot 0, rewritten in place
    expect(Array.from(activeArray(volume))).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
    volume.setField(field([4, 4, 4, 4, 4, 4, 4, 4]));
    expect(volume.node.value).toBe(slot1); // back to slot 1 — no third allocation
    volume.dispose();
  });

  it("bumps the reused texture's version so the rewritten image re-uploads", () => {
    const volume = createVolumeTexture(field([1, 1, 1, 1, 1, 1, 1, 1]), true);
    const slot0 = volume.node.value as Data3DTexture;
    volume.setField(field([2, 2, 2, 2, 2, 2, 2, 2])); // → slot 1
    const before = slot0.version;
    volume.setField(field([3, 3, 3, 3, 3, 3, 3, 3])); // → slot 0 reused
    expect(slot0.version).toBeGreaterThan(before);
    volume.dispose();
  });

  it("setField declines a shape change without swapping (caller rebuilds)", () => {
    const volume = createVolumeTexture(field([1, 1, 1, 1, 1, 1, 1, 1]), true);
    const front = volume.node.value;
    expect(volume.setField({ data: new Float32Array(27), shape: [3, 3, 3] })).toBe(false);
    expect(volume.node.value).toBe(front); // unchanged
    volume.dispose();
  });

  it("disposes both ping-pong textures", () => {
    const volume = createVolumeTexture(field([1, 1, 1, 1, 1, 1, 1, 1]), true);
    const slot0 = volume.node.value as Data3DTexture;
    volume.setField(field([2, 2, 2, 2, 2, 2, 2, 2]));
    const slot1 = volume.node.value as Data3DTexture;
    const d0 = vi.spyOn(slot0, "dispose");
    const d1 = vi.spyOn(slot1, "dispose");
    volume.dispose();
    expect(d0).toHaveBeenCalled();
    expect(d1).toHaveBeenCalled();
  });

  it("rejects a non-3D field", () => {
    expect(() => createVolumeTexture({ data: new Float32Array(4), shape: [2, 2] }, true)).toThrow();
  });

  it("clears its VRAM ledger entries and stays clear after a second dispose", () => {
    resetLedger();
    const volume = createVolumeTexture(field([0, 1, 2, 3, 4, 5, 6, 7]), true, "layer-0");
    volume.setField(field([7, 6, 5, 4, 3, 2, 1, 0])); // allocate the second ping-pong slot too
    expect(vramSnapshot().totalBytes).toBeGreaterThan(0);

    volume.dispose();
    expect(vramSnapshot().totalBytes).toBe(0);

    // A double dispose reaches releaseAlloc twice; the ledger must not go negative or resurrect a key.
    volume.dispose();
    expect(vramSnapshot()).toEqual({ totalBytes: 0, byKey: [] });
  });
});

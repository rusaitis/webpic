import { describe, expect, it } from "vitest";
import {
  createSyntheticReader,
  DEFAULT_SYNTHETIC_STEPS,
  dipoleHandle,
  dipoleStep,
  syntheticConfidence,
  syntheticHandle,
  syntheticStep,
} from "./synthetic.ts";

// The synthetic multi-step reader is the streaming worker's source — a deterministic time-varying
// flux rope behind the SimulationReader protocol. These tests pin the contract the worker relies on:
// the step domain, per-step fields, abort handling, and the step-0 == scaffold invariant.

const reader = createSyntheticReader();

describe("synthetic reader", () => {
  it("lists a contiguous timestep domain", async () => {
    expect(await reader.availableTimesteps(syntheticHandle(8, 5))).toEqual([0, 1, 2, 3, 4]);
  });

  it("reads a step with the right shape, fields, and step tag", async () => {
    const ds = await reader.readTimestep(syntheticHandle(8, 4), 2);
    expect(ds.step).toBe(2);
    expect([...ds.fields.keys()]).toEqual(["B_1", "B_2", "B_3"]);
    expect(ds.fields.get("B_1")?.shape).toEqual([8, 8, 8]);
  });

  it("evolves |B| across steps (the axial amplitude pulses)", () => {
    const at = (step: number) => syntheticStep(8, step, 8).fields.get("B_3")?.data;
    // step 0 (phase 0) → unit axial amplitude; step 4 (phase π) → minimal — the volumes must differ.
    expect(Array.from(at(0) ?? [])).not.toEqual(Array.from(at(4) ?? []));
  });

  it("step 0 is steps-independent (the no-flash invariant for the main-thread seed)", () => {
    const a = syntheticStep(16, 0, 1).fields.get("B_3")?.data;
    const b = syntheticStep(16, 0, 16).fields.get("B_3")?.data;
    expect(Array.from(a ?? [])).toEqual(Array.from(b ?? []));
  });

  it("honors an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      reader.readTimestep(syntheticHandle(8, 4), 1, { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });

  it("restricts to requested fields and rejects an unknown one", async () => {
    const ds = await reader.readTimestep(syntheticHandle(8, 4), 0, { fields: ["B_1"] });
    expect([...ds.fields.keys()]).toEqual(["B_1"]);
    await expect(
      reader.readTimestep(syntheticHandle(8, 4), 0, { fields: ["E_1"] }),
    ).rejects.toThrow(/unknown field/);
  });

  it("rejects an out-of-range step", async () => {
    await expect(reader.readTimestep(syntheticHandle(8, 4), 9)).rejects.toThrow(/out of range/);
  });

  it("scores synthetic handles 1 and everything else 0", async () => {
    expect(await syntheticConfidence(syntheticHandle())).toBe(1);
    expect(await syntheticConfidence({ kind: "url", url: "https://example.com/data.zarr" })).toBe(
      0,
    );
    expect(await syntheticConfidence({ kind: "opfs", path: "/cache/x" })).toBe(0);
  });

  it("defaults a query-less handle's size/steps rather than throwing", async () => {
    const steps = await reader.availableTimesteps({ kind: "url", url: "synthetic://fluxrope" });
    expect(steps).toHaveLength(DEFAULT_SYNTHETIC_STEPS);
  });
});

describe("synthetic dipole", () => {
  // magviz's default Earth dipole on its non-cubic grid (x∈[-10,5], y,z∈[-5,5], 0.1 R_E cells).
  const NX = 150;
  const NY = 100;
  const NZ = 100;
  const ORIGIN = [-10, -5, -5] as const;
  const SP = 0.1;
  const idx = (ix: number, iy: number, iz: number): number => iz + NZ * (iy + NY * ix);
  const center = (axis: 0 | 1 | 2, i: number): number => ORIGIN[axis] + (i + 0.5) * SP;

  it("is one static step on the magviz grid (non-cubic shape + fields)", async () => {
    expect(await reader.availableTimesteps(dipoleHandle())).toEqual([0]);
    const ds = await reader.readTimestep(dipoleHandle(), 0);
    expect(ds.step).toBe(0);
    expect([...ds.fields.keys()]).toEqual(["B_1", "B_2", "B_3"]);
    expect(ds.fields.get("B_1")?.shape).toEqual([NX, NY, NZ]);
    expect(ds.grid.spacing).toEqual([SP, SP, SP]);
    expect(ds.grid.origin).toEqual([...ORIGIN]);
  });

  it("scores a dipole handle 1 and rejects a step past its single frame", async () => {
    expect(await syntheticConfidence(dipoleHandle())).toBe(1);
    await expect(reader.readTimestep(dipoleHandle(), 1)).rejects.toThrow(/out of range/);
  });

  it("matches the analytic dipole (C-order layout, scale, sign) at a sample cell", () => {
    const ds = dipoleStep();
    const SCALE_NT = (1e-7 * 7.8e22 * 1e9) / 6.371e6 ** 3;
    const ix = 120;
    const iy = 60;
    const iz = 70; // well outside the r<1.1 cutoff
    const x = center(0, ix);
    const y = center(1, iy);
    const z = center(2, iz);
    const r2 = x * x + y * y + z * z;
    const c = -SCALE_NT / (r2 * r2 * Math.sqrt(r2)); // common(=-SCALE)/r⁵
    const i = idx(ix, iy, iz);
    // Float32 storage (~7 sig figs); values are O(10²–10³) nT, so an absolute 5e-3 still pins the
    // scale/sign/C-order (a wrong scale or component would be off by ≫100%).
    expect(ds.fields.get("B_1")?.data[i]).toBeCloseTo(c * 3 * x * z, 2);
    expect(ds.fields.get("B_2")?.data[i]).toBeCloseTo(c * 3 * y * z, 2);
    expect(ds.fields.get("B_3")?.data[i]).toBeCloseTo(c * (3 * z * z - r2), 2);
  });

  it("zeroes the inner cutoff and stays finite everywhere", () => {
    const ds = dipoleStep();
    const b1 = ds.fields.get("B_1")?.data ?? new Float32Array();
    const b2 = ds.fields.get("B_2")?.data ?? new Float32Array();
    const b3 = ds.fields.get("B_3")?.data ?? new Float32Array();
    // The cell nearest the origin (center ≈ (0.05,0.05,0.05), r ≈ 0.087 < 1.1) is zeroed.
    const inner = idx(100, 50, 50);
    expect(b1[inner]).toBe(0);
    expect(b2[inner]).toBe(0);
    expect(b3[inner]).toBe(0);
    for (let k = 0; k < b3.length; k++) {
      if (!Number.isFinite(b3[k] ?? Number.NaN)) throw new Error(`non-finite B_3 at ${k}`);
    }
  });

  it("falls off as 1/r³ along the dipole axis (and points magnetic-north at −z)", () => {
    const ds = dipoleStep();
    const b3 = ds.fields.get("B_3")?.data ?? new Float32Array();
    // Near-axis cells (x,y ≈ 0.05) at z ≈ 2.05 and z ≈ 4.05 — |B_z| dominates; ratio ≈ (z₂/z₁)³.
    const near = idx(100, 50, 70); // z ≈ 2.05
    const far = idx(100, 50, 90); // z ≈ 4.05
    const z1 = center(2, 70);
    const z2 = center(2, 90);
    const ratio = (b3[near] ?? 0) / (b3[far] ?? 1);
    expect(ratio).toBeCloseTo((z2 / z1) ** 3, 1);
    expect(b3[far]).toBeLessThan(0); // sign-flipped moment → north at −z
  });
});

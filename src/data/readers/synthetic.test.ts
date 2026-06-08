import { describe, expect, it } from "vitest";
import {
  createSyntheticReader,
  DEFAULT_SYNTHETIC_STEPS,
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

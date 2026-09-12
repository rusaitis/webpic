import type { GridInfo } from "@containers/field_dataset.ts";
import { REASON_CODES, type ResolvedTraceParams, reasonFromCode } from "@numerics/tracing.ts";
import {
  STREAMLINE_ENTRY,
  STREAMLINE_WGSL,
  STREAMLINE_WORKGROUP_SIZE,
} from "@shaders/kernels/streamline.wgsl.ts";
import { describe, expect, it } from "vitest";
import { makeDataset, makeField, makeGrid } from "../../../../tests/fixtures.ts";
import { datasetFromFixture, TRACE_FIXTURES } from "../../../../tests/traceFixtures.ts";
import {
  buildStreamlineParams,
  decodeTraceMeta,
  STREAMLINE_PARAMS_BYTE_LENGTH,
  TRACE_META_BYTE_LENGTH,
} from "./streamlineParams.ts";
import { traceFieldLinesWebgpu } from "./streamlines.ts";

// Node-side (no GPU): the std430 byte-layout mirrors, the reason-code mapping, the WGSL structural
// contract, and the CPU-side validation that fails before any device work. The GPU≡CPU≡pypic equivalence
// is the local-only streamlines.browser.test.ts (test:gpu).

const RESOLVED: ResolvedTraceParams = {
  atol: 1e-6,
  rtol: 1e-3,
  stepSizeInit: 0.5,
  minStep: 1e-8,
  maxStep: 2,
  maxSteps: 200,
  direction: "forward",
  components: ["B_1", "B_2", "B_3"],
  fieldName: "B",
  nullThreshold: 1e-12,
  loopTol: 0.5,
  loopMinArclen: 5,
};

const GRID: GridInfo = {
  dimensions: [8, 9, 10],
  spacing: [0.5, 0.25, 2],
  origin: [1, 2, 3],
  geometry: "cartesian",
  axisLabels: ["x", "y", "z"],
  dt: null,
  boundary: null,
  survivingAxes: null,
  stagger: null,
};

describe("buildStreamlineParams — std430 byte layout", () => {
  it("packs every field at its mirrored offset", () => {
    const buf = buildStreamlineParams(RESOLVED, GRID, 201, 3);
    expect(buf.byteLength).toBe(STREAMLINE_PARAMS_BYTE_LENGTH);
    const v = new DataView(buf);
    expect(v.getUint32(0, true)).toBe(8); // nx
    expect(v.getUint32(4, true)).toBe(9); // ny
    expect(v.getUint32(8, true)).toBe(10); // nz
    expect(v.getFloat32(12, true)).toBe(1); // ox
    expect(v.getFloat32(16, true)).toBe(2); // oy
    expect(v.getFloat32(20, true)).toBe(3); // oz
    expect(v.getFloat32(24, true)).toBe(2); // invDx = 1/0.5
    expect(v.getFloat32(28, true)).toBe(4); // invDy = 1/0.25
    expect(v.getFloat32(32, true)).toBe(0.5); // invDz = 1/2
    expect(v.getFloat32(36, true)).toBe(Math.fround(1e-6)); // atol
    expect(v.getFloat32(40, true)).toBe(Math.fround(1e-3)); // rtol
    expect(v.getFloat32(44, true)).toBe(0.5); // stepInit
    expect(v.getFloat32(48, true)).toBe(Math.fround(1e-8)); // minStep
    expect(v.getFloat32(52, true)).toBe(2); // maxStep
    expect(v.getFloat32(56, true)).toBe(Math.fround(1e-12)); // nullThreshold
    expect(v.getFloat32(60, true)).toBe(0.5); // loopTol
    expect(v.getFloat32(64, true)).toBe(5); // loopMinArclen
    expect(v.getUint32(68, true)).toBe(1); // loopEnabled
    expect(v.getUint32(72, true)).toBe(200); // maxSteps
    expect(v.getUint32(76, true)).toBe(201); // capacity
    expect(v.getUint32(80, true)).toBe(3); // nWork
  });

  it("encodes a disabled closed-loop as loopEnabled = 0", () => {
    const buf = buildStreamlineParams({ ...RESOLVED, loopTol: null }, GRID, 11, 1);
    const v = new DataView(buf);
    expect(v.getFloat32(60, true)).toBe(0); // placeholder threshold
    expect(v.getUint32(68, true)).toBe(0);
  });
});

describe("decodeTraceMeta", () => {
  it("reads the index-th 16-byte TraceMeta record", () => {
    const buf = new ArrayBuffer(TRACE_META_BYTE_LENGTH * 2);
    const v = new DataView(buf);
    v.setUint32(16, 5, true); // nPoints
    v.setUint32(20, REASON_CODES.closed_loop, true); // reason
    v.setUint32(24, 4, true); // nSteps
    v.setFloat32(28, 0.25, true); // maxLocalError
    const m = decodeTraceMeta(buf, 1);
    expect(m).toEqual({ nPoints: 5, reason: 4, nSteps: 4, maxLocalError: 0.25 });
  });
});

describe("REASON_CODES / reasonFromCode", () => {
  it("round-trips every reason code", () => {
    for (const [name, code] of Object.entries(REASON_CODES)) {
      expect(reasonFromCode(code)).toBe(name);
    }
  });
  it("throws on an unknown code", () => {
    expect(() => reasonFromCode(99)).toThrow(/unknown termination reason/);
  });
});

describe("STREAMLINE_WGSL structural contract", () => {
  it("declares the entry, all 7 bindings, both structs, and the workgroup size", () => {
    expect(STREAMLINE_WGSL).toContain(`fn ${STREAMLINE_ENTRY}`);
    for (let b = 0; b <= 6; b++) expect(STREAMLINE_WGSL).toContain(`@binding(${b})`);
    expect(STREAMLINE_WGSL).toContain("struct Params");
    expect(STREAMLINE_WGSL).toContain("struct TraceMeta");
    expect(STREAMLINE_WGSL).toContain(`@workgroup_size(${STREAMLINE_WORKGROUP_SIZE})`);
  });
});

describe("traceFieldLinesWebgpu — CPU-side validation (no device)", () => {
  const uniform = datasetFromFixture(TRACE_FIXTURES.uniform);
  const zeroField = makeDataset(
    {
      B_1: makeField("B_1", new Float64Array(8), [2, 2, 2]),
      B_2: makeField("B_2", new Float64Array(8), [2, 2, 2]),
      B_3: makeField("B_3", new Float64Array(8), [2, 2, 2]),
    },
    { grid: makeGrid([2, 2, 2]) },
  );

  it("rejects an out-of-domain seed before acquiring a device", async () => {
    await expect(traceFieldLinesWebgpu(uniform, [[100, 4, 4]])).rejects.toThrow(
      /outside the interpolation domain/,
    );
  });

  it("rejects a seed at a field null", async () => {
    await expect(traceFieldLinesWebgpu(zeroField, [[1, 1, 1]])).rejects.toThrow(/field null/);
  });

  it("rejects a terminate callback (CPU-only)", async () => {
    await expect(
      traceFieldLinesWebgpu(uniform, [[4, 4, 4]], { terminate: () => true }),
    ).rejects.toThrow(/terminate callbacks/);
  });
});

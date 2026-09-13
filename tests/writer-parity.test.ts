// Writer parity vs live pypic: a webpic-written Zarr v3 store must open through
// pypic.io.zarr.from_zarr with data, grid, normalization, and coords intact. Shells out
// to the sibling ../pypic (uv), so it's opt-in via WEBPIC_PYPIC_PARITY=1 like
// schema-parity. This is the check that caught zarrita's spec gaps (null fill_value,
// empty codec chain) that spec-strict zarr-python rejects.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FieldArray, FieldDataset } from "@containers/field_dataset.ts";
import { writeZarr } from "@data/writers/zarr.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { runPypic } from "../scripts/harness/pypic.ts";
import { makeDataset, makeField, makeGrid } from "./fixtures.ts";

const RUN_PYPIC = process.env.WEBPIC_PYPIC_PARITY === "1";

const CELLS = 2 * 3 * 4;

// Normalized units + no latex: what a webpic-written store carries into pypic.
const writerField = (
  name: string,
  data: Float32Array | Float64Array,
  overrides: Partial<FieldArray> = {},
): FieldArray => makeField(name, data, [2, 3, 4], { units: "normalized", latex: "", ...overrides });

function writerDataset(): FieldDataset {
  return makeDataset(
    {
      B_1: writerField(
        "B_1",
        Float32Array.from({ length: CELLS }, (_, i) => i + 1),
      ),
      B_2: writerField(
        "B_2",
        Float64Array.from({ length: CELLS }, (_, i) => (i + 1) / 3),
        {
          reduction: { axis: "z", op: "integrate", lengthAxes: 1 },
        },
      ),
    },
    {
      grid: {
        ...makeGrid([2, 3, 4], [0.5, 1, 2], [0, -1, 10]),
        dt: 0.1,
        boundary: ["periodic", "periodic", "periodic"],
      },
      normalization: {
        lengthRef: 0.005,
        timeRef: 1.77e-11,
        velocityRef: 299792458,
        bFieldRef: 0.32,
        eFieldRef: 9.6e7,
        densityRef: 1e18,
        massRef: 9.109e-31,
        chargeRef: 1.602e-19,
        speedOfLight: Number.POSITIVE_INFINITY,
      },
      species: [{ name: "electrons", charge: -1, mass: 1, charge_to_mass: -1 }],
      physics: { gamma: 5 / 3, c: Number.POSITIVE_INFINITY, relativistic: false, extra: {} },
      frame: "simulation",
      metadata: {
        run_name: "writer-parity",
        run: { name: "writer-parity-run", git_sha: "abc123" },
        simulation_toml: '[run]\nname = "writer-parity-run"\n',
      },
    },
  );
}

const READBACK_SCRIPT = `
import json, math, sys
import numpy as np
from pypic.io.zarr import from_zarr

fds = from_zarr(sys.argv[1])
b1 = np.asarray(fds["B_1"])
b2 = np.asarray(fds["B_2"])
print(json.dumps({
    "fields": sorted(fds.field_names()),
    "b1_dtype": str(b1.dtype),
    "b1_flat": b1.ravel().tolist(),
    "b2_dtype": str(b2.dtype),
    "b2_flat": b2.ravel().tolist(),
    "dimensions": list(fds.grid.dimensions),
    "spacing": list(fds.grid.spacing),
    "origin": list(fds.grid.origin),
    "dt": fds.grid.dt,
    "boundary": list(fds.grid.boundary),
    "geometry": fds.grid.geometry.type.value,
    "c_is_inf": math.isinf(fds.physics.c),
    "gamma": fds.physics.gamma,
    "relativistic": fds.physics.relativistic,
    "length_ref": fds.normalization.length_ref,
    "x_coords": fds.xr.coords["x"].values.tolist(),
    "run_name": fds.metadata.get("run_name"),
    "b1_reduction": fds.xr["B_1"].attrs.get("reduction"),
    "b2_reduction": fds.xr["B_2"].attrs.get("reduction"),
    "run_typed_name": fds.metadata["run"].name,
    "run_git_sha": fds.metadata["run"].git_sha,
    "simulation_toml": fds.metadata.get("simulation_toml"),
}))
`;

interface Readback {
  fields: string[];
  b1_dtype: string;
  b1_flat: number[];
  b2_dtype: string;
  b2_flat: number[];
  dimensions: number[];
  spacing: number[];
  origin: number[];
  dt: number;
  boundary: string[];
  geometry: string;
  c_is_inf: boolean;
  gamma: number;
  relativistic: boolean;
  length_ref: number;
  x_coords: number[];
  run_name: string | null;
  b1_reduction: Record<string, unknown> | null;
  b2_reduction: Record<string, unknown> | null;
  run_typed_name: string;
  run_git_sha: string;
  simulation_toml: string | null;
}

describe.skipIf(!RUN_PYPIC)("written store opens through live pypic from_zarr", () => {
  let readback: Readback;

  beforeAll(async () => {
    const storeDir = join(tmpdir(), "webpic-writer-parity.zarr");
    rmSync(storeDir, { recursive: true, force: true });

    const store = new Map<string, Uint8Array>();
    await writeZarr(writerDataset(), store);
    for (const [key, bytes] of store) {
      const file = join(storeDir, key);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }

    readback = runPypic<Readback>(["python", "-c", READBACK_SCRIPT, storeDir]);
    // Timeout sized to the spawnSync budget — concurrent uv invocations (schema-parity
    // shells out too) contend on the project env and can exceed the vitest default.
  }, 120_000);

  it("reconstructs the field arrays in their written dtypes", () => {
    expect(readback.fields).toEqual(["B_1", "B_2"]);
    expect(readback.b1_dtype).toBe("float32");
    expect(readback.b1_flat).toEqual(Array.from({ length: CELLS }, (_, i) => i + 1));
    expect(readback.b2_dtype).toBe("float64");
    expect(readback.b2_flat).toEqual(Array.from({ length: CELLS }, (_, i) => (i + 1) / 3));
  });

  it("reconstructs grid, physics (inf sentinel), and normalization", () => {
    expect(readback.dimensions).toEqual([2, 3, 4]);
    expect(readback.spacing).toEqual([0.5, 1, 2]);
    expect(readback.origin).toEqual([0, -1, 10]);
    expect(readback.dt).toBe(0.1);
    expect(readback.boundary).toEqual(["periodic", "periodic", "periodic"]);
    expect(readback.geometry).toBe("cartesian");
    expect(readback.c_is_inf).toBe(true);
    expect(readback.gamma).toBeCloseTo(5 / 3, 15);
    expect(readback.relativistic).toBe(false);
    expect(readback.length_ref).toBe(0.005);
  });

  it("carries cell-centered coordinates and metadata through xarray", () => {
    expect(readback.x_coords).toEqual([0.25, 0.75]);
    expect(readback.run_name).toBe("writer-parity");
  });

  it("preserves attrs.reduction verbatim through pypic", () => {
    expect(readback.b1_reduction).toBeNull();
    expect(readback.b2_reduction).toEqual({ axis: "z", op: "integrate", length_axes: 1 });
  });

  it("lifts attrs.run as a valid typed Run and attrs.simulation_toml verbatim", () => {
    // pypic's decode validates attrs.run strictly (Run.model_validate), so a passing
    // readback proves the lifted attr is schema-v1.0 conformant, not just present.
    expect(readback.run_typed_name).toBe("writer-parity-run");
    expect(readback.run_git_sha).toBe("abc123");
    expect(readback.simulation_toml).toBe('[run]\nname = "writer-parity-run"\n');
  });
});

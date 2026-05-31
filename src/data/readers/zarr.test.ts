import { afterEach, describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";
import type { DataHandle } from "./_protocols.ts";
import { createZarrConfidence, createZarrReader } from "./zarr.ts";

// Synthetic pypic-shaped Zarr v3 stores, built entirely in memory (no network, no
// fixtures). The reader is exercised through an injected openStore returning the Map.

const HANDLE: DataHandle = { kind: "url", url: "mem://test" };

const ROOT_ATTRS = {
  schema: { version: "1.0" },
  grid: { dimensions: [2, 2, 2], spacing: [0.5, 0.5, 0.5], lower: [0, 0, 0], upper: [1, 1, 1] },
  coordinates: { geometry: "cartesian", frame: "simulation", axis_labels: ["x", "y", "z"] },
  normalization: {
    length_ref: 0.005,
    time_ref: 1.77e-11,
    velocity_ref: 299792458,
    b_field_ref: 0.32,
    e_field_ref: 9.6e7,
    density_ref: 1e18,
    mass_ref: 9.109e-31,
    charge_ref: 1.602e-19,
    speed_of_light: "inf",
  },
  species: [{ name: "electrons", charge: -1, mass: 1, charge_to_mass: -1 }],
  physics: { relativistic: false, gamma_eos: 1.6666666666666667, extra: {} },
  time: { dt: 0.1 },
  metadata: { step: 0, run_name: "test" },
};

const B_ATTRS = (component: number) => ({
  long_name: `Magnetic field component ${component}`,
  units: "normalized",
  quantity_type: "b_field",
  si_unit: "T",
  latex: `$B_${component}$`,
  unit_dimension: [0, 1, -2, -1, 0, 0, 0],
});

function rowMajorStrides(shape: readonly number[]): number[] {
  const strides = new globalThis.Array<number>(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    strides[i] = acc;
    acc *= shape[i] ?? 1;
  }
  return strides;
}

type Loc = zarr.Location<Map<string, Uint8Array>>;

async function writeFloat32Field(
  root: Loc,
  name: string,
  shape: number[],
  data: Float32Array,
  attributes: Record<string, unknown>,
): Promise<void> {
  const arr = await zarr.create(root.resolve(`fields/${name}`), {
    dtype: "float32",
    shape,
    chunkShape: shape,
    attributes,
  });
  await zarr.set(arr, null, { data, shape, stride: rowMajorStrides(shape) });
}

async function writeCoord(root: Loc, name: string, length: number): Promise<void> {
  const arr = await zarr.create(root.resolve(`fields/${name}`), {
    dtype: "float64",
    shape: [length],
    chunkShape: [length],
  });
  await zarr.set(arr, null, 0);
}

// Single-step store: B_1/B_2/B_3 (B_2 carries a reduction), rho_c, species fields
// n_s0 + V_s0_1, an unrecognized `weird_thing`, and x/y/z coordinate arrays.
async function buildSingleStepStore(): Promise<Map<string, Uint8Array>> {
  const store = new Map<string, Uint8Array>();
  const root = zarr.root(store);
  await zarr.create(root, { attributes: ROOT_ATTRS });
  await zarr.create(root.resolve("fields"), { attributes: {} });

  await writeFloat32Field(
    root,
    "B_1",
    [2, 2, 2],
    Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    B_ATTRS(1),
  );
  await writeFloat32Field(
    root,
    "B_2",
    [2, 2, 2],
    Float32Array.from([10, 11, 12, 13, 14, 15, 16, 17]),
    {
      ...B_ATTRS(2),
      reduction: { axis: "z", op: "mean", length_axes: 1 },
    },
  );
  await writeFloat32Field(root, "B_3", [2, 2, 2], new Float32Array(8), B_ATTRS(3));
  await writeFloat32Field(root, "rho_c", [2, 2, 2], new Float32Array(8), {
    long_name: "Charge density",
    units: "normalized",
    quantity_type: "charge_density",
    si_unit: "C/m^3",
    latex: "$\\rho_c$",
    unit_dimension: null,
  });
  await writeFloat32Field(root, "n_s0", [2, 2, 2], new Float32Array(8), {
    quantity_type: "number_density",
  });
  await writeFloat32Field(root, "V_s0_1", [2, 2, 2], new Float32Array(8), {
    quantity_type: "velocity",
  });
  await writeFloat32Field(root, "weird_thing", [2, 2, 2], new Float32Array(8), {});

  for (const axis of ["x", "y", "z"]) await writeCoord(root, axis, 2);
  return store;
}

// Multi-step store: time=[0,1,2]; fields shaped (3,2,2,2). Step s holds values s*100 + i.
async function buildMultiStepStore(): Promise<Map<string, Uint8Array>> {
  const store = new Map<string, Uint8Array>();
  const root = zarr.root(store);
  await zarr.create(root, { attributes: ROOT_ATTRS });
  await zarr.create(root.resolve("fields"), { attributes: {} });

  const data = new Float32Array(3 * 8);
  for (let t = 0; t < 3; t++) for (let i = 0; i < 8; i++) data[t * 8 + i] = t * 100 + i;
  await writeFloat32Field(root, "B_1", [3, 2, 2, 2], data, B_ATTRS(1));

  await writeCoord(root, "time", 3);
  for (const axis of ["x", "y", "z"]) await writeCoord(root, axis, 2);
  return store;
}

async function rootOnlyStore(attrs: Record<string, unknown>): Promise<Map<string, Uint8Array>> {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: attrs });
  return store;
}

function readerFor(store: Map<string, Uint8Array>) {
  return createZarrReader({ openStore: () => store });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ZarrReader — schema gate", () => {
  it("reads a valid schema.version=1.0 store", async () => {
    const reader = readerFor(await buildSingleStepStore());
    await expect(reader.readTimestep(HANDLE, 0)).resolves.toBeDefined();
  });

  it("rejects a store with no schema discriminator", async () => {
    const reader = readerFor(await rootOnlyStore({ grid: {} }));
    await expect(reader.readTimestep(HANDLE, 0)).rejects.toThrow(/no pypic metadata/);
  });

  it("rejects a schema-version mismatch", async () => {
    const reader = readerFor(await rootOnlyStore({ ...ROOT_ATTRS, schema: { version: "2.0" } }));
    await expect(reader.readTimestep(HANDLE, 0)).rejects.toThrow(/schema.version="2.0"/);
  });

  it("rejects a store with no /fields group", async () => {
    const reader = readerFor(await rootOnlyStore(ROOT_ATTRS));
    await expect(reader.readTimestep(HANDLE, 0)).rejects.toThrow(/no \/fields group/);
  });
});

describe("ZarrReader — field listing", () => {
  it("lists canonical fields, excludes coords, warns on unrecognized arrays", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = readerFor(await buildSingleStepStore());
    const fields = await reader.availableFields(HANDLE, 0);
    expect(fields).toEqual(["B_1", "B_2", "B_3", "V_s0_1", "n_s0", "rho_c"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("weird_thing"));
  });

  it("maps every available field to itself (pypic writes canonical names)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = readerFor(await buildSingleStepStore());
    const mapping = await reader.availableFieldsMapping(HANDLE, 0);
    expect(mapping.B_1).toBe("B_1");
    expect(mapping.V_s0_1).toBe("V_s0_1");
    expect(Object.values(mapping).every((v) => v !== null)).toBe(true);
  });
});

describe("ZarrReader — single-step read", () => {
  it("returns typed-array field values in disk dtype with spatial shape", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = readerFor(await buildSingleStepStore());
    const ds = await reader.readTimestep(HANDLE, 0, { fields: ["B_1"] });
    const b1 = ds.fields.get("B_1");
    expect(b1?.data).toBeInstanceOf(Float32Array);
    expect(Array.from(b1?.data ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(b1?.shape).toEqual([2, 2, 2]);
    expect(b1?.meta.quantityType).toBe("b_field");
    expect(b1?.units).toBe("normalized");
    expect(ds.step).toBe(0);
  });

  it("decodes grid metadata (lower→origin, geometry, dt)", async () => {
    const reader = readerFor(await buildSingleStepStore());
    const ds = await reader.readTimestep(HANDLE, 0, { fields: ["B_1"] });
    expect(ds.grid.dimensions).toEqual([2, 2, 2]);
    expect(ds.grid.spacing).toEqual([0.5, 0.5, 0.5]);
    expect(ds.grid.origin).toEqual([0, 0, 0]);
    expect(ds.grid.geometry).toBe("cartesian");
    expect(ds.grid.axisLabels).toEqual(["x", "y", "z"]);
    expect(ds.grid.dt).toBe(0.1);
  });

  it("decodes normalization with the 'inf' speed-of-light sentinel", async () => {
    const reader = readerFor(await buildSingleStepStore());
    const ds = await reader.readTimestep(HANDLE, 0, { fields: ["B_1"] });
    expect(ds.normalization.lengthRef).toBe(0.005);
    expect(ds.normalization.chargeRef).toBe(1.602e-19);
    expect(ds.normalization.speedOfLight).toBe(Number.POSITIVE_INFINITY);
    expect(ds.physics.c).toBe(Number.POSITIVE_INFINITY);
    expect(ds.physics.relativistic).toBe(false);
  });

  it("carries reduction provenance verbatim, null when absent", async () => {
    const reader = readerFor(await buildSingleStepStore());
    const ds = await reader.readTimestep(HANDLE, 0, { fields: ["B_1", "B_2"] });
    expect(ds.fields.get("B_1")?.reduction).toBeNull();
    expect(ds.fields.get("B_2")?.reduction).toEqual({ axis: "z", op: "mean", lengthAxes: 1 });
  });

  it("carries decoded metadata verbatim", async () => {
    const reader = readerFor(await buildSingleStepStore());
    const ds = await reader.readTimestep(HANDLE, 0, { fields: ["B_1"] });
    expect(ds.metadata).toEqual({ step: 0, run_name: "test" });
    expect(ds.species).toEqual([{ name: "electrons", charge: -1, mass: 1, charge_to_mass: -1 }]);
  });

  it("rejects explicitly-requested unknown fields (KeyError mirror)", async () => {
    const reader = readerFor(await buildSingleStepStore());
    await expect(reader.readTimestep(HANDLE, 0, { fields: ["B_1", "NotAField"] })).rejects.toThrow(
      /not a known canonical field/,
    );
  });

  it("rejects a requested canonical field that is absent on disk", async () => {
    const reader = readerFor(await buildSingleStepStore());
    await expect(reader.readTimestep(HANDLE, 0, { fields: ["E_1"] })).rejects.toThrow(
      /not present in the store/,
    );
  });

  it("read-all skips unrecognized fields without throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = readerFor(await buildSingleStepStore());
    const ds = await reader.readTimestep(HANDLE, 0);
    expect([...ds.fields.keys()].sort()).toEqual(["B_1", "B_2", "B_3", "V_s0_1", "n_s0", "rho_c"]);
    expect(ds.fields.has("weird_thing")).toBe(false);
  });

  it("accepts per-species fields (registry gap bridged by _sN stripping)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = readerFor(await buildSingleStepStore());
    const ds = await reader.readTimestep(HANDLE, 0, { fields: ["n_s0", "V_s0_1"] });
    expect(ds.fields.has("n_s0")).toBe(true);
    expect(ds.fields.has("V_s0_1")).toBe(true);
  });

  it("rejects a nonzero step on a single-step store", async () => {
    const reader = readerFor(await buildSingleStepStore());
    await expect(reader.readTimestep(HANDLE, 1, { fields: ["B_1"] })).rejects.toThrow(
      /only step 0/,
    );
  });
});

describe("ZarrReader — multi-step read", () => {
  it("enumerates timestep indices from the time array", async () => {
    const reader = readerFor(await buildMultiStepStore());
    expect(await reader.availableTimesteps(HANDLE)).toEqual([0, 1, 2]);
  });

  it("slices the requested timestep, dropping the time axis", async () => {
    const reader = readerFor(await buildMultiStepStore());
    const ds = await reader.readTimestep(HANDLE, 1, { fields: ["B_1"] });
    const b1 = ds.fields.get("B_1");
    expect(b1?.shape).toEqual([2, 2, 2]);
    expect(Array.from(b1?.data ?? [])).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
    expect(ds.step).toBe(1);
  });

  it("rejects an out-of-range step", async () => {
    const reader = readerFor(await buildMultiStepStore());
    await expect(reader.readTimestep(HANDLE, 9, { fields: ["B_1"] })).rejects.toThrow(
      /out of range/,
    );
  });
});

describe("ZarrReader — cancellation", () => {
  it("rejects with AbortError when the signal is already aborted", async () => {
    const reader = readerFor(await buildSingleStepStore());
    const controller = new AbortController();
    controller.abort();
    let error: unknown;
    try {
      await reader.readTimestep(HANDLE, 0, { fields: ["B_1"], signal: controller.signal });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("aborts between per-field reads when the signal fires mid-read", async () => {
    // Map subclass that aborts the first time a chunk (".../c/...") is read.
    class AbortOnChunkRead extends Map<string, Uint8Array> {
      constructor(private readonly controller: AbortController) {
        super();
      }
      override get(key: string): Uint8Array | undefined {
        if (key.includes("/c/")) this.controller.abort();
        return super.get(key);
      }
    }
    const plain = await buildSingleStepStore();
    const controller = new AbortController();
    const aborting = new AbortOnChunkRead(controller);
    for (const [k, v] of plain) aborting.set(k, v);

    const reader = createZarrReader({ openStore: () => aborting });
    let error: unknown;
    try {
      await reader.readTimestep(HANDLE, 0, {
        fields: ["B_1", "B_2", "B_3"],
        signal: controller.signal,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("zarrConfidence", () => {
  it("scores a pypic store 1 and a non-pypic store 0", async () => {
    const probe = createZarrConfidence((handle) =>
      handle.kind === "url" && handle.url === "mem://pypic"
        ? buildSingleStepStore()
        : rootOnlyStore({ not: "pypic" }),
    );
    expect(await probe({ kind: "url", url: "mem://pypic" })).toBe(1);
    expect(await probe({ kind: "url", url: "mem://other" })).toBe(0);
  });
});

import type {
  FieldArray,
  FieldDataset,
  GridInfo,
  Normalization,
  PhysicsParams,
} from "@containers/field_dataset.ts";
import type { DataHandle } from "@data/readers/_protocols.ts";
import { createZarrConfidence, createZarrReader } from "@data/readers/zarr.ts";
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";
import { makeDataset, makeField, makeGrid } from "../../../tests/fixtures.ts";
import { encodePypicAttrs, toJsonNative, writeZarr } from "./zarr.ts";

// The writer is proven against the production reader: write to an in-memory Map, read back
// through createZarrReader, compare. On-disk layout is additionally pinned by inspecting the
// raw zarr.json documents (the pypic from_zarr contract).

const HANDLE: DataHandle = { kind: "url", url: "mem://written" };

const GRID: GridInfo = {
  ...makeGrid([2, 3, 4], [0.5, 1, 2], [0, -1, 10]),
  dt: 0.1,
  boundary: ["periodic", "periodic", "periodic"],
};

const NORMALIZATION: Normalization = {
  lengthRef: 0.005,
  timeRef: 1.77e-11,
  velocityRef: 299792458,
  bFieldRef: 0.32,
  eFieldRef: 9.6e7,
  densityRef: 1e18,
  massRef: 9.109e-31,
  chargeRef: 1.602e-19,
  speedOfLight: Number.POSITIVE_INFINITY,
};

const PHYSICS: PhysicsParams = {
  gamma: 5 / 3,
  c: Number.POSITIVE_INFINITY,
  relativistic: false,
  extra: { code: "webpic-test" },
};

// Normalized units + no latex: what a webpic-written store carries, and what the reader compares.
const writerField = (name: string, data: Float32Array | Float64Array): FieldArray =>
  makeField(name, data, GRID.dimensions, { units: "normalized", latex: "" });

function rampF32(n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => i + 1);
}

function rampF64(n: number): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => (i + 1) / 3);
}

const CELLS = 2 * 3 * 4;

function writerDataset(overrides: Partial<FieldDataset> = {}): FieldDataset {
  return makeDataset(
    {
      B_1: writerField("B_1", rampF32(CELLS)),
      B_2: writerField("B_2", rampF64(CELLS)),
    },
    {
      grid: GRID,
      normalization: NORMALIZATION,
      species: [{ name: "electrons", charge: -1, mass: 1, charge_to_mass: -1 }],
      physics: PHYSICS,
      frame: "simulation",
      metadata: { run_name: "writer-test", nested: { a: 1 } },
      ...overrides,
    },
  );
}

async function writeToMap(dataset: FieldDataset): Promise<Map<string, Uint8Array>> {
  const store = new Map<string, Uint8Array>();
  await writeZarr(dataset, store);
  return store;
}

function readerFor(store: Map<string, Uint8Array>) {
  return createZarrReader({ openStore: () => store });
}

function rootAttrsOf(store: Map<string, Uint8Array>): Record<string, unknown> {
  const raw = store.get("/zarr.json");
  if (raw === undefined) throw new Error("no root zarr.json written");
  const doc = JSON.parse(new TextDecoder().decode(raw)) as { attributes: Record<string, unknown> };
  return doc.attributes;
}

describe("writeZarr — reader round-trip", () => {
  it("round-trips field data with dtype and shape preserved", async () => {
    const reader = readerFor(await writeToMap(writerDataset()));
    const ds = await reader.readTimestep(HANDLE, 0);

    const b1 = ds.fields.get("B_1");
    expect(b1?.data).toBeInstanceOf(Float32Array);
    expect(Array.from(b1?.data ?? [])).toEqual(Array.from(rampF32(CELLS)));
    expect(b1?.shape).toEqual([2, 3, 4]);
    expect(b1?.meta.quantityType).toBe("b_field");
    expect(b1?.units).toBe("normalized");

    const b2 = ds.fields.get("B_2");
    expect(b2?.data).toBeInstanceOf(Float64Array);
    expect(Array.from(b2?.data ?? [])).toEqual(Array.from(rampF64(CELLS)));
  });

  it("round-trips grid, normalization (inf sentinel), physics, species, metadata", async () => {
    const reader = readerFor(await writeToMap(writerDataset()));
    const ds = await reader.readTimestep(HANDLE, 0, { fields: ["B_1"] });

    expect(ds.grid.dimensions).toEqual(GRID.dimensions);
    expect(ds.grid.spacing).toEqual(GRID.spacing);
    expect(ds.grid.origin).toEqual(GRID.origin);
    expect(ds.grid.geometry).toBe("cartesian");
    expect(ds.grid.axisLabels).toEqual(["x", "y", "z"]);
    expect(ds.grid.dt).toBe(0.1);
    expect(ds.grid.boundary).toEqual(["periodic", "periodic", "periodic"]);

    expect(ds.normalization).toEqual(NORMALIZATION);
    expect(ds.physics.gamma).toBeCloseTo(5 / 3, 15);
    expect(ds.physics.c).toBe(Number.POSITIVE_INFINITY);
    expect(ds.physics.relativistic).toBe(false);
    expect(ds.physics.extra).toEqual({ code: "webpic-test" });
    expect(ds.species).toEqual([{ name: "electrons", charge: -1, mass: 1, charge_to_mass: -1 }]);
    expect(ds.metadata).toEqual({ run_name: "writer-test", nested: { a: 1 } });
  });

  it("is a single-step store: one timestep, coords excluded from the field listing", async () => {
    const store = await writeToMap(writerDataset());
    const reader = readerFor(store);
    expect(await reader.availableTimesteps(HANDLE)).toEqual([0]);
    expect(await reader.availableFields(HANDLE, 0)).toEqual(["B_1", "B_2"]);
  });

  it("scores 1 on the zarr confidence probe", async () => {
    const store = await writeToMap(writerDataset());
    const probe = createZarrConfidence(() => store);
    expect(await probe(HANDLE)).toBe(1);
  });

  it("writes stagger as the tagged grid.stagger dict (reader destaggers on load)", async () => {
    const stagger = {
      convention: "staggered" as const,
      fieldLocations: { B_1: "face_x" },
      position: { B_1: [0.5, 0, 0] as const },
      interpolationOrder: 2,
      notes: null,
    };
    const store = await writeToMap(writerDataset({ grid: { ...GRID, stagger } }));
    const gridAttrs = rootAttrsOf(store).grid as Record<string, unknown>;
    expect(gridAttrs.stagger).toEqual({
      __pypic_class__: "StaggerInfo",
      convention: "staggered",
      field_locations: { B_1: "face_x" },
      position: { B_1: [0.5, 0, 0] },
      interpolation_order: 2,
      notes: null,
    });
    // Read-back proof the tag decodes: the reader recognizes the stagger and destaggers
    // to cell centers, stamping its own colocated-grid note.
    const ds = await readerFor(store).readTimestep(HANDLE, 0, { fields: ["B_1"] });
    expect(ds.grid.stagger?.convention).toBe("cell");
  });

  it("round-trips reduction provenance verbatim, omitting unset optional keys", async () => {
    const full: FieldArray["reduction"] = {
      axis: ["y", "z"],
      op: "integrate",
      weight: "n_s0",
      lengthAxes: 2,
    };
    const minimal: FieldArray["reduction"] = { axis: "z", op: "mean" };
    const dataset = writerDataset({
      fields: new Map([
        ["B_1", { ...writerField("B_1", rampF32(CELLS)), reduction: full }],
        ["B_2", { ...writerField("B_2", rampF64(CELLS)), reduction: minimal }],
      ]),
    });
    const reader = readerFor(await writeToMap(dataset));
    const ds = await reader.readTimestep(HANDLE, 0);
    expect(ds.fields.get("B_1")?.reduction).toEqual(full);
    expect(ds.fields.get("B_2")?.reduction).toEqual(minimal);
  });

  it("round-trips Map-valued metadata via the keyed_dict tag", async () => {
    const metadata = { lookup: new Map<unknown, unknown>([[1, "one"]]) };
    const reader = readerFor(await writeToMap(writerDataset({ metadata })));
    const ds = await reader.readTimestep(HANDLE, 0, { fields: ["B_1"] });
    expect(ds.metadata).toEqual({ lookup: new Map([[1, "one"]]) });
  });

  it("round-trips reserved metadata (run / simulation_toml / model) through the lift", async () => {
    const metadata = {
      run_name: "writer-test",
      run: { name: "test-run", authors: [{ name: "Leo" }] },
      simulation_toml: '[run]\nname = "test-run"\n',
      model: { model_name: "mhd" },
    };
    const reader = readerFor(await writeToMap(writerDataset({ metadata })));
    const ds = await reader.readTimestep(HANDLE, 0, { fields: ["B_1"] });
    expect(ds.metadata).toEqual(metadata);
  });
});

describe("writeZarr — on-disk layout (pypic schema-v1.0 mirror)", () => {
  it("writes the root attrs sections pypic from_zarr expects", async () => {
    const attrs = rootAttrsOf(await writeToMap(writerDataset()));
    expect(attrs.schema).toEqual({ version: "1.0" });
    expect(attrs.grid).toEqual({
      dimensions: [2, 3, 4],
      spacing: [0.5, 1, 2],
      lower: [0, -1, 10],
      upper: [1, 2, 18],
    });
    expect(attrs.coordinates).toEqual({
      geometry: "cartesian",
      frame: "simulation",
      axis_labels: ["x", "y", "z"],
    });
    expect(attrs.time).toEqual({ dt: 0.1 });
    expect(attrs.boundary_conditions).toEqual({
      lower: ["periodic", "periodic", "periodic"],
      upper: ["periodic", "periodic", "periodic"],
    });
    expect((attrs.normalization as Record<string, unknown>).speed_of_light).toBe("inf");
    expect((attrs.normalization as Record<string, unknown>).length_ref).toBe(0.005);
    expect(attrs.physics).toEqual({
      relativistic: false,
      gamma_eos: 5 / 3,
      extra: { code: "webpic-test" },
    });
  });

  it("omits time/boundary_conditions/transforms sections when the dataset has none", async () => {
    const attrs = rootAttrsOf(
      await writeToMap(writerDataset({ grid: { ...GRID, dt: null, boundary: null } })),
    );
    expect(attrs.time).toBeUndefined();
    expect(attrs.boundary_conditions).toBeUndefined();
    expect((attrs.coordinates as Record<string, unknown>).transforms).toBeUndefined();
  });

  it("writes self-describing field attrs from the registry meta", async () => {
    const store = await writeToMap(writerDataset());
    const raw = store.get("/fields/B_1/zarr.json");
    const doc = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())) as {
      attributes: Record<string, unknown>;
      dimension_names?: string[];
    };
    expect(doc.attributes.units).toBe("normalized");
    expect(doc.attributes.quantity_type).toBe("b_field");
    expect(doc.attributes.si_unit).toBe("T");
    expect(doc.attributes.latex).toBe("$B_1$");
    expect(doc.dimension_names).toEqual(["x", "y", "z"]);
  });

  it("writes attrs.reduction in pypic's snake_case shape, absent when null", async () => {
    const dataset = writerDataset({
      fields: new Map([
        [
          "B_1",
          {
            ...writerField("B_1", rampF32(CELLS)),
            reduction: { axis: "x", op: "argmax", resultKind: "axis_position" },
          },
        ],
        ["B_2", writerField("B_2", rampF64(CELLS))],
      ]),
    });
    const store = await writeToMap(dataset);
    const attrsOf = (name: string): Record<string, unknown> => {
      const raw = store.get(`/fields/${name}/zarr.json`);
      const doc = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())) as {
        attributes: Record<string, unknown>;
      };
      return doc.attributes;
    };
    expect(attrsOf("B_1").reduction).toEqual({
      axis: "x",
      op: "argmax",
      result_kind: "axis_position",
    });
    expect(attrsOf("B_2").reduction).toBeUndefined();
  });

  it("lifts reserved metadata keys to root attrs, not into attrs.metadata", async () => {
    const attrs = rootAttrsOf(
      await writeToMap(
        writerDataset({
          metadata: {
            run_name: "writer-test",
            run: { name: "test-run" },
            simulation_toml: '[run]\nname = "test-run"\n',
          },
        }),
      ),
    );
    expect(attrs.run).toEqual({ name: "test-run" });
    expect(attrs.simulation_toml).toBe('[run]\nname = "test-run"\n');
    expect(attrs.metadata).toEqual({ run_name: "writer-test" });
  });

  it("writes cell-centered coordinate arrays (origin + (i+0.5)·dx)", async () => {
    const store = await writeToMap(writerDataset());
    const x = await zarr.open(zarr.root(store).resolve("fields/x"), { kind: "array" });
    const y = await zarr.open(zarr.root(store).resolve("fields/y"), { kind: "array" });
    expect(Array.from((await zarr.get(x, null)).data as Float64Array)).toEqual([0.25, 0.75]);
    expect(Array.from((await zarr.get(y, null)).data as Float64Array)).toEqual([-0.5, 0.5, 1.5]);
  });
});

describe("writeZarr — options and validation", () => {
  it("downcasts to float32 on request", async () => {
    const store = new Map<string, Uint8Array>();
    await writeZarr(writerDataset(), store, { dtype: "float32" });
    const ds = await readerFor(store).readTimestep(HANDLE, 0, { fields: ["B_2"] });
    const b2 = ds.fields.get("B_2");
    expect(b2?.data).toBeInstanceOf(Float32Array);
    expect(b2?.data[0]).toBeCloseTo(1 / 3, 6);
  });

  it("rejects a field whose shape disagrees with the grid", async () => {
    const bad = writerField("B_1", rampF32(8));
    const dataset = writerDataset({
      fields: new Map([["B_1", { ...bad, shape: [2, 2, 2] }]]),
    });
    await expect(writeZarr(dataset, new Map())).rejects.toThrow(/does not match/);
  });

  it("rejects a field name that collides with a coordinate array", async () => {
    const dataset = writerDataset({
      fields: new Map([["x", writerField("B_1", rampF32(CELLS))]]),
    });
    await expect(writeZarr(dataset, new Map())).rejects.toThrow(/collides with a coordinate/);
  });

  it("rejects a non-string metadata.simulation_toml and a non-object metadata.run", async () => {
    await expect(
      writeZarr(writerDataset({ metadata: { simulation_toml: 42 } }), new Map()),
    ).rejects.toThrow(/simulation_toml must be a string/);
    await expect(
      writeZarr(writerDataset({ metadata: { run: "not-a-record" } }), new Map()),
    ).rejects.toThrow(/run must be a JSON object/);
  });

  it("rejects mismatched grid dimension/spacing lengths loudly", async () => {
    const dataset = writerDataset({ grid: { ...GRID, spacing: [0.5, 1] } });
    await expect(writeZarr(dataset, new Map())).rejects.toThrow(/lengths disagree/);
  });

  it("rejects with AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let error: unknown;
    try {
      await writeZarr(writerDataset(), new Map(), { signal: controller.signal });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("toJsonNative", () => {
  it("passes JSON-native values through and flattens typed arrays", () => {
    expect(toJsonNative({ a: [1, "two", true, null] })).toEqual({ a: [1, "two", true, null] });
    expect(toJsonNative(Float32Array.from([1, 2]))).toEqual([1, 2]);
  });

  it("tags Maps as keyed_dict", () => {
    expect(toJsonNative(new Map([[1, "one"]]))).toEqual({
      __pypic_class__: "keyed_dict",
      items: [[1, "one"]],
    });
  });

  it("throws on non-finite numbers and non-JSON values", () => {
    expect(() => toJsonNative(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => toJsonNative({ f: () => 0 })).toThrow(/cannot encode/);
  });
});

describe("encodePypicAttrs", () => {
  it("is the inverse of the reader's decode for the identity sections", () => {
    const attrs = encodePypicAttrs(writerDataset());
    expect(Object.keys(attrs).sort()).toEqual([
      "boundary_conditions",
      "coordinates",
      "grid",
      "metadata",
      "normalization",
      "physics",
      "schema",
      "species",
      "time",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { decodeGrid, decodeReduction, decodeSpeedOfLight, fromJsonNative } from "./decode.ts";

describe("fromJsonNative", () => {
  it("decodes the tuple sentinel to a plain array", () => {
    expect(fromJsonNative({ __pypic_class__: "tuple", items: [1, 2, 3] })).toEqual([1, 2, 3]);
  });

  it("decodes the keyed_dict sentinel to a Map", () => {
    const decoded = fromJsonNative({
      __pypic_class__: "keyed_dict",
      items: [
        [1, "a"],
        [2, "b"],
      ],
    });
    expect(decoded).toBeInstanceOf(Map);
    expect((decoded as Map<number, string>).get(2)).toBe("b");
  });

  it("recurses through plain objects and arrays, stripping the class marker", () => {
    const decoded = fromJsonNative({
      run_name: "x",
      shape: { __pypic_class__: "tuple", items: [4, 3, 2] },
      nested: [{ __pypic_class__: "tuple", items: [1] }],
    });
    expect(decoded).toEqual({ run_name: "x", shape: [4, 3, 2], nested: [[1]] });
  });

  it("leaves bare 'inf' strings untouched (only speed_of_light decodes it)", () => {
    expect(fromJsonNative({ note: "inf" })).toEqual({ note: "inf" });
  });
});

describe("decodeSpeedOfLight", () => {
  it("maps the 'inf' sentinel and null to Infinity", () => {
    expect(decodeSpeedOfLight("inf")).toBe(Number.POSITIVE_INFINITY);
    expect(decodeSpeedOfLight(null)).toBe(Number.POSITIVE_INFINITY);
    expect(decodeSpeedOfLight(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it("passes finite values through", () => {
    expect(decodeSpeedOfLight(299792458)).toBe(299792458);
  });
});

describe("decodeGrid", () => {
  const rootAttrs = {
    grid: { dimensions: [4, 3, 2], spacing: [0.5, 0.5, 1.0], lower: [-1, 0, 2] },
    coordinates: { geometry: "cartesian", frame: "GSM", axis_labels: ["x", "y", "z"] },
    time: { dt: 0.02 },
    boundary_conditions: {
      lower: ["periodic", "open", "periodic"],
      upper: ["periodic", "open", "periodic"],
    },
  };

  it("maps grid.lower to GridInfo.origin and carries grid metadata", () => {
    const { grid, frame } = decodeGrid(rootAttrs, "test");
    expect(grid.origin).toEqual([-1, 0, 2]);
    expect(grid.dimensions).toEqual([4, 3, 2]);
    expect(grid.spacing).toEqual([0.5, 0.5, 1.0]);
    expect(grid.geometry).toBe("cartesian");
    expect(grid.axisLabels).toEqual(["x", "y", "z"]);
    expect(grid.dt).toBe(0.02);
    expect(grid.boundary).toEqual(["periodic", "open", "periodic"]);
    expect(frame).toBe("GSM");
  });

  it("defaults origin to zeros and frame to 'simulation' when absent", () => {
    const { grid, frame } = decodeGrid(
      { grid: { dimensions: [2, 2], spacing: [1, 1] }, coordinates: { geometry: "cartesian" } },
      "test",
    );
    expect(grid.origin).toEqual([0, 0]);
    expect(grid.dt).toBeNull();
    expect(grid.boundary).toBeNull();
    expect(frame).toBe("simulation");
  });
});

describe("decodeReduction", () => {
  it("camelCases the reduction block and carries it verbatim", () => {
    const spec = decodeReduction({ axis: ["y", "z"], op: "mean", weight: "rho_m", length_axes: 2 });
    expect(spec).toEqual({ axis: ["y", "z"], op: "mean", weight: "rho_m", lengthAxes: 2 });
  });

  it("omits absent optional keys (exactOptionalPropertyTypes)", () => {
    const spec = decodeReduction({ axis: "z", op: "sum" });
    expect(spec).toEqual({ axis: "z", op: "sum" });
    expect(spec && "lengthAxes" in spec).toBe(false);
    expect(spec && "weight" in spec).toBe(false);
  });

  it("returns null when no reduction is present", () => {
    expect(decodeReduction(undefined)).toBeNull();
    expect(decodeReduction(null)).toBeNull();
  });
});

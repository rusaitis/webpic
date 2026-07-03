import { describe, expect, it } from "vitest";
import {
  datasetLabel,
  type FieldMetaRow,
  fieldButtonLabel,
  fieldMetaRows,
  orderedFieldNames,
  stepAt,
  stepIndex,
  stepReadout,
} from "./topBarInfo.ts";

const byLabel = (rows: readonly FieldMetaRow[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.label, r.value]));

describe("datasetLabel", () => {
  it("resolves a known dataset id to its catalog label", () => {
    expect(datasetLabel("fluxrope")).toBe("Flux rope");
    expect(datasetLabel("dipole")).toBe("Dipole");
  });

  it("falls back to the id for an unknown dataset", () => {
    expect(datasetLabel("mystery")).toBe("mystery");
  });

  it("prefers the typed attrs.run name over the catalog", () => {
    expect(datasetLabel("fluxrope", { run: { name: "run-001" } })).toBe("run-001");
  });

  it("falls back to re-parsing simulation_toml when attrs.run has no name", () => {
    const toml = '[run]\nname = "gem-challenge"\n';
    expect(datasetLabel("fluxrope", { simulation_toml: toml })).toBe("gem-challenge");
    // an attrs.run WITHOUT a name still defers to the TOML (the DESIGN §Run metadata chain)
    expect(datasetLabel("fluxrope", { run: { git_sha: "abc" }, simulation_toml: toml })).toBe(
      "gem-challenge",
    );
  });

  it("degrades to the catalog on malformed/empty run metadata, never throwing", () => {
    expect(datasetLabel("fluxrope", {})).toBe("Flux rope");
    expect(datasetLabel("fluxrope", { run: "not-a-table" })).toBe("Flux rope");
    expect(datasetLabel("fluxrope", { run: { name: "" } })).toBe("Flux rope");
    expect(datasetLabel("fluxrope", { simulation_toml: "not = valid = toml" })).toBe("Flux rope");
  });
});

describe("orderedFieldNames", () => {
  it("returns the available list unchanged when the active field is present", () => {
    expect(orderedFieldNames(["B_1", "B_2", "|B|"], "B_2")).toEqual(["B_1", "B_2", "|B|"]);
  });

  it("prepends the active field when it isn't in the computed set yet", () => {
    expect(orderedFieldNames(["B_1", "B_2"], "|B|")).toEqual(["|B|", "B_1", "B_2"]);
  });
});

describe("fieldButtonLabel", () => {
  it("uses the registry long name for a known field", () => {
    expect(fieldButtonLabel("|B|")).toBe("Magnetic field magnitude");
  });

  it("degrades to the raw name for an unknown field, never throwing", () => {
    expect(() => fieldButtonLabel("not_a_field")).not.toThrow();
    expect(fieldButtonLabel("not_a_field")).toBe("not_a_field");
  });
});

describe("fieldMetaRows", () => {
  it("lists name/quantity/unit/latex for a known field", () => {
    const rows = byLabel(fieldMetaRows("|B|"));
    expect(rows.Name).toBe("|B|");
    expect(rows.Quantity).toBe("Magnetic field magnitude");
    expect(rows.Unit).toBe("T");
    expect(rows.LaTeX).toBe("$|B|$");
  });

  it("shows an em dash for a dimensionless field's empty unit", () => {
    const rows = byLabel(fieldMetaRows("beta")); // plasma beta — dimensionless
    expect(rows.Quantity).toBe("Plasma beta");
    expect(rows.Unit).toBe("—");
  });

  it("returns a name-only row for an unknown field, never throwing", () => {
    expect(() => fieldMetaRows("nope")).not.toThrow();
    expect(fieldMetaRows("nope")).toEqual([{ label: "Name", value: "nope" }]);
  });
});

describe("timestep index ↔ value math", () => {
  const steps = [0, 5, 10, 25]; // sparse / non-contiguous

  it("stepIndex maps a step value to its slider index, clamping unknowns to 0", () => {
    expect(stepIndex(10, steps)).toBe(2);
    expect(stepIndex(0, steps)).toBe(0);
    expect(stepIndex(7, steps)).toBe(0); // not in domain → 0
  });

  it("stepAt maps a slider index back to its step value", () => {
    expect(stepAt(2, steps)).toBe(10);
    expect(stepAt(2.4, steps)).toBe(10); // rounds to the nearest index
    expect(stepAt(9, steps)).toBeUndefined(); // out of range
    expect(stepAt(0, [])).toBeUndefined(); // empty domain
  });

  it("stepReadout renders the value, or an em dash on an empty domain", () => {
    expect(stepReadout(1, steps)).toBe("step 5");
    expect(stepReadout(0, [])).toBe("—");
  });
});

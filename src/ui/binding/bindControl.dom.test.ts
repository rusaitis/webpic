import { fieldInfo } from "@schema/registry.ts";
import { afterEach, describe, expect, it } from "vitest";
import { createPane } from "../controls/index.ts";
import { bindControl } from "./controlDescriptor.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function folder() {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return createPane({ parent }).addFolder({ title: "f" });
}

describe("bindControl", () => {
  it("resolves the label from the registry for a canonical field name", () => {
    const f = folder();
    const handle = bindControl(f, {
      kind: "slider",
      canonicalName: "|B|",
      value: 0,
      min: 0,
      max: 1,
      onChange: () => {},
    });
    const info = fieldInfo("|B|");
    const expected = info.siUnit ? `${info.longName} (${info.siUnit})` : info.longName;
    expect(handle.element.querySelector(".webpic-row_label")?.textContent).toBe(expected);
  });

  it("prefers an explicit label over the canonical name", () => {
    const f = folder();
    const handle = bindControl(f, {
      kind: "select",
      label: "Mode",
      value: "a",
      options: [{ label: "A", value: "a" }],
      onChange: () => {},
    });
    expect(handle.element.querySelector(".webpic-row_label")?.textContent).toBe("Mode");
  });

  it("dispatches the bound onChange", () => {
    const f = folder();
    const seen: boolean[] = [];
    const handle = bindControl(f, {
      kind: "checkbox",
      label: "Flag",
      value: false,
      onChange: (v) => seen.push(v as boolean),
    });
    const input = handle.element.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (input === null) throw new Error("no input");
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(seen).toEqual([true]);
  });

  it("throws loudly on an unknown canonical name", () => {
    const f = folder();
    expect(() =>
      bindControl(f, {
        kind: "text",
        canonicalName: "not_a_field",
        value: "",
        onChange: () => {},
      }),
    ).toThrow(/Unknown field name/);
  });
});

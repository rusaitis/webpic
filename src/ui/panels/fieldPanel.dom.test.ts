import { createSimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { fieldArray, makeDataset } from "../../../tests/fixtures.ts";
import { installFieldPanel } from "./fieldPanel.ts";
import { installPlaceholderPanel } from "./placeholderPanel.ts";

// B+E+J triples → |B|, |E|, |J| are all TS-computable, so the selector has 3 real options.
function multiFieldDataset() {
  const triple = (prefix: string) => ({
    [`${prefix}_1`]: fieldArray(`${prefix}_1`, new Float32Array([3]), [1]),
    [`${prefix}_2`]: fieldArray(`${prefix}_2`, new Float32Array([4]), [1]),
    [`${prefix}_3`]: fieldArray(`${prefix}_3`, new Float32Array([0]), [1]),
  });
  return makeDataset({ ...triple("B"), ...triple("E"), ...triple("J") });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("field panel (wired)", () => {
  it("lists computable fields, dispatches selectField, and mirrors external selection", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = createSimulationStore();
    store.getState().setDataset(multiFieldDataset());

    const dispose = installFieldPanel(host, store);
    const select = host.querySelector("select");
    if (select === null) throw new Error("no field select");
    expect([...select.options].map((o) => o.value)).toEqual(["|B|", "|E|", "|J|"]);

    select.value = "|E|";
    select.dispatchEvent(new Event("change"));
    expect(store.getState().activeField).toBe("|E|");

    store.getState().selectField("|J|"); // dispatched elsewhere → control reflects it
    expect(select.value).toBe("|J|");

    dispose();
    expect(host.querySelector("select")).toBeNull();
  });
});

describe("placeholder panel", () => {
  it("renders its note and cleans up on dispose", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const dispose = installPlaceholderPanel(host, "Layers", "No layers yet");
    expect(host.querySelector(".webpic-placeholder")?.textContent).toBe("No layers yet");
    dispose();
    expect(host.querySelector(".webpic-pane")).toBeNull();
  });
});

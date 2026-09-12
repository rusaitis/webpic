import { createPerfStore, createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { makeDataset, makeField } from "../../../tests/fixtures.ts";
import { flushAsync } from "../../../tests/helpers.ts";
import { installDevWindow } from "./devWindow.ts";

// B triple → a seeded volume layer once a dataset loads (so Phong is enabled).
const bTriple = () =>
  makeDataset({
    B_1: makeField("B_1", new Float32Array([3]), [1]),
    B_2: makeField("B_2", new Float32Array([4]), [1]),
    B_3: makeField("B_3", new Float32Array([0]), [1]),
  });

function el<T extends HTMLElement>(root: ParentNode, sel: string): T {
  const found = root.querySelector<T>(sel);
  if (found === null) throw new Error(`missing ${sel}`);
  return found;
}

// The window hosts more than one checkbox now (Frame timing "Measure" + Shading "Phong"), so target a
// control by its row label rather than the first match.
function rowInput(root: ParentNode, label: string): HTMLInputElement {
  const row = [...root.querySelectorAll<HTMLElement>(".webpic-row")].find(
    (r) => r.querySelector(".webpic-row_label")?.textContent === label,
  );
  if (row === undefined) throw new Error(`missing row ${label}`);
  return el<HTMLInputElement>(row, ".webpic-checkbox_input");
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("developer window", () => {
  it("mounts a titled floating window hosting the frame-timing + Phong controls", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installDevWindow(document.body, store, createPerfStore(), createUiStore());

    const win = el(document.body, ".webpic-window");
    expect(el(win, ".webpic-window_title").textContent).toBe("Developer");
    expect(rowInput(win, "Phong").disabled).toBe(false); // volume layer → Phong enabled
    expect(rowInput(win, "Measure (continuous)")).not.toBeNull(); // the GPU frame-time instrument

    dispose();
    expect(document.body.querySelector(".webpic-window")).toBeNull();
  });

  it("dismisses via the header close button", () => {
    const store = createSimulationStore();
    const uiStore = createUiStore();
    const dispose = installDevWindow(document.body, store, createPerfStore(), uiStore);
    const win = el(document.body, ".webpic-window");
    expect(win.hidden).toBe(true); // closed on boot
    uiStore.getState().setPanelVisible("dev", true);
    expect(win.hidden).toBe(false);

    el<HTMLButtonElement>(win, ".webpic-window_close").click();
    expect(win.hidden).toBe(true);

    dispose();
  });

  it("hides with the global UI toggle", () => {
    const store = createSimulationStore();
    const uiStore = createUiStore();
    const dispose = installDevWindow(document.body, store, createPerfStore(), uiStore);
    const win = el(document.body, ".webpic-window");
    uiStore.getState().setPanelVisible("dev", true); // the UI toggle only matters once opened
    expect(win.hidden).toBe(false);

    uiStore.getState().setUiVisible(false);
    expect(win.hidden).toBe(true);

    uiStore.getState().setUiVisible(true);
    expect(win.hidden).toBe(false);

    dispose();
  });
});

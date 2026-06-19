import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { fieldArray, makeDataset } from "../../../tests/fixtures.ts";
import { flushAsync } from "../../../tests/helpers.ts";
import { installColorbar } from "./colorbar.ts";

const bTriple = () =>
  makeDataset({
    B_1: fieldArray("B_1", new Float32Array([3]), [1]),
    B_2: fieldArray("B_2", new Float32Array([4]), [1]),
    B_3: fieldArray("B_3", new Float32Array([0]), [1]),
  });

function el<T extends HTMLElement>(root: ParentNode, sel: string): T {
  const found = root.querySelector<T>(sel);
  if (found === null) throw new Error(`missing ${sel}`);
  return found;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("floating colorbar", () => {
  it("mounts a bottom-docked horizontal strip and captions the active field", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColorbar(document.body, store, createUiStore());

    const bar = el(document.body, ".webpic-cbar");
    expect(bar.dataset.edge).toBe("bottom");
    const canvas = el<HTMLCanvasElement>(bar, "canvas");
    expect(canvas.width).toBe(360); // horizontal orientation pixel size
    expect(canvas.height).toBe(24);

    const { selectedLayerId, layers, colormapBindings } = store.getState();
    const bindingId = layers.find((l) => l.id === selectedLayerId)?.colormapBindingId ?? "";
    expect(el(bar, ".webpic-cbar_caption").textContent).toBe(colormapBindings[bindingId]?.field);
    // Five tick labels span the window.
    expect(bar.querySelectorAll(".webpic-cbar_tick")).toHaveLength(5);

    dispose();
    expect(document.body.querySelector(".webpic-cbar")).toBeNull();
  });

  it("toggles the settings popover from the gear, hosting the colormap controls", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColorbar(document.body, store, createUiStore());

    const gear = el<HTMLButtonElement>(document.body, ".webpic-cbar_settings");
    const pop = el(document.body, ".webpic-cbar-pop");
    expect(pop.hidden).toBe(true);

    gear.click();
    expect(pop.hidden).toBe(false);
    expect(gear.getAttribute("aria-expanded")).toBe("true");
    // The popover hosts the colormap + scale selects.
    expect(pop.querySelectorAll(".webpic-select").length).toBeGreaterThanOrEqual(2);

    gear.click();
    expect(pop.hidden).toBe(true);

    dispose();
    expect(document.body.querySelector(".webpic-cbar-pop")).toBeNull();
  });

  it("collapses and expands via the chevron", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColorbar(document.body, store, createUiStore());

    const bar = el(document.body, ".webpic-cbar");
    const collapse = el<HTMLButtonElement>(bar, ".webpic-cbar_collapse");
    expect(bar.classList.contains("collapsed")).toBe(false);

    collapse.click();
    expect(bar.classList.contains("collapsed")).toBe(true);
    expect(collapse.getAttribute("aria-pressed")).toBe("true");

    collapse.click();
    expect(bar.classList.contains("collapsed")).toBe(false);

    dispose();
  });

  it("hides with the global UI toggle and closes the popover", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const uiStore = createUiStore();
    const dispose = installColorbar(document.body, store, uiStore);

    const bar = el(document.body, ".webpic-cbar");
    const gear = el<HTMLButtonElement>(document.body, ".webpic-cbar_settings");
    const pop = el(document.body, ".webpic-cbar-pop");

    gear.click();
    expect(pop.hidden).toBe(false);

    uiStore.getState().setUiVisible(false);
    expect(bar.hidden).toBe(true);
    expect(pop.hidden).toBe(true); // popover dismissed with the chrome

    uiStore.getState().setUiVisible(true);
    expect(bar.hidden).toBe(false);

    dispose();
  });
});

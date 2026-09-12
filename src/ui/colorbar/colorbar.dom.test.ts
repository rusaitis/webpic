import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { makeDataset, makeField } from "../../../tests/fixtures.ts";
import { flushAsync } from "../../../tests/helpers.ts";
import { installColorbar } from "./colorbar.ts";

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
    const field = colormapBindings[bindingId]?.field ?? "";
    // The expanded caption shows the field key plus its SI unit in brackets (|B| → tesla).
    expect(el(bar, ".webpic-cbar_caption").textContent).toBe(`${field} [T]`);
    // The caption stacks inside its section (above the gradient on a horizontal dock), one
    // section per shown binding inside main.
    expect(
      bar.querySelector(".webpic-cbar_main > .webpic-cbar_sec > .webpic-cbar_caption"),
    ).not.toBeNull();
    expect(bar.querySelectorAll(".webpic-cbar_sec")).toHaveLength(1);
    // A single binding shows no soft-warn badge.
    expect(el(bar, ".webpic-cbar_warn").hidden).toBe(true);
    // Nice-number ticks span the window — the count follows the range, not a fixed 5.
    const tickEls = bar.querySelectorAll<HTMLElement>(".webpic-cbar_tick");
    expect(tickEls.length).toBeGreaterThanOrEqual(2);
    for (const tick of tickEls) {
      const t = Number(tick.style.getPropertyValue("--t"));
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
      expect(tick.textContent).not.toBe("");
    }

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
    // The popover hosts the swatch colormap picker + the segmented scale pill.
    expect(pop.querySelector(".webpic-swatch")).not.toBeNull();
    expect(pop.querySelector(".webpic-segmented")).not.toBeNull();

    gear.click();
    expect(pop.hidden).toBe(true);

    dispose();
    expect(document.body.querySelector(".webpic-cbar-pop")).toBeNull();
  });

  it("collapses and expands when the bar is clicked, ignoring the gear", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColorbar(document.body, store, createUiStore());

    const bar = el<HTMLElement>(document.body, ".webpic-cbar");
    const gear = el<HTMLButtonElement>(bar, ".webpic-cbar_settings");
    const { selectedLayerId, layers, colormapBindings } = store.getState();
    const bindingId = layers.find((l) => l.id === selectedLayerId)?.colormapBindingId ?? "";
    expect(bar.classList.contains("collapsed")).toBe(false);

    // A click anywhere on the bar toggles collapse (no chevron)...
    bar.click();
    expect(bar.classList.contains("collapsed")).toBe(true);
    // ...and the field key is mirrored onto the over-gradient mini-label.
    expect(el(bar, ".webpic-cbar_minilabel").textContent).toBe(colormapBindings[bindingId]?.field);

    bar.click();
    expect(bar.classList.contains("collapsed")).toBe(false);

    // The gear opens the popover without collapsing the bar.
    gear.click();
    expect(bar.classList.contains("collapsed")).toBe(false);

    dispose();
  });

  it("stacks a second strip per distinct visible binding and drops it when the layer hides", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColorbar(document.body, store, createUiStore());
    const bar = el(document.body, ".webpic-cbar");
    expect(bar.querySelectorAll(".webpic-cbar_sec")).toHaveLength(1);

    // A second layer mints a second binding → a second captioned strip, no warn.
    store.getState().addVolumeLayer();
    await flushAsync();
    const sections = bar.querySelectorAll<HTMLElement>(".webpic-cbar_sec");
    expect(sections).toHaveLength(2);
    for (const sec of sections) {
      expect(sec.querySelector(".webpic-cbar_caption")?.textContent).toBe("|B| [T]");
      expect(sec.querySelector("canvas")).not.toBeNull();
    }
    expect(el(bar, ".webpic-cbar_warn").hidden).toBe(true);
    // The added layer is auto-selected → its strip carries the active cue, the first recedes.
    expect(sections[0]?.dataset.active).toBe("false");
    expect(sections[1]?.dataset.active).toBe("true");

    // Hiding the second layer drops its binding from the stack (and the cue, single strip again).
    const secondId = store.getState().layers[1]?.id ?? "";
    store.getState().setLayerVisible(secondId, false);
    expect(bar.querySelectorAll(".webpic-cbar_sec")).toHaveLength(1);
    expect(el<HTMLElement>(bar, ".webpic-cbar_sec").dataset.active).toBeUndefined();

    dispose();
  });

  it("soft-warns with +N when visible layers reference more than two distinct bindings", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bTriple());
    await flushAsync();
    const dispose = installColorbar(document.body, store, createUiStore());
    store.getState().addVolumeLayer();
    store.getState().addSliceLayer(); // third distinct binding — over the two-strip cap
    await flushAsync();

    const bar = el(document.body, ".webpic-cbar");
    expect(bar.querySelectorAll(".webpic-cbar_sec")).toHaveLength(2);
    const warn = el(bar, ".webpic-cbar_warn");
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toBe("+1");
    expect(warn.title).toContain("3 colormaps among visible layers");

    // The newest layer is selected; its binding displaces the last slot so the gear's target
    // stays on screen — the first layer's binding keeps slot one.
    const { layers } = store.getState();
    const sections = bar.querySelectorAll<HTMLElement>(".webpic-cbar_sec");
    expect(sections[0]?.dataset.active).toBe("false");
    expect(sections[1]?.dataset.active).toBe("true");
    // The displaced (second) layer's field is named in the tooltip.
    expect(warn.title).toContain(layers[1]?.field ?? "");

    // Re-showing fewer bindings clears the warn.
    store.getState().setLayerVisible(layers[1]?.id ?? "", false);
    expect(el(bar, ".webpic-cbar_warn").hidden).toBe(true);
    expect(bar.querySelectorAll(".webpic-cbar_sec")).toHaveLength(2);

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

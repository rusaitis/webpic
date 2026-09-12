import { createPerfStore, createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { vectorTriple } from "../../tests/fixtures.ts";
import { installUi } from "./install.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("installUi", () => {
  it("mounts chrome, wires the toggle shortcut, and tears everything down on dispose", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const simulationStore = createSimulationStore();
    simulationStore.getState().setDataset(vectorTriple("B", { array: Float32Array }));
    const uiStore = createUiStore();

    const dispose = installUi({ parent, simulationStore, perfStore: createPerfStore(), uiStore });
    // The default config docks no panels, so the shell stays unrendered; the Developer tool is a
    // floating window instead — use it as the UI-toggle-hidden chrome probe.
    expect(parent.querySelector(".webpic-shell")).toBeNull();
    const win = parent.querySelector<HTMLElement>(".webpic-window");
    if (win === null) throw new Error("developer window not mounted");
    expect(document.getElementById("webpic-ui-styles")).not.toBeNull();
    expect(parent.style.getPropertyValue("--webpic-bg")).not.toBe("");

    // Default toggle shortcut is "F".
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));
    expect(uiStore.getState().isUiVisible).toBe(false);
    expect(win.hidden).toBe(true);

    // "T" adds a field-lines layer (owned here, not by the camera); Shift+T is nobody's.
    const layerCount = simulationStore.getState().layers.length;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "T", shiftKey: true }));
    expect(simulationStore.getState().layers).toHaveLength(layerCount);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
    expect(simulationStore.getState().layers).toHaveLength(layerCount + 1);
    expect(simulationStore.getState().layers.at(-1)?.kind).toBe("fieldlines");

    dispose();
    // Idempotent: a defensive second dispose must not re-run every surface's teardown.
    dispose();
    expect(parent.querySelector(".webpic-window")).toBeNull();
    expect(document.getElementById("webpic-ui-styles")).toBeNull();
    expect(parent.style.getPropertyValue("--webpic-bg")).toBe("");

    // Shortcut listener is gone — a later key press must not flip state.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));
    expect(uiStore.getState().isUiVisible).toBe(false);
  });
});

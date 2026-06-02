import { createSimulationStore, createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { vectorTriple } from "../../tests/fixtures.ts";
import { installUi } from "./install.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("installUi", () => {
  it("mounts the shell, wires the toggle shortcut, and tears everything down on dispose", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const simulationStore = createSimulationStore();
    simulationStore.getState().setDataset(vectorTriple("B", { array: Float32Array }));
    const uiStore = createUiStore();

    const dispose = installUi({ parent, simulationStore, uiStore });
    const shell = parent.querySelector<HTMLElement>(".webpic-shell");
    if (shell === null) throw new Error("shell not mounted");
    expect(document.getElementById("webpic-ui-styles")).not.toBeNull();
    expect(parent.style.getPropertyValue("--webpic-bg")).not.toBe("");

    // Default toggle shortcut is "F".
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));
    expect(uiStore.getState().isUiVisible).toBe(false);
    expect(shell.hidden).toBe(true);

    dispose();
    expect(parent.querySelector(".webpic-shell")).toBeNull();
    expect(document.getElementById("webpic-ui-styles")).toBeNull();
    expect(parent.style.getPropertyValue("--webpic-bg")).toBe("");

    // Shortcut listener is gone — a later key press must not flip state.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));
    expect(uiStore.getState().isUiVisible).toBe(false);
  });
});

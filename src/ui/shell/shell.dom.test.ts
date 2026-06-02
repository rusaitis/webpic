import { createUiStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { createShell } from "./shell.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("createShell", () => {
  it("hosts each panel, docks to the requested side, and reacts to uiStore", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const uiStore = createUiStore();
    const shell = createShell({ parent, dockedSide: "left", panels: ["a", "b"], uiStore });

    expect(shell.root.dataset.side).toBe("left");
    expect(shell.panelHost("a").dataset.panel).toBe("a");
    expect(() => shell.panelHost("missing")).toThrow(/unknown panel/);

    uiStore.getState().toggleUi();
    expect(shell.root.hidden).toBe(true);
    uiStore.getState().toggleUi();
    expect(shell.root.hidden).toBe(false);

    uiStore.getState().setPanelVisible("a", false);
    expect(shell.panelHost("a").hidden).toBe(true);
    expect(shell.panelHost("b").hidden).toBe(false);
  });

  it("stops reacting after dispose", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const uiStore = createUiStore();
    const shell = createShell({ parent, dockedSide: "right", panels: ["a"], uiStore });
    shell.dispose();
    expect(parent.querySelector(".webpic-shell")).toBeNull();
    expect(() => uiStore.getState().toggleUi()).not.toThrow(); // unsubscribed, no stale DOM write
  });
});

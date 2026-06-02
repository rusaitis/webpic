import { createSimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { vectorTriple } from "../../../tests/fixtures.ts";
import { mountPanel } from "./registry.ts";

// happy-dom: the registry resolves a name to its installer and falls back to a placeholder
// for an unknown name, so a theme's custom panel list never breaks the shell layout.

function host() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("mountPanel", () => {
  it("installs a registered panel and tears it down on dispose", () => {
    const store = createSimulationStore();
    store.getState().setDataset(vectorTriple("B", { array: Float32Array }));
    const h = host();
    const dispose = mountPanel("field", h, store);
    expect(h.querySelector("select")).not.toBeNull(); // the field selector rendered
    dispose();
    expect(h.querySelector(".webpic-pane")).toBeNull();
  });

  it("falls back to a placeholder for an unknown panel name", () => {
    const h = host();
    const dispose = mountPanel("does-not-exist", h, createSimulationStore());
    expect(h.querySelector(".webpic-placeholder")?.textContent).toBe("Coming soon");
    dispose();
    expect(h.querySelector(".webpic-pane")).toBeNull();
  });
});

import { createSimulationStore, createUiStore, DEFAULT_POSE } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { installCameraRail } from "./cameraRail.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function setup() {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const store = createSimulationStore();
  const uiStore = createUiStore();
  const dispose = installCameraRail(parent, store, uiStore);
  disposers.push(dispose);
  const rail = parent.querySelector<HTMLElement>(".webpic-rail");
  if (rail === null) throw new Error("rail not mounted");
  const button = (control: string): HTMLButtonElement => {
    const el = rail.querySelector<HTMLButtonElement>(`[data-control="${control}"]`);
    if (el === null) throw new Error(`missing rail button: ${control}`);
    return el;
  };
  return { parent, store, uiStore, rail, button, dispose };
}

// A clipboard stub that records writes; returns a restore fn. happy-dom has no clipboard otherwise.
function stubClipboard(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  Object.defineProperty(window.navigator, "clipboard", {
    value: {
      writeText: (text: string): Promise<void> => {
        writes.push(text);
        return Promise.resolve();
      },
    },
    configurable: true,
  });
  return {
    writes,
    restore: () =>
      Object.defineProperty(window.navigator, "clipboard", {
        value: undefined,
        configurable: true,
      }),
  };
}

describe("installCameraRail", () => {
  it("mounts the five controls: gnomon, fly, projection, coord, help", () => {
    const { rail, button } = setup();
    expect(rail.querySelectorAll(".webpic-rail_btn")).toHaveLength(5);
    for (const control of ["gnomon", "fly", "projection", "coord", "help"]) {
      expect(button(control)).toBeInstanceOf(window.HTMLButtonElement);
    }
  });

  it("the fly button toggles isFlyMode and reflects it on aria-pressed", () => {
    const { store, button } = setup();
    const fly = button("fly");
    expect(store.getState().isFlyMode).toBe(false);
    expect(fly.getAttribute("aria-pressed")).toBe("false");
    fly.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().isFlyMode).toBe(true);
    expect(fly.getAttribute("aria-pressed")).toBe("true");
    // External state change (e.g. the N shortcut) reflects back onto the button.
    store.getState().setFlyMode(false);
    expect(fly.getAttribute("aria-pressed")).toBe("false");
  });

  it("the projection button toggles perspective⇄orthographic", () => {
    const { store, button } = setup();
    const proj = button("projection");
    expect(store.getState().projection).toBe("perspective");
    proj.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().projection).toBe("orthographic");
    expect(proj.getAttribute("aria-pressed")).toBe("true");
    proj.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().projection).toBe("perspective");
  });

  it("the gnomon button toggles overlay.showGnomon and the has-gnomon inset", () => {
    const { store, rail, button } = setup();
    const gnomon = button("gnomon");
    // Default overlay shows the gnomon, so the rail reserves its footprint.
    expect(store.getState().overlay.showGnomon).toBe(true);
    expect(rail.classList.contains("has-gnomon")).toBe(true);
    expect(gnomon.getAttribute("aria-pressed")).toBe("true");
    gnomon.dispatchEvent(new MouseEvent("click"));
    expect(store.getState().overlay.showGnomon).toBe(false);
    expect(rail.classList.contains("has-gnomon")).toBe(false); // re-centers across full width
    expect(gnomon.getAttribute("aria-pressed")).toBe("false");
  });

  it("the help button toggles the help overlay", () => {
    const { uiStore, button } = setup();
    expect(uiStore.getState().isHelpVisible).toBe(false);
    button("help").dispatchEvent(new MouseEvent("click"));
    expect(uiStore.getState().isHelpVisible).toBe(true);
  });

  it("the coord button copies a ?pose= permalink and flashes is-copied", async () => {
    const clip = stubClipboard();
    try {
      const { button } = setup();
      const coord = button("coord");
      coord.dispatchEvent(new MouseEvent("click"));
      await Promise.resolve(); // the writeText .then sets the copied flash
      expect(clip.writes).toHaveLength(1);
      expect(clip.writes[0]).toContain("pose=");
      expect(clip.writes[0]).not.toContain("proj="); // perspective default — no param
      expect(coord.classList.contains("is-copied")).toBe(true);
    } finally {
      clip.restore();
    }
  });

  it("the copied link carries the projection so an ortho view reopens as ortho", async () => {
    const clip = stubClipboard();
    try {
      const { store, button } = setup();
      store.getState().setProjection("orthographic");
      button("coord").dispatchEvent(new MouseEvent("click"));
      await Promise.resolve();
      expect(clip.writes[0]).toContain("proj=ortho");
    } finally {
      clip.restore();
    }
  });

  it("the coord click is a no-op without a clipboard (insecure origin)", () => {
    const { button } = setup();
    const coord = button("coord");
    coord.dispatchEvent(new MouseEvent("click")); // no clipboard stubbed → silent no-op
    expect(coord.classList.contains("is-copied")).toBe(false);
  });

  it("the coord tooltip tracks the live pose", () => {
    const { store, button } = setup();
    expect(button("coord").title).toContain(`d ${DEFAULT_POSE.distance.toFixed(2)}`);
    store
      .getState()
      .setCameraPose({ target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 9.99, roll: 0 });
    expect(button("coord").title).toContain("d 9.99");
  });

  it("hides with the global UI toggle", () => {
    const { uiStore, rail } = setup();
    expect(rail.hidden).toBe(false);
    uiStore.getState().toggleUi();
    expect(rail.hidden).toBe(true);
    uiStore.getState().toggleUi();
    expect(rail.hidden).toBe(false);
  });

  it("removes the container on dispose", () => {
    const { parent, dispose } = setup();
    dispose();
    expect(parent.querySelector(".webpic-rail")).toBeNull();
  });
});

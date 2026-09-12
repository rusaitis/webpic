import { createSimulationStore } from "@store";
import { afterEach, describe, expect, it } from "vitest";
import { makeDataset, makeField, makeGrid } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";
import { installPointerSeedPlacer } from "./pointerSeedPlacer.ts";

// happy-dom: a primary canvas click while in placement mode appends a seed (CPU pick), and is inert
// otherwise. The canvas rect is stubbed (happy-dom returns zeros), the camera is the default pose.

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

// A 4³ uniform field with a real grid for the seed rake + the box geometry.
const traceableDataset = () => {
  const n = 4;
  const size = n * n * n;
  return makeDataset(
    {
      B_1: makeField("B_1", new Float64Array(size), [n, n, n]),
      B_2: makeField("B_2", new Float64Array(size), [n, n, n]),
      B_3: makeField("B_3", new Float64Array(size).fill(1), [n, n, n]),
    },
    { grid: makeGrid([n, n, n]) },
  );
};

function setup() {
  const target = document.createElement("div");
  document.body.appendChild(target);
  target.getBoundingClientRect = () =>
    ({ width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0 }) as DOMRect;
  const store = createSimulationStore();
  disposers.push(installPointerSeedPlacer(target, store));
  return { target, store };
}

const click = (target: HTMLElement, x: number, y: number): void => {
  target.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: x,
      clientY: y,
    }),
  );
};

const seedCount = (store: ReturnType<typeof createSimulationStore>): number => {
  const layer = store.getState().layers.find((l) => l.kind === "fieldlines");
  return layer?.kind === "fieldlines" ? layer.seeds.length : 0;
};

async function withFieldlines() {
  const context = setup();
  context.store.getState().setDataset(traceableDataset());
  await flushAsync();
  context.store.getState().addFieldlinesLayer(); // layer-1
  await flushAsync();
  return context;
}

describe("installPointerSeedPlacer", () => {
  it("a center click while placing appends a seed to the layer", async () => {
    const { target, store } = await withFieldlines();
    const before = seedCount(store);
    store.getState().setSeedPlacement("layer-1");
    click(target, 50, 50); // center → ray through the box → a midpoint seed
    expect(seedCount(store)).toBe(before + 1);
  });

  it("a click is inert when not in placement mode", async () => {
    const { target, store } = await withFieldlines();
    const before = seedCount(store);
    click(target, 50, 50); // seedPlacementLayerId is null → falls through
    expect(seedCount(store)).toBe(before);
  });

  it("Escape leaves placement mode", async () => {
    const { target, store } = await withFieldlines();
    store.getState().setSeedPlacement("layer-1");
    target.ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(store.getState().seedPlacementLayerId).toBeNull();
  });
});

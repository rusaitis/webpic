import type { GridInfo } from "@containers/field_dataset.ts";
import type { RenderWorkerRequest } from "@render";
import { parseTheme } from "@schema";
import { createSimulationStore } from "@store";
import { describe, expect, it } from "vitest";
import { fieldArray, makeDataset } from "../../tests/fixtures.ts";
import { buildOverlayPayload, installSceneSync, resolveOverlayColors } from "./sceneSync.ts";

const grid3d = (overrides: Partial<GridInfo> = {}): GridInfo => ({
  dimensions: [10, 4, 3],
  spacing: [0.5, 1, 2],
  origin: [0, -5, 2],
  geometry: "cartesian",
  axisLabels: ["x", "y", "z"],
  dt: null,
  boundary: null,
  survivingAxes: null,
  stagger: null,
  ...overrides,
});

// A volume dataset with a real 3D grid so sceneSync forwards meaningful bounds.
const volumeDataset = (grid: GridInfo = grid3d()) =>
  makeDataset(
    {
      B_1: fieldArray("B_1", new Float32Array([3]), [1]),
      B_2: fieldArray("B_2", new Float32Array([4]), [1]),
      B_3: fieldArray("B_3", new Float32Array([0]), [1]),
    },
    { grid },
  );

describe("buildOverlayPayload", () => {
  const colors = resolveOverlayColors();

  it("derives physical bounds per field axis from origin + spacing*dim", () => {
    const payload = buildOverlayPayload(
      createSimulationStore().getState().overlay,
      grid3d(),
      colors,
    );
    expect(payload.axes.map((a) => a.bounds)).toEqual([
      [0, 5], // 0 + 0.5*10
      [-5, -1], // -5 + 1*4
      [2, 8], // 2 + 2*3
    ]);
    expect(payload.axes.map((a) => a.label)).toEqual(["x", "y", "z"]);
  });

  it("falls back to voxel indices when the grid lacks usable spacing", () => {
    const payload = buildOverlayPayload(
      createSimulationStore().getState().overlay,
      grid3d({ spacing: [0, 0, 0] }),
      colors,
    );
    expect(payload.axes.map((a) => a.bounds)).toEqual([
      [0, 10],
      [0, 4],
      [0, 3],
    ]);
  });

  it("forwards the store flags and divisions verbatim", () => {
    const store = createSimulationStore();
    store.getState().setOverlayPlane("yz", true);
    store.getState().setGridDivisions(12);
    const payload = buildOverlayPayload(store.getState().overlay, grid3d(), colors);
    expect(payload.planes).toEqual({ xy: true, yz: true, xz: false });
    expect(payload.tick.targetCount).toBe(12);
    expect(payload.planePosition).toBe("center");
  });

  it("handles a null grid (no dataset) with degenerate unit axes", () => {
    const payload = buildOverlayPayload(createSimulationStore().getState().overlay, null, colors);
    expect(payload.axes.map((a) => a.bounds)).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
  });
});

describe("resolveOverlayColors", () => {
  it("uses the gnomon palette when no theme is given", () => {
    const colors = resolveOverlayColors();
    expect(colors.axes.x).toEqual([0.878, 0.424, 0.459, 1]);
    expect(colors.grid[3]).toBeCloseTo(0.16, 5);
  });

  it("prefers theme values per channel, falling back for the unset ones", () => {
    const theme = {
      colors: { grid: [0.1, 0.2, 0.3, 0.5] as const },
      axes: { x: [1, 0, 0, 1] as const },
    } as unknown as Parameters<typeof resolveOverlayColors>[0];
    const colors = resolveOverlayColors(theme);
    expect(colors.grid).toEqual([0.1, 0.2, 0.3, 0.5]);
    expect(colors.axes.x).toEqual([1, 0, 0, 1]);
    expect(colors.axes.y).toEqual([0.596, 0.765, 0.475, 1]); // fallback (theme.axes.y unset)
  });
});

interface Post {
  readonly message: RenderWorkerRequest;
}

function harness(ready: boolean) {
  const posts: Post[] = [];
  const worker = {
    postMessage: (message: RenderWorkerRequest) => {
      posts.push({ message });
    },
  } as unknown as Worker;
  let isReady = ready;
  const store = createSimulationStore();
  const sync = installSceneSync({ store, worker, isReady: () => isReady });
  return { store, posts, sync, setReady: (v: boolean) => (isReady = v) };
}

describe("installSceneSync", () => {
  it("stays silent until the worker is ready", () => {
    const { store, posts } = harness(false);
    store.getState().setDataset(volumeDataset());
    store.getState().setOverlayShowGrid(false);
    expect(posts).toHaveLength(0);
  });

  it("flushAll posts the current overlay with bounds from the seeded dataset", () => {
    const { store, posts, sync, setReady } = harness(false);
    store.getState().setDataset(volumeDataset());
    setReady(true);
    sync.flushAll();

    const msg = posts.at(-1)?.message;
    if (msg?.kind !== "setSceneOverlay" || msg.overlay === null) {
      throw new Error("expected a setSceneOverlay with a config");
    }
    expect(msg.overlay.show.grid).toBe(true);
    expect(msg.overlay.planes).toEqual({ xy: true, yz: false, xz: false });
    expect(msg.overlay.axes[0]?.bounds).toEqual([0, 5]);
  });

  it("re-posts on a flag change while ready", () => {
    const { store, posts, setReady } = harness(true);
    store.getState().setDataset(volumeDataset());
    posts.length = 0;
    setReady(true);
    store.getState().setOverlayPlane("yz", true);

    const msg = posts.at(-1)?.message;
    if (msg?.kind !== "setSceneOverlay" || msg.overlay === null) {
      throw new Error("expected a setSceneOverlay");
    }
    expect(msg.overlay.planes.yz).toBe(true);
  });

  it("re-posts with new bounds when the dataset changes", () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(volumeDataset());
    posts.length = 0;
    store
      .getState()
      .setDataset(volumeDataset(grid3d({ origin: [10, 10, 10], spacing: [1, 1, 1] })));

    const overlayPosts = posts.filter((p) => p.message.kind === "setSceneOverlay");
    const last = overlayPosts.at(-1)?.message;
    if (last?.kind !== "setSceneOverlay" || last.overlay === null) {
      throw new Error("expected a setSceneOverlay");
    }
    expect(last.overlay.axes[0]?.bounds).toEqual([10, 20]); // 10 + 1*10
  });

  it("does not post on an identity-skip no-op", () => {
    const { store, posts } = harness(true);
    store.getState().setDataset(volumeDataset());
    posts.length = 0;
    store.getState().setOverlayShowGrid(true); // already true → store returns same ref, no fire
    expect(posts).toHaveLength(0);
  });

  it("stops posting after dispose", () => {
    const { store, posts, sync } = harness(true);
    store.getState().setDataset(volumeDataset());
    posts.length = 0;
    sync.dispose();
    store.getState().setOverlayPlane("xy", true);
    expect(posts).toHaveLength(0);
  });

  it("setTheme re-posts the overlay with the new palette while ready", () => {
    const { store, posts, sync } = harness(true);
    store.getState().setDataset(volumeDataset());
    posts.length = 0;
    sync.setTheme(parseTheme('name = "t"\n[colors]\ngrid = [1.0, 0.0, 0.0, 0.5]', "t"));

    const msg = posts.at(-1)?.message;
    if (msg?.kind !== "setSceneOverlay" || msg.overlay === null) {
      throw new Error("expected a setSceneOverlay");
    }
    expect(msg.overlay.grid.color).toEqual([1, 0, 0, 0.5]);
  });

  it("setTheme before ready is silent; the palette rides the later flushAll", () => {
    const { posts, sync, setReady } = harness(false);
    sync.setTheme(parseTheme('name = "t"\n[colors]\ngrid = [0.0, 1.0, 0.0, 0.5]', "t"));
    expect(posts).toHaveLength(0);
    setReady(true);
    sync.flushAll();
    const msg = posts.at(-1)?.message;
    if (msg?.kind !== "setSceneOverlay" || msg.overlay === null) {
      throw new Error("expected a setSceneOverlay");
    }
    expect(msg.overlay.grid.color).toEqual([0, 1, 0, 0.5]);
  });
});

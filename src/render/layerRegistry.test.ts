import type { StreamStepMessage } from "@data";
import { describe, expect, it, vi } from "vitest";
import type { RenderWorkerRequest } from "./messages.ts";

// Mock the GPU scene factories — the registry's logic (draw order, overrides, pick filtering, the
// in-place-vs-rebuild decision, epoch superseding) is what we isolate; the real raymarch/slice scenes
// need a device and are exercised by the worker.*.test.ts integration suites. Each fake records its
// build params + method calls and exposes `setField`'s return so a test can force the rebuild fallback.
const { created } = vi.hoisted(() => ({ created: [] as FakeScene[] }));

interface FakeScene {
  readonly kind: "slice" | "volume";
  readonly scene: object;
  readonly field: { shape: readonly number[] };
  disposed: boolean;
  opacity: number;
  setFieldResult: boolean;
  fieldSwaps: number;
  stepScale?: number;
  orthographic?: boolean;
}

function makeFake(
  kind: "slice" | "volume",
  opts: { opacity: number; field: { shape: readonly number[] } },
) {
  const fake: FakeScene = {
    kind,
    scene: { tag: kind },
    field: opts.field,
    disposed: false,
    opacity: opts.opacity,
    setFieldResult: true,
    fieldSwaps: 0,
  };
  const base = {
    get scene() {
      return fake.scene;
    },
    dispose: () => {
      fake.disposed = true;
    },
    setField: () => {
      fake.fieldSwaps += 1;
      return fake.setFieldResult;
    },
    setOpacity: (o: number) => {
      fake.opacity = o;
    },
    setColormap: () => {},
    setWindowLevel: () => {},
    setScale: () => {},
  };
  const scene =
    kind === "volume"
      ? Object.assign(base, {
          setStepScale: (s: number) => {
            fake.stepScale = s;
          },
          setProjection: (o: boolean) => {
            fake.orthographic = o;
          },
          setShading: () => {},
        })
      : base;
  created.push(fake);
  return scene;
}

vi.mock("./volume/sliceScene.ts", () => ({
  createSliceScene: (opts: { opacity: number; field: { shape: readonly number[] } }) =>
    makeFake("slice", opts),
}));
vi.mock("./volume/raymarchScene.ts", () => ({
  createRaymarchScene: (opts: { opacity: number; field: { shape: readonly number[] } }) =>
    makeFake("volume", opts),
}));

const { createLayerRegistry } = await import("./layerRegistry.ts");

function harness() {
  created.length = 0;
  const warms: Array<{ id: string }> = [];
  let warm: Promise<void> = Promise.resolve();
  const registry = createLayerRegistry({
    float32Filterable: () => false,
    stepScale: () => 1,
    isOrthographic: () => false,
    requestRender: () => {},
    reportFault: () => {},
    warmComposite: (override) => {
      warms.push({ id: override.id });
      return warm;
    },
  });
  return {
    registry,
    created,
    warms,
    setWarm: (p: Promise<void>) => {
      warm = p;
    },
  };
}

const field = (shape: readonly number[]) => ({
  buffer: new Float32Array(shape.reduce((a, b) => a * b, 1)).buffer,
  dtype: "f32" as const,
  shape,
});

function upsert(
  id: string,
  layerKind: "slice" | "volume",
  shape: readonly number[] = [2, 2, 2],
): Extract<RenderWorkerRequest, { kind: "upsertLayer" }> {
  return {
    kind: "upsertLayer",
    requestId: 1,
    id,
    layerKind,
    field: field(shape),
    colormap: "viridis",
    scale: "linear",
    opacity: 1,
    windowLevel: { center: 0, width: 1 },
  };
}

const VOLUME = {} as unknown as import("three").Camera;
const ORTHO = {} as unknown as import("three").Camera;

describe("createLayerRegistry", () => {
  it("composites visible layers in draw order, pairing each kind with its camera", async () => {
    const { registry } = harness();
    await registry.upsert(upsert("a", "volume"));
    await registry.upsert(upsert("b", "slice"));
    registry.setComposite([
      { id: "a", visible: true, opacity: 1 },
      { id: "b", visible: true, opacity: 1 },
    ]);
    const items = registry.layerItems(VOLUME, ORTHO);
    expect(items.map((i) => i.camera)).toEqual([VOLUME, ORTHO]); // volume→volume cam, slice→ortho cam

    registry.setComposite([
      { id: "a", visible: false, opacity: 1 },
      { id: "b", visible: true, opacity: 1 },
    ]);
    expect(registry.layerItems(VOLUME, ORTHO)).toHaveLength(1); // a hidden
  });

  it("appends a not-yet-committed override layer the composite doesn't list yet", async () => {
    const { registry, created } = harness();
    await registry.upsert(upsert("a", "volume"));
    registry.setComposite([{ id: "a", visible: true, opacity: 1 }]);
    const overrideEntry = { scene: created[0], kind: "volume" as const, source: {} } as never;
    const items = registry.layerItems(VOLUME, ORTHO, { id: "z", entry: overrideEntry });
    expect(items).toHaveLength(2); // committed a + appended override z
  });

  it("swaps a streamed field in place when the scene accepts it, else rebuilds", async () => {
    const { registry, created } = harness();
    await registry.upsert(upsert("a", "volume"));
    const scene = created[0];
    if (scene === undefined) throw new Error("expected a built scene");
    const step = (): StreamStepMessage => ({
      kind: "streamStep",
      id: "a",
      step: 1,
      field: field([2, 2, 2]),
    });

    scene.setFieldResult = true;
    registry.swapField(step());
    expect(scene.fieldSwaps).toBe(1);
    expect(created).toHaveLength(1); // in-place — no new scene built

    scene.setFieldResult = false; // scene declines (shape change / stale accel grid) → full rebuild
    registry.swapField(step());
    await Promise.resolve();
    expect(created.length).toBeGreaterThan(1); // a fresh scene was built
  });

  it("pickLayers returns only the visible volume layers", async () => {
    const { registry } = harness();
    await registry.upsert(upsert("vol", "volume"));
    await registry.upsert(upsert("sl", "slice"));
    registry.setComposite([
      { id: "vol", visible: true, opacity: 0.5 },
      { id: "sl", visible: true, opacity: 1 },
    ]);
    const { layers } = registry.pickLayers();
    expect(layers).toHaveLength(1); // slice excluded
    expect(layers[0]?.opacity).toBe(0.5);
  });

  it("applyStepScale / applyProjection reach volume scenes only", async () => {
    const { registry, created } = harness();
    await registry.upsert(upsert("vol", "volume"));
    await registry.upsert(upsert("sl", "slice"));
    registry.applyStepScale(0.5);
    registry.applyProjection(true);
    const volume = created.find((s) => s.kind === "volume");
    expect(volume?.stepScale).toBe(0.5);
    expect(volume?.orthographic).toBe(true);
  });

  it("discards a scene superseded mid-warm (a remove during the upsert's warm)", async () => {
    const { registry, created, setWarm } = harness();
    let release = () => {};
    setWarm(new Promise<void>((resolve) => (release = resolve)));
    const pending = registry.upsert(upsert("a", "volume"));
    registry.remove("a"); // bumps the epoch while the warm is in flight
    release();
    await pending;
    expect(created[0]?.disposed).toBe(true); // the warmed scene lost the race and was disposed
    expect(registry.layerItems(VOLUME, ORTHO)).toHaveLength(0);
  });
});

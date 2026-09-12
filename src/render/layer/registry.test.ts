import type { StreamStepMessage } from "@data";
import { describe, expect, it, vi } from "vitest";
import type { RenderWorkerRequest } from "../messages.ts";

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
  isOrthographic?: boolean;
  position?: number;
  shaderRebuilds: number;
  scale?: string;
  colormap?: string;
}

function makeFake(
  kind: "slice" | "volume",
  options: { opacity: number; field: { shape: readonly number[] } },
) {
  const fake: FakeScene = {
    kind,
    scene: { tag: kind },
    field: options.field,
    disposed: false,
    opacity: options.opacity,
    setFieldResult: true,
    fieldSwaps: 0,
    shaderRebuilds: 0,
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
    setColormap: (c: string) => {
      fake.colormap = c;
    },
    setWindowLevel: () => {},
    setScale: (sc: string) => {
      fake.scale = sc;
    },
  };
  const scene =
    kind === "volume"
      ? Object.assign(base, {
          setStepScale: (s: number) => {
            fake.stepScale = s;
          },
          setProjection: (o: boolean) => {
            fake.isOrthographic = o;
          },
          setShading: () => {},
          rebuildShader: () => {
            fake.shaderRebuilds += 1;
          },
        })
      : Object.assign(base, {
          setPosition: (p: number) => {
            fake.position = p;
          },
        });
  created.push(fake);
  return scene;
}

vi.mock("../field/sliceScene.ts", () => ({
  createSliceScene: (options: { opacity: number; field: { shape: readonly number[] } }) =>
    makeFake("slice", options),
}));
vi.mock("../field/raymarchScene.ts", () => ({
  createRaymarchScene: (options: { opacity: number; field: { shape: readonly number[] } }) =>
    makeFake("volume", options),
}));

const { createLayerRegistry } = await import("./registry.ts");

function harness() {
  created.length = 0;
  const warms: Array<{ id: string }> = [];
  let warm: Promise<void> = Promise.resolve();
  const registry = createLayerRegistry({
    hasFloat32Filterable: () => false,
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
    params: layerKind === "slice" ? { layerKind, axis: "z", position: 0.5 } : { layerKind },
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
    registry.setLayerOrder([
      { id: "a", visible: true, opacity: 1 },
      { id: "b", visible: true, opacity: 1 },
    ]);
    const items = registry.layerItems(VOLUME, ORTHO);
    expect(items.map((i) => i.camera)).toEqual([VOLUME, ORTHO]); // volume→volume cam, slice→ortho cam

    registry.setLayerOrder([
      { id: "a", visible: false, opacity: 1 },
      { id: "b", visible: true, opacity: 1 },
    ]);
    expect(registry.layerItems(VOLUME, ORTHO)).toHaveLength(1); // a hidden
  });

  it("appends a not-yet-committed override layer the composite doesn't list yet", async () => {
    const { registry, created } = harness();
    await registry.upsert(upsert("a", "volume"));
    registry.setLayerOrder([{ id: "a", visible: true, opacity: 1 }]);
    const overrideEntry = { scene: created[0], kind: "volume" as const, source: {} } as never;
    const items = registry.layerItems(VOLUME, ORTHO, { id: "z", entry: overrideEntry });
    expect(items).toHaveLength(2); // committed a + appended override z
  });

  it("lands a colormap edit on the scene warming in the background, not just the one it replaces", async () => {
    // A dataset switch does exactly this: the new dataset's default color scale posts while the new
    // layer is still compiling. Before, the edit reached only the outgoing scene and the incoming one
    // committed with the stale look — the dipole rendered linear despite a log binding.
    const { registry, created, setWarm } = harness();
    await registry.upsert(upsert("a", "volume"));
    let release: () => void = () => {};
    setWarm(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const rebuilding = registry.upsert(upsert("a", "volume", [4, 4, 4])); // new shape ⇒ rebuild
    registry.setColormap({
      kind: "setLayerColormap",
      requestId: 2,
      id: "a",
      colormap: "inferno",
      windowLevel: { center: 5, width: 10 },
      scale: "log",
    });
    release();
    await rebuilding;
    expect(created).toHaveLength(2);
    expect(created[1]?.scale).toBe("log"); // the committed scene carries the edit
    expect(created[1]?.colormap).toBe("inferno");
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

  it("setSliceParams writes position in place (uniform) but rebuilds on an axis change", async () => {
    const { registry, created } = harness();
    await registry.upsert(upsert("sl", "slice"));
    const scene = created[0];
    if (scene === undefined) throw new Error("expected a built slice");

    // position → a uniform write on the existing scene, no rebuild.
    registry.setSliceParams({ kind: "setSliceParams", requestId: 1, id: "sl", position: 0.8 });
    expect(scene.position).toBe(0.8);
    expect(created).toHaveLength(1);

    // axis → a rebuild from the retained field (a fresh scene is built).
    registry.setSliceParams({ kind: "setSliceParams", requestId: 1, id: "sl", axis: "x" });
    await Promise.resolve();
    expect(created.length).toBeGreaterThan(1);
  });

  it("setSliceParams is inert for a non-slice (volume) layer", async () => {
    const { registry, created } = harness();
    await registry.upsert(upsert("vol", "volume"));
    registry.setSliceParams({ kind: "setSliceParams", requestId: 1, id: "vol", position: 0.3 });
    expect(created).toHaveLength(1); // no rebuild, no throw
    expect(created[0]?.position).toBeUndefined(); // never touched the volume scene
  });

  it("pickLayers returns only the visible volume layers", async () => {
    const { registry } = harness();
    await registry.upsert(upsert("vol", "volume"));
    await registry.upsert(upsert("sl", "slice"));
    registry.setLayerOrder([
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
    expect(volume?.isOrthographic).toBe(true);
  });

  it("rebuildShaders swaps volume materials only (dev shader HMR), skipping slices", async () => {
    const { registry, created } = harness();
    await registry.upsert(upsert("vol", "volume"));
    await registry.upsert(upsert("sl", "slice")); // no rebuildShader — must be skipped, not throw
    const build = () => ({}) as unknown as import("three/webgpu").NodeMaterial;
    registry.rebuildShaders(build);
    const volume = created.find((s) => s.kind === "volume");
    const slice = created.find((s) => s.kind === "slice");
    expect(volume?.shaderRebuilds).toBe(1);
    expect(slice?.shaderRebuilds).toBe(0); // narrowing left the slice untouched
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

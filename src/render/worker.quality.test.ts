// Interaction-quality wiring through the REAL display loop: a manually pumped rAF stub (installed
// before the worker module loads) keeps `rafId` defined, so the settle ramp takes the production
// path — one painted frame per level — instead of the Node collapse that worker.streaming.test.ts
// asserts. Same mock seam as worker.recovery.test.ts (three/webgpu can't load in node).

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { INTERACTION_RENDER_SCALE, INTERACTION_STEP_SCALE } from "./constants.ts";
import type { RenderWorkerRequest } from "./messages.ts";

const h = vi.hoisted(() => {
  const makeScene = () => ({
    scene: {},
    setWindowLevel: vi.fn(),
    setColormap: vi.fn(),
    setScale: vi.fn(),
    setShading: vi.fn(),
    setOpacity: vi.fn(),
    setStepScale: vi.fn(),
    setProjection: vi.fn(),
    setField: vi.fn(() => true),
    dispose: vi.fn(),
  });
  return {
    makeScene,
    installRenderer: vi.fn(async () => ({
      renderer: {},
      renderComposite: vi.fn(),
      compileComposite: vi.fn(async () => {}),
      readCompositePixels: vi.fn(),
      setSize: vi.fn(),
      setRenderScale: vi.fn(),
      dispose: vi.fn(),
    })),
    createRaymarchScene: vi.fn((_opts: unknown) => makeScene()),
    createSliceScene: vi.fn((_opts: unknown) => makeScene()),
    createTestScene: vi.fn(() => ({ scene: {}, dispose: vi.fn() })),
  };
});

vi.mock("@gpu", () => ({
  installGpu: vi.fn(async () => ({ dispose: vi.fn() })),
  getDevice: vi.fn(() => ({ queue: { onSubmittedWorkDone: async () => undefined } })),
  getCapabilities: vi.fn(() => ({ hasTimestampQuery: false, hasFloat32Filterable: false })),
  onDeviceLost: () => () => {},
  onDeviceRestored: () => () => {},
}));
vi.mock("./renderer.ts", () => ({ installRenderer: h.installRenderer }));
vi.mock("./raymarchScene.ts", () => ({ createRaymarchScene: h.createRaymarchScene }));
vi.mock("./sliceScene.ts", () => ({ createSliceScene: h.createSliceScene }));
vi.mock("./scene.ts", () => ({ createTestScene: h.createTestScene }));

let onmessage: (event: { data: RenderWorkerRequest }) => void;
const rafCallbacks: FrameRequestCallback[] = [];

// Run one display frame: drain the queue once (renderTick re-schedules itself first thing).
function tickFrame(): void {
  const due = rafCallbacks.splice(0);
  for (const cb of due) cb(performance.now());
}

beforeAll(async () => {
  let nextRafId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return nextRafId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (_id: number): void => {});
  (globalThis as unknown as { self: unknown }).self = { postMessage: vi.fn() };
  await import("./worker.ts");
  onmessage = (globalThis as unknown as { self: { onmessage: typeof onmessage } }).self.onmessage;
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { self?: unknown }).self;
});

it("a gesture end ramps quality back over painted frames, not in one pop", async () => {
  onmessage({
    data: {
      kind: "init",
      requestId: 1,
      canvas: {} as unknown as OffscreenCanvas,
      width: 64,
      height: 64,
      devicePixelRatio: 1,
    },
  });
  await vi.waitFor(() => expect(h.installRenderer).toHaveBeenCalledTimes(1));
  const renderer = (await h.installRenderer.mock.results[0]?.value) as {
    renderComposite: ReturnType<typeof vi.fn>;
    setRenderScale: ReturnType<typeof vi.fn>;
  };
  onmessage({
    data: {
      kind: "upsertLayer",
      requestId: 2,
      id: "layer-0",
      layerKind: "volume",
      field: { buffer: new Float32Array([5]).buffer, dtype: "f32", shape: [1, 1, 1] },
      colormap: "inferno",
      scale: "linear",
      opacity: 1,
    },
  });
  await vi.waitFor(() => expect(h.createRaymarchScene).toHaveBeenCalledTimes(1));
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    setStepScale: ReturnType<typeof vi.fn>;
  };
  onmessage({
    data: {
      kind: "setComposite",
      requestId: 3,
      order: [{ id: "layer-0", visible: true, opacity: 1 }],
    },
  });

  scene.setStepScale.mockClear();
  renderer.setRenderScale.mockClear();

  onmessage({ data: { kind: "setCameraMotion", requestId: 4, motion: "gesture" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE));
  expect(renderer.setRenderScale).toHaveBeenCalledWith(INTERACTION_RENDER_SCALE);

  // Idle edge with a live loop: the FIRST level is the settle step (render restores, march at
  // 0.7), not full — the Node collapse must not fire here.
  onmessage({ data: { kind: "setCameraMotion", requestId: 5, motion: "idle" } });
  await vi.waitFor(() => expect(renderer.setRenderScale).toHaveBeenCalledWith(1));
  expect(scene.setStepScale).toHaveBeenCalledWith(0.7);
  expect(scene.setStepScale).not.toHaveBeenCalledWith(1);

  // Each painted frame advances the ramp exactly one level; the second frame lands at full.
  tickFrame();
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(1));
  const paintsAtFull = renderer.renderComposite.mock.calls.length;
  tickFrame(); // paints the full-quality frame
  tickFrame(); // quality stable → dirty flag stays clear, no further paints
  expect(renderer.renderComposite.mock.calls.length).toBe(paintsAtFull + 1);

  // The exact restore sequence: 0.4 (gesture) → 0.7 (settle frame) → 1 (full).
  expect(scene.setStepScale.mock.calls.map((c) => c[0])).toEqual([INTERACTION_STEP_SCALE, 0.7, 1]);
});

it("a new gesture mid-ramp re-enters interaction quality", async () => {
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    setStepScale: ReturnType<typeof vi.fn>;
  };
  onmessage({ data: { kind: "setCameraMotion", requestId: 6, motion: "gesture" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE));
  onmessage({ data: { kind: "setCameraMotion", requestId: 7, motion: "idle" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(0.7));
  scene.setStepScale.mockClear();
  // Mid-settle, the user grabs the camera again: straight back to gesture quality.
  onmessage({ data: { kind: "setCameraMotion", requestId: 8, motion: "gesture" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE));
});

it("a fly runs the animating tier: coarser march at full resolution, settling to full on idle", async () => {
  const renderer = (await h.installRenderer.mock.results[0]?.value) as {
    setRenderScale: ReturnType<typeof vi.fn>;
  };
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    setStepScale: ReturnType<typeof vi.fn>;
  };
  // The previous test ends mid-gesture: release and land the ramp so this starts from full.
  onmessage({ data: { kind: "setCameraMotion", requestId: 11, motion: "idle" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(0.7));
  tickFrame();
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(1));
  scene.setStepScale.mockClear();
  renderer.setRenderScale.mockClear();

  onmessage({ data: { kind: "setCameraMotion", requestId: 9, motion: "fly" } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(0.7));
  // The whole point of the tier: the flight renders at full resolution — no realloc, no blur.
  expect(renderer.setRenderScale).not.toHaveBeenCalled();

  // Fly end: animating equals the settle ramp's first level, so nothing visibly changes until the
  // painted frame advances the ramp to full — a single subtle step-density flip after landing.
  scene.setStepScale.mockClear();
  onmessage({ data: { kind: "setCameraMotion", requestId: 10, motion: "idle" } });
  await vi.waitFor(() => {
    // The handler's await initDone makes the transition async; poll until the ramp is armed.
    tickFrame();
    expect(scene.setStepScale).toHaveBeenCalledWith(1);
  });
  expect(renderer.setRenderScale).not.toHaveBeenCalled(); // stayed at 1 throughout
});

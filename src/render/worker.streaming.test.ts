// Render-side streaming (M2.10a/b): the data worker pairs a MessagePort into the render worker and
// posts streamStep messages over it; the worker routes them through swapLayerField — an in-place
// ping-pong upload onto the existing scene (scene.setField), keeping its retained look and avoiding a
// pipeline rebuild. When setField declines (shape change / skip-grid volume) it falls back to a full
// rebuild. three/webgpu can't load in node, so the renderer + scene factories + the gpu seam are
// mocked (same pattern as worker.recovery.test.ts). Flow: init → upsert layer-0 → pair → streamStep.

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { INTERACTION_STEP_SCALE } from "./constants.ts";
import type { RenderWorkerRequest } from "./messages.ts";

const h = vi.hoisted(() => {
  // setField returns true by default (in-place swap accepted); a test overrides it to force the
  // rebuild fallback. The mock is per-scene so each created scene carries its own spy.
  const makeScene = () => ({
    scene: {},
    setWindowLevel: vi.fn(),
    setColormap: vi.fn(),
    setScale: vi.fn(),
    setShading: vi.fn(),
    setOpacity: vi.fn(),
    setStepScale: vi.fn(),
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

beforeAll(async () => {
  (globalThis as unknown as { self: unknown }).self = { postMessage: vi.fn() };
  await import("./worker.ts");
  onmessage = (globalThis as unknown as { self: { onmessage: typeof onmessage } }).self.onmessage;
});

afterAll(() => {
  delete (globalThis as unknown as { self?: unknown }).self;
});

it("applies a streamStep in place via scene.setField (no scene rebuild)", async () => {
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

  // The data worker's initial upsert creates the volume layer (scene #1, field shape [1,1,1]).
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
    setField: ReturnType<typeof vi.fn>;
  };

  // Pair the streaming port, then stream a new step's scalar over it (distinct shape [2,2,2]).
  const channel = new MessageChannel();
  onmessage({ data: { kind: "pair", requestId: 3, port: channel.port2 } });
  const buffer = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  channel.port1.postMessage(
    {
      kind: "streamStep",
      id: "layer-0",
      step: 3,
      field: { buffer, dtype: "f32", shape: [2, 2, 2] },
    },
    [buffer],
  );

  // The streamed field is uploaded in place (scene.setField) — the scene is NOT rebuilt.
  await vi.waitFor(() => expect(scene.setField).toHaveBeenCalledTimes(1));
  expect(scene.setField.mock.calls[0]?.[0]).toMatchObject({ shape: [2, 2, 2] });
  expect(h.createRaymarchScene).toHaveBeenCalledTimes(1); // ping-pong, not a rebuild
  channel.port1.close();
});

it("falls back to a scene rebuild when setField declines the in-place swap", async () => {
  // A second layer so layer-0 is untouched; force its scene to decline the in-place swap.
  const before = h.createRaymarchScene.mock.calls.length;
  onmessage({
    data: {
      kind: "upsertLayer",
      requestId: 5,
      id: "layer-1",
      layerKind: "volume",
      field: { buffer: new Float32Array([7]).buffer, dtype: "f32", shape: [1, 1, 1] },
      colormap: "viridis",
      scale: "linear",
      opacity: 1,
    },
  });
  await vi.waitFor(() => expect(h.createRaymarchScene).toHaveBeenCalledTimes(before + 1));
  const scene = h.createRaymarchScene.mock.results[before]?.value as {
    setField: ReturnType<typeof vi.fn>;
  };
  scene.setField.mockReturnValue(false); // e.g. shape change / skip-grid volume

  const channel = new MessageChannel();
  onmessage({ data: { kind: "pair", requestId: 6, port: channel.port2 } });
  const buffer = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  channel.port1.postMessage(
    {
      kind: "streamStep",
      id: "layer-1",
      step: 2,
      field: { buffer, dtype: "f32", shape: [2, 2, 2] },
    },
    [buffer],
  );

  // Declined → rebuild (one more scene) carrying the new field + the retained look.
  await vi.waitFor(() => expect(h.createRaymarchScene).toHaveBeenCalledTimes(before + 2));
  expect(scene.setField).toHaveBeenCalledTimes(1); // consulted first
  expect(h.createRaymarchScene.mock.calls.at(-1)?.[0]).toMatchObject({
    colormap: "viridis",
    field: { shape: [2, 2, 2] },
  });
  channel.port1.close();
});

it("setInteracting retunes every volume's march scale, full quality on release", async () => {
  const scene = h.createRaymarchScene.mock.results.at(-1)?.value as {
    setStepScale: ReturnType<typeof vi.fn>;
  };
  scene.setStepScale.mockClear();
  onmessage({ data: { kind: "setInteracting", requestId: 9, interacting: true } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(INTERACTION_STEP_SCALE));
  onmessage({ data: { kind: "setInteracting", requestId: 10, interacting: false } });
  await vi.waitFor(() => expect(scene.setStepScale).toHaveBeenCalledWith(1));
});

it("ignores a streamStep for an unknown layer (heals on the next upsert)", async () => {
  const before = h.createRaymarchScene.mock.calls.length;
  const channel = new MessageChannel();
  onmessage({ data: { kind: "pair", requestId: 4, port: channel.port2 } });
  const buffer = new Float32Array([9]).buffer;
  channel.port1.postMessage(
    {
      kind: "streamStep",
      id: "missing",
      step: 1,
      field: { buffer, dtype: "f32", shape: [1, 1, 1] },
    },
    [buffer],
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(h.createRaymarchScene).toHaveBeenCalledTimes(before); // no rebuild for a missing layer
  channel.port1.close();
});
